import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { TempDir } from "@oh-my-soup/pi-utils";

describe("resolveWorkerSpawnCmd", () => {
	it("uses the absolute host entry without pinning the child cwd", async () => {
		using tempDir = TempDir.createSync("@oms-worker-spawn-");
		const probePath = tempDir.join("probe.ts");
		const workerHostUrl = pathToFileURL(path.resolve(import.meta.dir, "../../utils/src/worker-host.ts")).href;
		const workerClientUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/subprocess/worker-client.ts")).href;
		await Bun.write(
			probePath,
			[
				`import { declareWorkerHostEntry } from ${JSON.stringify(workerHostUrl)};`,
				`import { resolveWorkerSpawnCmd } from ${JSON.stringify(workerClientUrl)};`,
				"declareWorkerHostEntry();",
				'process.stdout.write(JSON.stringify(resolveWorkerSpawnCmd("__oms_worker_probe")));',
			].join("\n"),
		);

		const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const command = JSON.parse(stdout) as { cmd: string[]; cwd?: string };
		expect(command.cwd).toBeUndefined();
		expect(path.isAbsolute(command.cmd[1])).toBe(true);
		expect(command.cmd[1]).toBe(probePath);
		expect(command.cmd[0].startsWith("\\\\?\\")).toBe(false);
		expect(command.cmd[1].startsWith("\\\\?\\")).toBe(false);
	});
});
