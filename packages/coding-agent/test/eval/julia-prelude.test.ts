import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which, TempDir } from "@oh-my-soup/pi-utils";
import { disposeJuliaKernelSessionsByOwner, executeJulia } from "../../src/eval/jl/executor";
import { runBoundedProbe } from "../../src/eval/probe";

const JULIA_PATH = $which("julia");
const HAS_JULIA = Boolean(JULIA_PATH);
const OWNER_ID = "julia-prelude-tests";

// The production availability probe hard-caps `julia -e "exit(0)"` at
// DEFAULT_PROBE_TIMEOUT_MS so a wedged interpreter cannot stall an agent turn
// (issue #9466), but the gate above only checks `$which` — not startup
// latency. On a cold CI runner under full-suite contention Julia's first
// startup can legitimately exceed that cap, failing the suite with "probe
// timed out" before any prelude behavior runs. Pay the cold start once here
// under a test-infrastructure budget; every executeJulia below then runs the
// production probe warm, with its production timeout intact.
const PREWARM_TIMEOUT_MS = 120_000;

async function prewarmJulia(juliaPath: string): Promise<void> {
	// runBoundedProbe supplies the stdio detachment and process-tree kill this
	// lifecycle needs — juliaPath can be a shim (juliaup) whose real
	// interpreter must not outlive the hook; the ceiling override is what
	// admits the longer test-infrastructure budget.
	const probe = await runBoundedProbe([juliaPath, "-e", "exit(0)"], {
		cwd: process.cwd(),
		env: process.env,
		timeoutMs: PREWARM_TIMEOUT_MS,
		timeoutCeilingMs: PREWARM_TIMEOUT_MS,
	});
	if (probe.timedOut) {
		throw new Error(
			`Julia prewarm (${juliaPath} -e 'exit(0)') timed out after ${PREWARM_TIMEOUT_MS}ms; the runner cannot start Julia at all`,
		);
	}
	if (probe.exitCode !== 0) {
		throw new Error(`Julia prewarm (${juliaPath} -e 'exit(0)') exited ${probe.exitCode}`);
	}
}

describe.skipIf(!HAS_JULIA)("eval Julia prelude helpers", () => {
	beforeAll(async () => {
		if (!JULIA_PATH) return;
		await prewarmJulia(JULIA_PATH);
	}, PREWARM_TIMEOUT_MS + 10_000);

	afterEach(async () => {
		await disposeJuliaKernelSessionsByOwner(OWNER_ID);
	}, 30_000);

	it("supports output ranges, JSON queries, metadata, and ANSI stripping", async () => {
		using tempDir = TempDir.createSync("@oms-eval-julia-output-");
		const artifactsDir = path.join(tempDir.path(), "session-artifacts");
		await Bun.write(path.join(artifactsDir, "alpha.md"), "one\ntwo\nthree\nfour");
		await Bun.write(path.join(artifactsDir, "json.md"), JSON.stringify({ items: [{ name: "a" }, { name: "b" }] }));
		await Bun.write(path.join(artifactsDir, "ansi.md"), "\u001b[31mred\u001b[0m");

		const result = await executeJulia(
			`
println("RANGE=", replace(output("alpha", offset=2, limit=2), "\\n" => "|"))
println("QUERY=", output("json", query=".items[1].name"))
println("STRIPPED=", output("ansi", format="stripped"))
meta = output("alpha", format="json")
println("META=", meta["id"], ":", meta["char_count"] > 0)
multi = output("alpha", "json")
println("MULTI=", length(multi), ":", multi[1]["id"], ":", multi[2]["id"])
nothing
`,
			{
				cwd: tempDir.path(),
				artifactsDir,
				sessionId: `julia-prelude-output:${crypto.randomUUID()}`,
				kernelOwnerId: OWNER_ID,
				reset: true,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("RANGE=two|three");
		expect(result.output).toContain('QUERY="b"');
		expect(result.output).toContain("STRIPPED=red");
		expect(result.output).toContain("META=alpha:true");
		expect(result.output).toContain("MULTI=2:alpha:json");
	}, 60_000);

	it("surfaces the exception type and message in the error output, not just stack frames", async () => {
		using tempDir = TempDir.createSync("@oms-eval-julia-error-");
		const result = await executeJulia(`println("="^8)\nmissing_var_xyz + 1`, {
			cwd: tempDir.path(),
			sessionId: `julia-prelude-error:${crypto.randomUUID()}`,
			kernelOwnerId: OWNER_ID,
			reset: true,
		});

		// The rendered error must carry the actual exception, not only the
		// runner-internal backtrace frames (regression: traceback-only output
		// hid `ename`/`evalue`).
		expect(result.output).toContain("UndefVarError");
		expect(result.output).toContain("missing_var_xyz");
		// Frames are still present alongside the message.
		expect(result.output).toContain("top-level scope");
	}, 30_000);
});
