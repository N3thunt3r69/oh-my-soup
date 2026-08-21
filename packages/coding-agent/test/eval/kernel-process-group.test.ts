import { describe, expect, test } from "bun:test";
import { isSignalableProcessGroup, killProcessGroup } from "../../src/eval/kernel-base";

const POSIX = process.platform !== "win32";

/** Ground truth for "does a process group with this leader exist right now?" via the null signal. */
function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("isSignalableProcessGroup", () => {
	test("rejects the degenerate kill(2) group targets", () => {
		// `-0` would signal omp's own process group and `-1` would signal every
		// process the user can reach; both must never be negated into a kill.
		expect(isSignalableProcessGroup(0)).toBe(false);
		expect(isSignalableProcessGroup(1)).toBe(false);
		expect(isSignalableProcessGroup(-42)).toBe(false);
	});

	test("rejects absent or non-integer pids", () => {
		expect(isSignalableProcessGroup(undefined)).toBe(false);
		expect(isSignalableProcessGroup(Number.NaN)).toBe(false);
		expect(isSignalableProcessGroup(12.5)).toBe(false);
	});

	test("accepts a normal child pid", () => {
		expect(isSignalableProcessGroup(2)).toBe(true);
		expect(isSignalableProcessGroup(57944)).toBe(true);
	});
});

describe("killProcessGroup", () => {
	test("never signals a degenerate group even when asked to", () => {
		expect(killProcessGroup(0, "SIGKILL")).toBe(false);
		expect(killProcessGroup(1, "SIGKILL")).toBe(false);
		expect(killProcessGroup(undefined, "SIGKILL")).toBe(false);
	});

	test("reports false instead of throwing when the group is already gone", () => {
		// PID 0x7fffffff is above every platform's pid_max, so the group cannot
		// exist and kill(2) fails with ESRCH.
		expect(killProcessGroup(0x7fffffff, "SIGKILL")).toBe(false);
	});

	test.skipIf(!POSIX)("agrees with kill(2) on a live child and never throws", async () => {
		const proc = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			// Whether the child leads its own group depends on the spawn backend, so
			// compare against kill(2) ground truth rather than assuming detachment.
			const expected = processGroupExists(proc.pid);
			expect(killProcessGroup(proc.pid, "SIGKILL")).toBe(expected);
		} finally {
			proc.kill("SIGKILL");
			const settled = await Promise.race([
				proc.exited.then(() => "exited" as const),
				Bun.sleep(5_000).then(() => "timeout" as const),
			]);
			expect(settled).toBe("exited");
		}
	});
});
