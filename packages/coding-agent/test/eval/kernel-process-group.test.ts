import { describe, expect, test } from "bun:test";
import { isSignalableProcessGroup, killProcessGroup } from "../../src/eval/kernel-base";

const POSIX = process.platform !== "win32";

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

	test.skipIf(!POSIX)("reaps a detached kernel-style child through its process group", async () => {
		const proc = Bun.spawn(["sleep", "30"], {
			detached: true,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			expect(killProcessGroup(proc.pid, "SIGKILL")).toBe(true);
			const settled = await Promise.race([
				proc.exited.then(() => "exited" as const),
				Bun.sleep(5_000).then(() => "timeout" as const),
			]);
			expect(settled).toBe("exited");
		} finally {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already reaped */
			}
		}
	});
});
