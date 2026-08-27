import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "@oh-my-soup/pi-coding-agent/utils/git";
import { removeWithRetries } from "@oh-my-soup/pi-utils";

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_NOSYSTEM: "1",
} as const;

function gitRun(cwd: string, args: string[]): void {
	const env: Record<string, string | undefined> = {
		...process.env,
		...GIT_ENV,
		GIT_CONFIG_GLOBAL: path.join(cwd, ".gitconfig-disabled"),
	};
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, env, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
}

describe("git.diff capture completeness", () => {
	let repo: string;

	beforeAll(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-trunc-test-"));
		gitRun(repo, ["init", "-q", "-b", "main"]);
		const binary = new Uint8Array(9 * 1024 * 1024);
		for (let offset = 0; offset < binary.length; offset += 65_536) {
			crypto.getRandomValues(binary.subarray(offset, Math.min(offset + 65_536, binary.length)));
		}
		await Bun.write(path.join(repo, "a.bin"), binary);
		await Bun.write(path.join(repo, "z.txt"), "hello world\nchanged line\n");
		await git.stage.files(repo);
	});

	afterAll(async () => {
		await removeWithRetries(repo);
	});

	test("unguarded capture retains its bounded legacy behavior", async () => {
		const staged = await git.diff(repo, { cached: true, binary: true });
		expect(staged.length).toBeLessThanOrEqual(git.GIT_COMMAND_OUTPUT_LIMIT_BYTES + 64);
		expect(git.diff.parseFiles(staged).map(file => file.filename)).not.toContain("z.txt");
	});

	test("requireComplete rejects a truncated binary diff with typed provenance", async () => {
		let thrown: unknown;
		try {
			await git.diff(repo, { cached: true, binary: true, requireComplete: true });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(git.GitOutputTruncatedError);
		expect((thrown as Error).message).toContain("truncated");
		expect((thrown as git.GitOutputTruncatedError).result.truncated).toBe(true);
	});

	test("requireComplete returns an unchanged complete diff", async () => {
		const small = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-small-test-"));
		try {
			gitRun(small, ["init", "-q", "-b", "main"]);
			await Bun.write(path.join(small, "s.txt"), "one\ntwo\n");
			await git.stage.files(small);
			const complete = await git.diff(small, { cached: true, binary: true, requireComplete: true });
			expect(complete).toContain("s.txt");
		} finally {
			await removeWithRetries(small);
		}
	});
});
