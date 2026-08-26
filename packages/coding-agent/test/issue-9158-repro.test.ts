/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/9158
 *
 * `createWorkerSubprocess` spawns every worker with `serialization: "advanced"`.
 * When a child sends a malformed or truncated advanced-IPC frame, Bun raises the
 * structured-clone decode failure as a process-level `uncaughtException` in the
 * parent (oven-sh/bun#37287), not in the channel's `ipc()` callback. The global
 * postmortem handler previously treated that as fatal and exited the whole
 * session.
 *
 * The handler now recognizes Bun's precise decode-error shape, keeps the session
 * alive, and faults every active advanced-IPC worker because Bun provides no
 * channel attribution. Each owning client then rejects in-flight requests and
 * recycles its subprocess.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("issue #9158 — malformed worker IPC frame must not terminate the parent", () => {
	it.skipIf(process.platform === "win32")(
		"faults and recycles a still-live worker while the parent survives",
		async () => {
			const repoRoot = path.resolve(import.meta.dir, "..");
			// Bun exposes the raw IPC channel as descriptor 3 on POSIX. Windows
			// uses a named pipe without a writable descriptor, so this malformed
			// frame cannot be injected there.
			const childScript =
				'require("node:fs").writeSync(3, Buffer.from([2, 4, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef])); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);';
			const wrapperScript = `
				import { createWorkerSubprocess } from "@oh-my-soup/pi-coding-agent/subprocess/worker-client";
				const worker = createWorkerSubprocess({
					spawnCommand: { cmd: [process.execPath, "-e", ${JSON.stringify(childScript)}] },
					env: {},
					exitLabel: "malformed IPC child",
					unref: false,
				});
				const { promise: errored, resolve } = Promise.withResolvers();
				worker.errors.add(resolve);
				const err = await errored;
				process.stdout.write("FAULTED:" + err.message);
			`;
			const proc = Bun.spawn([process.execPath, "-e", wrapperScript], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, PI_TEST_RUNTIME: "0" },
			});
			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("FAULTED:");
			expect(stdout).toContain("worker sent a malformed IPC frame");
		},
		20_000,
	);

	it("keeps an ordinary TypeError with the same message on the fatal path", async () => {
		// An application-thrown TypeError has a populated stack, so it must not be
		// swallowed as Bun's bare malformed-frame error.
		const repoRoot = path.resolve(import.meta.dir, "..");
		const wrapperScript = `
			import "@oh-my-soup/pi-coding-agent/subprocess/worker-client";
			process.stdout.write("BEFORE_THROW");
			queueMicrotask(() => { throw new TypeError("Unable to deserialize data."); });
		`;
		const proc = Bun.spawn([process.execPath, "-e", wrapperScript], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PI_TEST_RUNTIME: "0" },
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exitCode).toBe(1);
		expect(stdout).toBe("BEFORE_THROW");
	}, 20_000);
});
