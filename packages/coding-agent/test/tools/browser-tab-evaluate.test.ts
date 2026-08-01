import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { ensureCamoufoxEngine } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
}

/**
 * Whether the Camoufox engine can actually execute on this host. CI runners
 * without the engine's system libraries hold the downloaded binary but cannot
 * exec it — probe with --version and skip instead of failing.
 */
async function camoufoxCanLaunch(): Promise<boolean> {
	try {
		const installDir = await ensureCamoufoxEngine();
		const executable = join(installDir, process.platform === "win32" ? "camoufox.exe" : "camoufox");
		const probe = Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" });
		return probe.exitCode === 0;
	} catch {
		return false;
	}
}

const CAMOUFOX_AVAILABLE = await camoufoxCanLaunch();

describe.skipIf(!CAMOUFOX_AVAILABLE)("browser tab evaluation", () => {
	// Launches a real Camoufox engine; CI cold start easily exceeds bun's 5s default.
	it("runs tab.evaluate in the page's main JavaScript world", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `main-world-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: "data:text/html,<script>globalThis.__ompMainWorld = 42</script>",
			});
			const result = await tool.execute("run", {
				action: "run",
				name,
				code: "return await tab.evaluate(() => globalThis.__ompMainWorld);",
			});

			expect(result.content).toEqual([{ type: "text", text: "42" }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);

	it("clears request interception and held requests between runs, including thrown runs", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname === "/held") return new Response("normal-held");
				if (pathname === "/mock") return new Response("normal-mock");
				return new Response("<title>Interception lifecycle</title>", {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const tool = new BrowserTool(makeSession());
		const name = `interception-lifecycle-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: `http://127.0.0.1:${server.port}/`,
			});
			let setupError: unknown;
			try {
				await tool.execute("run", {
					action: "run",
					name,
					code: `
						globalThis.__requestListenerBaseline = page.listenerCount("request");
						await page.setRequestInterception(true);
						page.on("request", request => void request.abort());
						throw new Error("setup failed");
					`,
				});
			} catch (error) {
				setupError = error;
			}
			expect(setupError).toBeInstanceOf(Error);
			expect(setupError).toHaveProperty("message", "setup failed");

			// NOTE: request.respond (BiDi provideResponse) is not supported on
			// Camoufox — interception covers abort/continue only.
			const afterThrow = await tool.execute("run", {
				action: "run",
				name,
				code: `
					return {
						clean: page.listenerCount("request") === globalThis.__requestListenerBaseline,
						body: await tab.evaluate(async () => await (await fetch("/mock")).text()),
					};
				`,
			});
			expect(afterThrow.content).toEqual([
				{ type: "text", text: '{\n  "clean": true,\n  "body": "normal-mock"\n}' },
			]);

			const intercepted = await tool.execute("run", {
				action: "run",
				name,
				code: `
					let heldSeen = false;
					await page.setRequestInterception(true);
					page.on("request", request => {
						const pathname = new URL(request.url()).pathname;
						if (pathname === "/held") {
							heldSeen = true;
							return;
						}
						void request.continue();
					});
					await tab.evaluate(() => {
						globalThis.__heldFetch = fetch("/held").then(async response => await response.text());
					});
					await wait(() => heldSeen);
					return await tab.evaluate(async () => await (await fetch("/mock")).text());
				`,
			});
			expect(intercepted.content).toEqual([{ type: "text", text: "normal-mock" }]);

			const resumed = await tool.execute("run", {
				action: "run",
				name,
				code: `
					const listeners = page.listenerCount("request");
					if (listeners !== globalThis.__requestListenerBaseline) {
						return { clean: false, listeners, baseline: globalThis.__requestListenerBaseline };
					}
					return {
						clean: true,
						values: await tab.evaluate(async () => [
							await globalThis.__heldFetch,
							await (await fetch("/mock")).text(),
						]),
					};
				`,
			});
			expect(resumed.content).toEqual([
				{
					type: "text",
					text: '{\n  "clean": true,\n  "values": [\n    "normal-held",\n    "normal-mock"\n  ]\n}',
				},
			]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
			server.stop(true);
		}
	}, 30_000);

	it("fires a once request handler exactly once and clears it between runs", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname === "/mock") return new Response("normal-mock");
				return new Response("<title>Once interception</title>", {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const tool = new BrowserTool(makeSession());
		const name = `once-interception-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: `http://127.0.0.1:${server.port}/`,
			});
			const fired = await tool.execute("run", {
				action: "run",
				name,
				code: `
					const baseline = page.listenerCount("request");
					globalThis.__requestListenerBaseline = baseline;
					await page.setRequestInterception(true);
					let fired = 0;
					page.once("request", request => {
						fired++;
						void request.abort();
					});
					const aborted = await tab.evaluate(async () => {
						try {
							await fetch("/mock");
							return "not-aborted";
						} catch {
							return "aborted";
						}
					});
					// A once handler that fired must unregister from the emitter, not just the tracker.
					return { aborted, fired, leaked: page.listenerCount("request") - baseline };
				`,
			});
			expect(fired.content).toEqual([
				{ type: "text", text: '{\n  "aborted": "aborted",\n  "fired": 1,\n  "leaked": 0\n}' },
			]);

			const resumed = await tool.execute("run", {
				action: "run",
				name,
				code: `
					return {
						clean: page.listenerCount("request") === globalThis.__requestListenerBaseline,
						body: await tab.evaluate(async () => await (await fetch("/mock")).text()),
					};
				`,
			});
			expect(resumed.content).toEqual([{ type: "text", text: '{\n  "clean": true,\n  "body": "normal-mock"\n}' }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
			server.stop(true);
		}
	}, 30_000);
});

// NOTE: the old "observes floating raw page promises when the target closes"
// test was dropped in the Camoufox port: headless browsers are owned by their
// tab worker (WebDriver BiDi), so the host can no longer close a tab's page
// out from under a run — the scenario the test exercised is unrepresentable
// by design now.
