// These integration checks use real subprocesses: fake timers cannot advance
// Bun.Subprocess.exited or exercise operating-system process-tree teardown.
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCandidates, runBoundedProbe } from "../../src/eval/probe";

const bun = process.execPath;
const HANG = [bun, "-e", "await Bun.sleep(60_000)"];
const IGNORE_TERM = [bun, "-e", 'process.on("SIGTERM", () => {}); await Bun.sleep(60_000)'];
const baseEnv = (): Record<string, string | undefined> => ({ ...process.env });

describe("runBoundedProbe", () => {
	test("bounds and force-kills a hung probe", async () => {
		const startedAt = Date.now();
		const result = await runBoundedProbe(IGNORE_TERM, {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 300,
		});
		expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	test("short-circuits an already-aborted signal", async () => {
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.abort(),
		});
		expect(result).toEqual({ exitCode: null, timedOut: false, aborted: true });
	});

	test("kills an in-flight probe when its caller aborts", async () => {
		const startedAt = Date.now();
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.timeout(100),
		});
		expect(result).toEqual({ exitCode: null, timedOut: false, aborted: true });
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	test("reports real exit codes for completed probes", async () => {
		const successful = await runBoundedProbe([bun, "-e", "process.exit(0)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(successful).toEqual({ exitCode: 0, timedOut: false, aborted: false });

		const failed = await runBoundedProbe([bun, "-e", "process.exit(3)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(failed).toEqual({ exitCode: 3, timedOut: false, aborted: false });
	});

	test("kills descendants spawned by an interpreter shim", async () => {
		const pidFile = join(tmpdir(), `oms-probe-grandchild-${process.pid}-${Date.now()}.pid`);
		let grandchildPid: number | undefined;
		const wrapper = [
			bun,
			"-e",
			`const child=Bun.spawn([process.execPath,"-e","await Bun.sleep(60_000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});await Bun.write(${JSON.stringify(pidFile)},String(child.pid));await child.exited`,
		];
		try {
			const result = await runBoundedProbe(wrapper, {
				cwd: process.cwd(),
				env: baseEnv(),
				timeoutMs: 1_000,
			});
			expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
			grandchildPid = Number(await Bun.file(pidFile).text());
			const deadline = Date.now() + 2_000;
			while (Date.now() < deadline) {
				try {
					process.kill(grandchildPid, 0);
					await Bun.sleep(25);
				} catch {
					break;
				}
			}
			expect(() => process.kill(grandchildPid!, 0)).toThrow();
		} finally {
			if (grandchildPid !== undefined) {
				try {
					process.kill(grandchildPid, "SIGKILL");
				} catch {
					// Expected after successful process-tree teardown.
				}
			}
			await rm(pidFile, { force: true });
		}
	});
});

describe("probeCandidates", () => {
	test("shares one discovery deadline across all candidates", async () => {
		const startedAt = Date.now();
		const result = await probeCandidates(
			[
				{ command: HANG, env: baseEnv(), label: "candidate-a" },
				{ command: HANG, env: baseEnv(), label: "candidate-b" },
				{ command: HANG, env: baseEnv(), label: "candidate-c" },
			],
			{ cwd: process.cwd(), timeoutMs: 300 },
		);
		expect(result).toEqual({ ok: false, aborted: false, failures: expect.any(Array) });
		expect(Date.now() - startedAt).toBeLessThan(900);
	});

	test("returns the first successful candidate without starting later candidates", async () => {
		const result = await probeCandidates(
			[
				{ command: [bun, "-e", "process.exit(1)"], env: baseEnv(), label: "failed" },
				{ command: [bun, "-e", "process.exit(0)"], env: baseEnv(), label: "working" },
				{ command: HANG, env: baseEnv(), label: "must-not-start" },
			],
			{ cwd: process.cwd(), timeoutMs: 5_000 },
		);
		expect(result).toEqual({ ok: true, index: 1 });
	});
});
