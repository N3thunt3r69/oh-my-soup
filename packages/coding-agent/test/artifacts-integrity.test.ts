import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager, writeArtifact } from "@oh-my-soup/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-soup/pi-utils";

describe("ArtifactManager write integrity", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifact-integrity-${crypto.randomUUID()}`);
		dirs.push(dir);
		return dir;
	}

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
	});

	it("rejects a short write without publishing a discoverable artifact", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		const manager = new ArtifactManager(dir);
		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
			await realWrite(target as string, String(content).slice(0, 3));
			return 3;
		});

		await expect(manager.save("complete report", "task")).rejects.toThrow(
			"Artifact write incomplete: wrote 3 of 15 bytes",
		);
		expect(await fs.readdir(dir)).toEqual([]);
	});

	it("preserves the prior artifact when a staged replacement fails", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "original valid report");
		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
			await realWrite(target as string, String(content).slice(0, 2));
			return 2;
		});

		await expect(writeArtifact(destination, "replacement report")).rejects.toThrow("Artifact write incomplete");
		expect(await Bun.file(destination).text()).toBe("original valid report");
		expect(await fs.readdir(dir)).toEqual(["Worker.md"]);
	});

	it.each(["EPERM", "EEXIST"])("replaces an existing artifact after Windows %s", async code => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "original report");
		const rename = fs.rename.bind(fs);
		let injected = false;
		vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
			if (!injected && String(source).includes(".tmp-") && String(target) === destination) {
				injected = true;
				throw Object.assign(new Error("injected Windows replacement failure"), { code });
			}
			await rename(source, target);
		});

		await writeArtifact(destination, "replacement report");
		expect(injected).toBe(true);
		expect(await Bun.file(destination).text()).toBe("replacement report");
		expect(await fs.readdir(dir)).toEqual(["Worker.md"]);
	});
});
