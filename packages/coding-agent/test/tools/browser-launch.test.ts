import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const packageRoot = path.join(import.meta.dir, "../..");

describe("Camoufox engine installation", () => {
	it("repairs a partial first-use cache and waits for installation", async () => {
		const script = [
			'import { mock } from "bun:test";',
			'let cacheState = "partial";',
			"let installCalls = 0;",
			"class CamoufoxFetcher {",
			"  async install() {",
			"    installCalls++;",
			"    await Bun.sleep(10);",
			'    cacheState = "complete";',
			"  }",
			"}",
			'mock.module("camoufox-js/dist/pkgman.js", () => ({',
			"  CamoufoxFetcher,",
			"  camoufoxPath() {",
			'    if (cacheState === "partial") {',
			'      throw new Error("Version information not found at /mock/camoufox/version.json");',
			"    }",
			'    return "/mock/camoufox";',
			"  },",
			"}));",
			'const { ensureCamoufoxEngine } = await import("@oh-my-soup/pi-coding-agent/tools/browser/launch");',
			"const enginePath = await ensureCamoufoxEngine();",
			"process.stdout.write(JSON.stringify({ enginePath, cacheState, installCalls }));",
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
		expect(JSON.parse(stdout)).toEqual({
			enginePath: "/mock/camoufox",
			cacheState: "complete",
			installCalls: 1,
		});
	});
});
