import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const packageRoot = path.join(import.meta.dir, "../..");

describe("browser-backed search fallback", () => {
	it("closes a Camoufox browser that finishes launching after abort", async () => {
		const script = [
			'import { mock } from "bun:test";',
			"const launchStarted = Promise.withResolvers();",
			"const launchGate = Promise.withResolvers();",
			"const launchReturned = Promise.withResolvers();",
			"let closeCalls = 0;",
			"const fakeBrowser = { close: async () => { closeCalls++; } };",
			'const launchModule = import.meta.resolve("@oh-my-pi/pi-coding-agent/tools/browser/launch");',
			"mock.module(launchModule, () => ({",
			"  loadPuppeteer: async () => ({}),",
			"  launchCamoufoxBrowser: async () => {",
			"    launchStarted.resolve();",
			"    const browser = await launchGate.promise;",
			"    launchReturned.resolve();",
			"    return browser;",
			"  },",
			'  adoptInitialPage: async () => { throw new Error("must not adopt after abort"); },',
			"}));",
			"globalThis.fetch = async () => new Response('blocked', { status: 403 });",
			'const { browserFetch } = await import("@oh-my-pi/pi-coding-agent/web/search/providers/browser-page");',
			"const controller = new AbortController();",
			'const pending = browserFetch("https://example.invalid", {',
			"  signal: controller.signal,",
			"  browser: { shouldFallback: () => true },",
			"});",
			"await launchStarted.promise;",
			"controller.abort();",
			"let rejected = false;",
			"try { await pending; } catch { rejected = true; }",
			"launchGate.resolve(fakeBrowser);",
			"await launchReturned.promise;",
			"await Promise.resolve();",
			"await Promise.resolve();",
			"process.stdout.write(JSON.stringify({ rejected, closeCalls }));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ rejected: true, closeCalls: 1 });
	});
});
