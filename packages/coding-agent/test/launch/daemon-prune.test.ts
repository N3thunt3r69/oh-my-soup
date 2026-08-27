import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-soup/pi-utils";
import { pruneDeadDaemonRuntimeDirs } from "../../src/launch/presence";

const STALE = new Date(Date.now() - 30 * 60_000);
let deadPid = 0;

async function scope(
	root: string,
	name: string,
	init: { pid?: number | "dead"; clients?: number[]; stale?: boolean },
): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(path.join(dir, "clients"), { recursive: true });
	if (init.pid !== undefined) {
		const pid = init.pid === "dead" ? deadPid : init.pid;
		await Bun.write(path.join(dir, "broker.pid"), JSON.stringify({ pid, instanceId: name }));
	}
	for (const clientPid of init.clients ?? []) {
		await Bun.write(
			path.join(dir, "clients", `${clientPid}-x.json`),
			JSON.stringify({ pid: clientPid, id: `${clientPid}-x`, projectDir: dir }),
		);
	}
	if (init.stale) await fs.utimes(dir, STALE, STALE);
	return dir;
}

describe("pruneDeadDaemonRuntimeDirs", () => {
	beforeAll(async () => {
		const child = Bun.spawn([process.execPath, "-e", ""]);
		await child.exited;
		deadPid = child.pid;
	});

	it("removes only stale scopes with a dead broker and no live clients", async () => {
		using tempDir = TempDir.createSync("@oms-daemon-prune-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });

		const current = await scope(daemons, "aaaaaaaaaaaaaaaa", { pid: "dead", stale: true });
		await scope(daemons, "bbbbbbbbbbbbbbbb", { pid: "dead", stale: true });
		await scope(daemons, "cccccccccccccccc", { pid: process.pid, stale: true });
		await scope(daemons, "dddddddddddddddd", { clients: [process.pid], stale: true });
		await scope(daemons, "eeeeeeeeeeeeeeee", { pid: "dead" });
		await fs.mkdir(path.join(daemons, "global", "some-service"), { recursive: true });
		await fs.mkdir(path.join(daemons, "foreign-directory"), { recursive: true });
		await fs.utimes(path.join(daemons, "global"), STALE, STALE);
		await fs.utimes(path.join(daemons, "foreign-directory"), STALE, STALE);

		await pruneDeadDaemonRuntimeDirs(current);

		const remaining = new Set(await fs.readdir(daemons));
		expect(remaining.has("bbbbbbbbbbbbbbbb")).toBe(false);
		expect(remaining.has("aaaaaaaaaaaaaaaa")).toBe(true);
		expect(remaining.has("cccccccccccccccc")).toBe(true);
		expect(remaining.has("dddddddddddddddd")).toBe(true);
		expect(remaining.has("eeeeeeeeeeeeeeee")).toBe(true);
		expect(remaining.has("global")).toBe(true);
		expect(remaining.has("foreign-directory")).toBe(true);
	});

	it("does not sweep sibling machine-global service runtimes", async () => {
		using tempDir = TempDir.createSync("@oms-daemon-prune-global-");
		const globalRoot = path.join(tempDir.path(), "run", "daemons", "global");
		const current = await scope(globalRoot, "current-service", { pid: "dead", stale: true });
		const sibling = await scope(globalRoot, "persistent-service", { pid: "dead", stale: true });

		await pruneDeadDaemonRuntimeDirs(current);

		await expect(fs.stat(sibling)).resolves.toBeDefined();
	});

	it("never sweeps outside the daemons container when a runtime is relocated", async () => {
		using tempDir = TempDir.createSync("@oms-daemon-prune-tmpdir-");
		const sharedRoot = tempDir.path();
		for (const name of ["tmux-1000", "ssh-XVn1oP", "my-build-tree"]) {
			await fs.mkdir(path.join(sharedRoot, name, "src"), { recursive: true });
			await fs.utimes(path.join(sharedRoot, name), STALE, STALE);
		}
		const runtimeDir = path.join(sharedRoot, "oms-daemon-smoke-run-xxxx");
		await fs.mkdir(runtimeDir, { recursive: true });

		await pruneDeadDaemonRuntimeDirs(runtimeDir);

		const remaining = new Set(await fs.readdir(sharedRoot));
		expect(remaining.has("tmux-1000")).toBe(true);
		expect(remaining.has("ssh-XVn1oP")).toBe(true);
		expect(remaining.has("my-build-tree")).toBe(true);
	});

	it("does nothing when the runtime root does not exist", async () => {
		using tempDir = TempDir.createSync("@oms-daemon-prune-missing-");
		const current = path.join(tempDir.path(), "run", "daemons", "aaaaaaaaaaaaaaaa");
		await expect(pruneDeadDaemonRuntimeDirs(current)).resolves.toBeUndefined();
	});
});
