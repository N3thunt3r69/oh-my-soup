/** Adversarial contracts for OMS-native Beads persistence, paging, and Git synchronization. */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { randomFillSync, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { BeadsTool, NativeBeadsRepository } from "@oh-my-soup/pi-coding-agent/tools/beads";
import { $which, TempDir } from "@oh-my-soup/pi-utils";
import { syncNativeBeads } from "../../src/beads/sync";

function session(root: string, sessionId = "beads-hardening-session"): ToolSession {
	return {
		cwd: root,
		hasUI: false,
		getAgentId: () => "test-agent",
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "beads.enabled": true }),
	} as unknown as ToolSession;
}

function tool(root: string, sessionId?: string): BeadsTool {
	const value = BeadsTool.createIf(session(root, sessionId));
	if (!value) throw new Error("expected Beads tool");
	return value;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(entry => entry.type === "text")?.text ?? "";
}

function parseJsonLines(value: string): Array<Record<string, unknown>> {
	return value
		.split(/\r?\n/)
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...Bun.env };
	for (const key of [
		"GIT_ATTR_SOURCE",
		"GIT_AUTHOR_DATE",
		"GIT_AUTHOR_EMAIL",
		"GIT_AUTHOR_NAME",
		"GIT_COMMON_DIR",
		"GIT_COMMITTER_DATE",
		"GIT_COMMITTER_EMAIL",
		"GIT_COMMITTER_NAME",
		"GIT_CONFIG_PARAMETERS",
		"GIT_DEFAULT_HASH",
		"GIT_DIR",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_TEMPLATE_DIR",
		"GIT_WORK_TREE",
	]) {
		delete environment[key];
	}
	return {
		...environment,
		GIT_CONFIG_COUNT: "0",
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : os.devNull,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
}

function gitResult(cwd: string, args: string[]): GitResult {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: isolatedGitEnvironment(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	return {
		exitCode: result.exitCode,
		stdout: new TextDecoder().decode(result.stdout).trim(),
		stderr: new TextDecoder().decode(result.stderr).trim(),
	};
}

function git(cwd: string, args: string[]): string {
	const result = gitResult(cwd, args);
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0] ?? "command"} failed`);
	return result.stdout;
}

function initializeGitWorktree(root: string, remote: string, objectFormat?: "sha1" | "sha256"): void {
	fs.mkdirSync(root, { recursive: true });
	git(root, ["init", ...(objectFormat ? [`--object-format=${objectFormat}`] : [])]);
	git(root, ["config", "user.name", "Native Beads Hardening"]);
	git(root, ["config", "user.email", "beads-hardening@oms.local"]);
	fs.writeFileSync(path.join(root, "tracked.txt"), "checked-out branch sentinel\n", "utf8");
	git(root, ["add", "tracked.txt"]);
	git(root, ["commit", "-m", "baseline"]);
	git(root, ["remote", "add", "origin", path.relative(root, remote)]);
}

function temporarySyncDirectories(): Set<string> {
	return new Set(
		fs
			.readdirSync(os.tmpdir())
			.filter(entry => entry.includes("oms-beads-sync-"))
			.map(entry => path.join(os.tmpdir(), entry)),
	);
}

function restoreEnvironment(values: Map<string, string | undefined>): void {
	for (const [key, value] of values) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
}

function redirectTemporaryDirectory(root: string): Map<string, string | undefined> {
	fs.mkdirSync(root, { recursive: true });
	const keys = ["TMP", "TEMP", "TMPDIR"];
	const previous = new Map(keys.map(key => [key, Bun.env[key]]));
	for (const key of keys) Bun.env[key] = root;
	return previous;
}
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeShellScript(file: string, body: string): void {
	fs.writeFileSync(file, `#!/bin/sh\n${body}`, "utf8");
	if (process.platform !== "win32") fs.chmodSync(file, 0o755);
}

async function waitForFiles(files: readonly string[]): Promise<void> {
	for (let attempt = 0; attempt < 2_000; attempt++) {
		if (files.every(file => fs.existsSync(file))) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for workers: ${files.join(", ")}`);
}

async function concurrentChildren(root: string, parent: string, count: number): Promise<string[]> {
	const repositoryModule = new URL("../../src/beads/repository.ts", import.meta.url).href;
	const gate = path.join(root, "children.go");
	const readyFiles = Array.from({ length: count }, (_, index) => path.join(root, `child-${index}.ready`));
	const children = readyFiles.map((ready, index) => {
		const program = `
			import * as fs from "node:fs";
			import { NativeBeadsRepository } from ${JSON.stringify(repositoryModule)};
			const repository = NativeBeadsRepository.open(${JSON.stringify(root)});
			fs.writeFileSync(${JSON.stringify(ready)}, "ready");
			while (!fs.existsSync(${JSON.stringify(gate)})) await Bun.sleep(2);
			try {
				const created = repository.create({
					title: ${JSON.stringify(`Concurrent child ${index}`)},
					parent: ${JSON.stringify(parent)},
					actor: ${JSON.stringify(`oms:child-${index}`)},
				});
				console.log(created.id);
			} finally {
				repository.close();
			}
		`;
		return Bun.spawn([process.execPath, "-e", program], {
			cwd: import.meta.dir,
			env: Bun.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			signal: AbortSignal.timeout(30_000),
		});
	});
	try {
		await waitForFiles(readyFiles);
		fs.writeFileSync(gate, "go", "utf8");
		return await Promise.all(
			children.map(async child => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `child worker exited ${exitCode}`);
				return stdout.trim();
			}),
		);
	} finally {
		if (!fs.existsSync(gate)) fs.writeFileSync(gate, "go", "utf8");
		await Promise.allSettled(children.map(child => child.exited));
	}
}

describe("native beads schema, validation, and transactions", () => {
	it("migrates an old schema and round-trips unknown issue and dependency fields", () => {
		const temp = TempDir.createSync("@beads-migration-");
		try {
			const root = temp.path();
			NativeBeadsRepository.initialize(root).close();
			const databasePath = path.join(root, ".beads", "oms-beads.sqlite");
			const migration = Bun.spawnSync(
				[
					process.execPath,
					"-e",
					`import { Database } from "bun:sqlite";
					 const database = new Database(${JSON.stringify(databasePath)}, { readwrite: true });
					 database.exec("ALTER TABLE issues DROP COLUMN extra_json; ALTER TABLE dependencies DROP COLUMN extra_json; PRAGMA user_version = 1;");
					 database.close(true);`,
				],
				{ cwd: import.meta.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
			);
			if (migration.exitCode !== 0) throw new Error(new TextDecoder().decode(migration.stderr));

			const now = "2026-01-02T03:04:05.000Z";
			const imported = {
				id: "legacy-1",
				title: "Legacy record",
				status: "open",
				priority: 1,
				issue_type: "bug",
				created_at: now,
				updated_at: now,
				custom_issue_field: { nested: [1, true, "value"] },
				dependency_count: 999,
				dependencies: [
					{
						issue_id: "legacy-1",
						depends_on_id: "external-1",
						type: "blocks",
						created_at: now,
						custom_edge_field: { weight: 7 },
					},
				],
			};
			fs.writeFileSync(path.join(root, ".beads", "issues.jsonl"), `${JSON.stringify(imported)}\n`, "utf8");
			const migrated = NativeBeadsRepository.initialize(root);
			let snapshot: ReturnType<NativeBeadsRepository["snapshotInterchange"]>;
			try {
				snapshot = migrated.snapshotInterchange();
			} finally {
				migrated.close();
			}
			const reopened = NativeBeadsRepository.open(root);
			try {
				expect(
					reopened.show(["legacy-1"])[0]?.blocked_by?.map(value => (typeof value === "string" ? value : value.id)),
				).toEqual(["external-1"]);
			} finally {
				reopened.close();
			}
			const [roundTripped] = parseJsonLines(snapshot.issues);
			if (!roundTripped) throw new Error("expected migrated issue export");
			expect(roundTripped.custom_issue_field).toEqual({ nested: [1, true, "value"] });
			expect(roundTripped).not.toHaveProperty("dependency_count");
			const [dependency] = roundTripped.dependencies as Array<Record<string, unknown>>;
			expect(dependency?.custom_edge_field).toEqual({ weight: 7 });
		} finally {
			temp.removeSync();
		}
	});

	it("rejects malformed and oversized fields and rolls back all-or-nothing batches", async () => {
		const temp = TempDir.createSync("@beads-validation-");
		try {
			const repository = NativeBeadsRepository.initialize(temp.path());
			expect(() => repository.create({ title: " ", actor: "oms:test" })).toThrow("title must not be empty");
			expect(() => repository.create({ title: "x".repeat(256), actor: "oms:test" })).toThrow("255");
			expect(() =>
				repository.create({ title: "large body", description: "x".repeat(1024 * 1024 + 1), actor: "oms:test" }),
			).toThrow("character limit");
			expect(() => repository.create({ title: "bad dep", deps: ["blocks:"], actor: "oms:test" })).toThrow();
			const first = repository.create({ title: "First", actor: "oms:test" });
			const second = repository.create({ title: "Second", actor: "oms:test" });
			expect(() => repository.closeIssues([first.id, "missing-id", second.id], "must roll back")).toThrow(
				"not found",
			);
			expect(repository.show([first.id, second.id]).map(value => value.status)).toEqual(["open", "open"]);
			repository.close();

			const beadsTool = tool(temp.path());
			expect(() => beadsTool.parameters.assert({ op: "list", unexpected: true })).toThrow();
			await expect(beadsTool.execute("bad-limit", { op: "list", limit: 0 })).rejects.toThrow("positive integer");
			await expect(beadsTool.execute("bad-offset", { op: "list", offset: -1 })).rejects.toThrow(
				"non-negative integer",
			);
		} finally {
			temp.removeSync();
		}
	});

	it("allocates collision-resistant child ids under concurrent writers", async () => {
		const temp = TempDir.createSync("@beads-child-race-");
		try {
			const repository = NativeBeadsRepository.initialize(temp.path());
			const parent = repository.create({ title: "Concurrent epic", issueType: "epic", actor: "oms:test" });
			repository.close();
			const ids = await concurrentChildren(temp.path(), parent.id, 10);
			expect(new Set(ids).size).toBe(ids.length);
			for (const id of ids) {
				expect(id).toMatch(new RegExp(`^${parent.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[0-9]{16}$`));
			}
			const publishedIds = parseJsonLines(fs.readFileSync(path.join(temp.path(), ".beads", "issues.jsonl"), "utf8"))
				.filter(record => record.parent === parent.id)
				.map(record => record.id);
			expect(publishedIds.sort()).toEqual([...ids].sort());
			const reopened = NativeBeadsRepository.open(temp.path());
			expect(reopened.list(undefined, 100).filter(value => value.parent === parent.id)).toHaveLength(10);
			reopened.close();
		} finally {
			temp.removeSync();
		}
	});
});

describe("native beads interchange and crash recovery", () => {
	it("rejects invalid UTF-8 and over-limit interchange files without leaving an open store", () => {
		for (const mode of ["utf8", "oversized"] as const) {
			const temp = TempDir.createSync(`@beads-bad-import-${mode}-`);
			try {
				const beadsDir = path.join(temp.path(), ".beads");
				fs.mkdirSync(beadsDir);
				const file = path.join(beadsDir, "issues.jsonl");
				if (mode === "utf8") fs.writeFileSync(file, Uint8Array.of(0xff, 0xfe));
				else {
					fs.writeFileSync(file, "");
					fs.truncateSync(file, 16 * 1024 * 1024 + 1);
				}
				expect(() => NativeBeadsRepository.initialize(temp.path())).toThrow(
					mode === "utf8" ? "valid UTF-8" : "16 MiB",
				);
			} finally {
				temp.removeSync();
			}
		}
	});

	it("recovers both pre-commit rollback and post-commit roll-forward publication states", () => {
		const temp = TempDir.createSync("@beads-recovery-");
		try {
			const root = temp.path();
			const repository = NativeBeadsRepository.initialize(root);
			repository.create({ title: "Published issue", actor: "oms:test" });
			const committed = repository.snapshotInterchange();
			repository.close();
			const beadsDir = path.join(root, ".beads");
			const journalPath = path.join(beadsDir, "oms-interchange-journal.json");
			const targets = [
				{ kind: "issues", file: "issues.jsonl", content: committed.issues },
				{ kind: "memories", file: "oms-memories.jsonl", content: committed.memories },
			] as const;

			const rollbackGeneration = randomUUID();
			for (const target of targets) {
				const stem = path.join(beadsDir, `.oms-interchange-${rollbackGeneration}-${target.kind}`);
				fs.renameSync(path.join(beadsDir, target.file), `${stem}.old`);
				fs.writeFileSync(`${stem}.new`, "uncommitted\n", "utf8");
				fs.writeFileSync(`${stem}.old.tmp`, "partial backup", "utf8");
			}
			fs.writeFileSync(
				journalPath,
				`${JSON.stringify({ version: 1, generation: rollbackGeneration, hadIssues: true, hadMemories: true })}\n`,
				"utf8",
			);
			NativeBeadsRepository.open(root).close();
			expect(fs.readFileSync(path.join(beadsDir, "issues.jsonl"), "utf8")).toBe(committed.issues);
			expect(fs.readFileSync(path.join(beadsDir, "oms-memories.jsonl"), "utf8")).toBe(committed.memories);

			const rollForwardGeneration = randomUUID();
			const database = new Database(path.join(beadsDir, "oms-beads.sqlite"), { readwrite: true });
			try {
				database.run(
					"INSERT INTO meta (key, value) VALUES ('interchange_generation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
					[rollForwardGeneration],
				);
			} finally {
				database.close(true);
			}
			for (const target of targets) {
				const stem = path.join(beadsDir, `.oms-interchange-${rollForwardGeneration}-${target.kind}`);
				fs.writeFileSync(path.join(beadsDir, target.file), "stale snapshot\n", "utf8");
				fs.writeFileSync(`${stem}.new`, target.content, "utf8");
				fs.writeFileSync(`${stem}.old.tmp`, "partial backup", "utf8");
			}
			fs.writeFileSync(
				journalPath,
				`${JSON.stringify({ version: 1, generation: rollForwardGeneration, hadIssues: true, hadMemories: true })}\n`,
				"utf8",
			);
			NativeBeadsRepository.open(root).close();
			expect(fs.readFileSync(path.join(beadsDir, "issues.jsonl"), "utf8")).toBe(committed.issues);
			expect(fs.readFileSync(path.join(beadsDir, "oms-memories.jsonl"), "utf8")).toBe(committed.memories);
			expect(fs.readdirSync(beadsDir).some(entry => entry.startsWith(".oms-interchange-"))).toBe(false);
		} finally {
			temp.removeSync();
		}
	});

	it("resolves overlapping dependency cycles deterministically regardless of input order", () => {
		const temp = TempDir.createSync("@beads-deterministic-");
		try {
			const roots = [path.join(temp.path(), "left"), path.join(temp.path(), "right")];
			const now = "2026-02-03T04:05:06.000Z";
			const edges = [
				["bd-aaa", "bd-bbb"],
				["bd-bbb", "bd-ccc"],
				["bd-ccc", "bd-aaa"],
				["bd-ccc", "bd-ddd"],
				["bd-ddd", "bd-bbb"],
			] as const;
			const records = ["bd-aaa", "bd-bbb", "bd-ccc", "bd-ddd"].map(id => ({
				id,
				title: `Issue ${id}`,
				status: "open",
				priority: 2,
				issue_type: "task",
				created_at: now,
				updated_at: now,
				dependencies: edges
					.filter(([child]) => child === id)
					.map(([child, parent]) => ({ issue_id: child, depends_on_id: parent, type: "blocks", created_at: now })),
			}));
			const outputs: string[] = [];
			for (const [index, root] of roots.entries()) {
				fs.mkdirSync(root, { recursive: true });
				const repository = NativeBeadsRepository.initialize(root);
				try {
					const ordered =
						index === 0
							? records
							: [...records]
									.reverse()
									.map(record => ({ ...record, dependencies: [...record.dependencies].reverse() }));
					const result = repository.mergeInterchange(
						`${ordered.map(value => JSON.stringify(value)).join("\n")}\n`,
						"",
					);
					expect(result.dependencyConflicts).toBeGreaterThan(0);
					expect(repository.stats().cycles).toBe(0);
					outputs.push(repository.serializeIssues());
				} finally {
					repository.close();
				}
			}
			expect(outputs[1]).toBe(outputs[0]);
			const exported = parseJsonLines(outputs[0] ?? "");
			const dependencyCount = exported.reduce(
				(total, row) => total + (Array.isArray(row.dependencies) ? row.dependencies.length : 0),
				0,
			);
			expect(dependencyCount).toBeGreaterThan(0);
			expect(dependencyCount).toBeLessThan(edges.length);
		} finally {
			temp.removeSync();
		}
	});
});

describe("native beads model output paging", () => {
	it("pages issue rows, full fields, memories, and dependency trees without losing content", async () => {
		const temp = TempDir.createSync("@beads-paging-");
		try {
			const root = temp.path();
			const repository = NativeBeadsRepository.initialize(root);
			const body = "D".repeat(20_000);
			const large = repository.create({ title: "Large issue", description: body, actor: "oms:test" });
			for (let index = 0; index < 59; index++) {
				repository.create({ title: `Page issue ${index}`, actor: "oms:test" });
			}
			const memoryValue = "M".repeat(20_000);
			const largeMemory = repository.remember(memoryValue);
			for (let index = 0; index < 25; index++) repository.remember(`Memory value ${index}`);
			const treeRoot = repository.create({ title: "Tree root", actor: "oms:test" });
			for (let index = 0; index < 35; index++) {
				const blocker = repository.create({ title: `${index}-${"T".repeat(240)}`, actor: "oms:test" });
				repository.addDependency(treeRoot.id, blocker.id, "blocks", "oms:test");
			}
			const staleBlocked = repository.create({ title: "Closed dependent", actor: "oms:test" });
			const openBlocker = repository.create({ title: "Still open blocker", actor: "oms:test" });
			repository.addDependency(staleBlocked.id, openBlocker.id, "blocks", "oms:test");
			repository.closeIssues([staleBlocked.id], "completed independently");
			repository.close();

			const beadsTool = tool(root);
			const seen = new Set<string>();
			let offset = 0;
			for (;;) {
				const page = await beadsTool.execute("list-page", { op: "list", limit: 17, offset });
				for (const value of page.details?.issues ?? []) {
					expect(seen.has(value.id)).toBe(false);
					seen.add(value.id);
				}
				if (page.details?.nextOffset === undefined) break;
				offset = page.details.nextOffset;
			}
			expect(seen.size).toBe(98);

			const preview = await beadsTool.execute("show-preview", { op: "show", id: large.id });
			expect(text(preview).length).toBeLessThan(64_000);
			expect(text(preview)).not.toContain(body);
			const field1 = await beadsTool.execute("show-field-1", { op: "show", id: large.id, field: "description" });
			expect(field1.details?.nextOffset).toBe(8_000);
			expect(text(field1)).toContain("D".repeat(8_000));
			const field2 = await beadsTool.execute("show-field-2", {
				op: "show",
				id: large.id,
				field: "description",
				offset: field1.details?.nextOffset,
			});
			expect(field2.details?.nextOffset).toBe(16_000);
			const field3 = await beadsTool.execute("show-field-3", {
				op: "show",
				id: large.id,
				field: "description",
				offset: field2.details?.nextOffset,
			});
			expect(field3.details?.nextOffset).toBeUndefined();
			expect(text(field3)).toContain("D".repeat(4_000));

			const memory1 = await beadsTool.execute("memory-1", { op: "memory", key: largeMemory.key });
			expect(memory1.details?.nextOffset).toBe(8_000);
			const memory3 = await beadsTool.execute("memory-3", { op: "memory", key: largeMemory.key, offset: 16_000 });
			expect(memory3.details?.nextOffset).toBeUndefined();
			expect(text(memory3)).toContain("M".repeat(4_000));

			const tree1 = await beadsTool.execute("tree-1", { op: "dep_tree", id: treeRoot.id });
			expect(tree1.details?.nextOffset).toBe(8_000);
			const tree2 = await beadsTool.execute("tree-2", {
				op: "dep_tree",
				id: treeRoot.id,
				offset: tree1.details?.nextOffset,
			});
			expect(text(tree2)).toContain("dependency tree characters 8000-");

			const prime = await beadsTool.execute("prime", { op: "prime", limit: 50 });
			expect(text(prime)).toContain("more memories; call prime again with offset 20");
			const closed = await beadsTool.execute("closed", { op: "show", id: staleBlocked.id });
			expect(text(closed).startsWith("X ")).toBe(true);
			expect(text(closed)).not.toContain("blocked by:");
		} finally {
			temp.removeSync();
		}
	});
});

describe.skipIf(!$which("git"))("native beads hardened Git synchronization", () => {
	it("preserves branch state, multiple push URLs, transport config, and ignores ambient hooks, filters, and excludes", async () => {
		const temp = TempDir.createSync("@beads-sync-hardening-");
		const environmentKeys = [
			"GIT_CONFIG_GLOBAL",
			"GIT_ATTR_SOURCE",
			"GIT_AUTHOR_DATE",
			"GIT_COMMITTER_DATE",
			"GIT_DEFAULT_HASH",
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"TMP",
			"TEMP",
			"TMPDIR",
		];
		const priorEnvironment = new Map(environmentKeys.map(key => [key, Bun.env[key]]));
		try {
			const isolatedTemp = path.join(temp.path(), "sync-temp");
			fs.mkdirSync(isolatedTemp);
			for (const key of ["TMP", "TEMP", "TMPDIR"]) Bun.env[key] = isolatedTemp;
			const root = path.join(temp.path(), "work");
			const remoteA = path.join(temp.path(), "remote-a.git");
			const remoteB = path.join(temp.path(), "remote-b.git");
			git(temp.path(), ["init", "--bare", remoteA]);
			git(temp.path(), ["init", "--bare", remoteB]);
			git(remoteA, ["config", "uploadpack.allowFilter", "true"]);
			initializeGitWorktree(root, remoteA);
			git(root, ["remote", "set-url", "--add", "--push", "origin", path.relative(root, remoteA)]);
			git(root, ["remote", "set-url", "--add", "--push", "origin", path.relative(root, remoteB)]);

			const uploadMarker = path.join(temp.path(), "upload-used");
			const receiveMarker = path.join(temp.path(), "receive-used");
			const upload = path.join(root, ".git", "oms-upload.sh");
			const receive = path.join(root, ".git", "oms-receive.sh");
			writeShellScript(upload, `echo used > ${shellQuote(uploadMarker)}\nexec git-upload-pack "$@"\n`);
			writeShellScript(receive, `echo used > ${shellQuote(receiveMarker)}\nexec git-receive-pack "$@"\n`);
			git(root, ["config", "remote.origin.uploadpack", "sh .git/oms-upload.sh"]);
			git(root, ["config", "remote.origin.receivepack", "sh .git/oms-receive.sh"]);

			const hostileMarker = path.join(temp.path(), "hostile-used");
			const hostile = path.join(temp.path(), "hostile.sh");
			writeShellScript(hostile, `echo used > ${shellQuote(hostileMarker)}\nexit 1\n`);
			const hookMarker = path.join(temp.path(), "hook-used");
			const hooks = path.join(temp.path(), "hooks");
			fs.mkdirSync(hooks);
			writeShellScript(path.join(hooks, "pre-commit"), `echo used > ${shellQuote(hookMarker)}\nexit 1\n`);
			const excludes = path.join(temp.path(), "global-excludes");
			const attributes = path.join(temp.path(), "global-attributes");
			fs.writeFileSync(excludes, ".beads/*.jsonl\n", "utf8");
			fs.writeFileSync(attributes, ".beads/*.jsonl filter=explode\n", "utf8");
			const conditionalConfig = path.join(temp.path(), "conditional.gitconfig");
			fs.writeFileSync(conditionalConfig, '[protocol "file"]\n\tallow = always\n', "utf8");
			const globalConfig = path.join(temp.path(), "global.gitconfig");
			fs.writeFileSync(
				globalConfig,
				`[core]\n\thooksPath = ${hooks.replaceAll("\\", "/")}\n\texcludesFile = ${excludes.replaceAll("\\", "/")}\n\tattributesFile = ${attributes.replaceAll("\\", "/")}\n\tfsmonitor = sh ${hostile.replaceAll("\\", "/")}\n[filter "explode"]\n\tclean = sh ${hostile.replaceAll("\\", "/")}\n\trequired = true\n[protocol "file"]\n\tallow = never\n[includeIf "gitdir:${root.replaceAll("\\", "/")}/"]\n\tpath = ${conditionalConfig.replaceAll("\\", "/")}\n`,
				"utf8",
			);

			const repository = NativeBeadsRepository.initialize(root);
			const stagedPath = path.join(root, "staged.txt");
			const untrackedPath = path.join(root, "untracked.txt");
			const trackedPath = path.join(root, "tracked.txt");
			fs.writeFileSync(stagedPath, "staged sentinel\n", "utf8");
			git(root, ["add", "staged.txt"]);
			fs.writeFileSync(trackedPath, "unstaged sentinel\n", "utf8");
			fs.writeFileSync(untrackedPath, "untracked sentinel\n", "utf8");
			const head = git(root, ["rev-parse", "HEAD"]);
			const branch = git(root, ["symbolic-ref", "--short", "HEAD"]);
			const indexTree = git(root, ["write-tree"]);
			const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
			const trackedContent = fs.readFileSync(trackedPath, "utf8");
			const untrackedContent = fs.readFileSync(untrackedPath, "utf8");
			const beforeTemps = temporarySyncDirectories();
			Bun.env.GIT_CONFIG_GLOBAL = globalConfig;
			Bun.env.GIT_ATTR_SOURCE = "HEAD";
			Bun.env.GIT_AUTHOR_DATE = "not-a-date";
			Bun.env.GIT_COMMITTER_DATE = "not-a-date";
			Bun.env.GIT_DEFAULT_HASH = "sha256";
			Bun.env.GIT_DIR = path.join(temp.path(), "wrong-git-dir");
			Bun.env.GIT_INDEX_FILE = path.join(temp.path(), "wrong-index");
			try {
				repository.create({ title: "Hardened sync issue", actor: "oms:test" });
				expect((await syncNativeBeads(repository, "origin")).pushed).toBe(true);
				repository.create({ title: "Lazy-fetch sync issue", actor: "oms:test" });
				expect((await syncNativeBeads(repository, "origin")).pushed).toBe(true);
			} finally {
				repository.close();
			}
			restoreEnvironment(priorEnvironment);
			for (const key of ["TMP", "TEMP", "TMPDIR"]) Bun.env[key] = isolatedTemp;
			expect(git(remoteA, ["rev-parse", "refs/heads/oms-beads"])).toMatch(/^[0-9a-f]{40}$/);
			expect(git(remoteB, ["rev-parse", "refs/heads/oms-beads"])).toMatch(/^[0-9a-f]{40}$/);
			expect(fs.existsSync(uploadMarker)).toBe(true);
			expect(fs.existsSync(receiveMarker)).toBe(true);
			expect(fs.existsSync(hostileMarker)).toBe(false);
			expect(fs.existsSync(hookMarker)).toBe(false);
			expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
			expect(git(root, ["symbolic-ref", "--short", "HEAD"])).toBe(branch);
			expect(git(root, ["write-tree"])).toBe(indexTree);
			expect(git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(status);
			expect(fs.readFileSync(trackedPath, "utf8")).toBe(trackedContent);
			expect(fs.readFileSync(untrackedPath, "utf8")).toBe(untrackedContent);
			const leakedTemps = [...temporarySyncDirectories()].filter(entry => !beforeTemps.has(entry));
			expect(leakedTemps).toEqual([]);
		} finally {
			restoreEnvironment(priorEnvironment);
			temp.removeSync();
		}
	}, 30_000);

	it("converges simultaneous compare-and-swap pushes without dropping either clone", async () => {
		const temp = TempDir.createSync("@beads-sync-cas-");
		try {
			const remote = path.join(temp.path(), "remote.git");
			git(temp.path(), ["init", "--bare", remote]);
			const roots = [path.join(temp.path(), "left"), path.join(temp.path(), "right")];
			for (const root of roots) initializeGitWorktree(root, remote);
			const repositories = roots.map(root => NativeBeadsRepository.initialize(root));
			const created = repositories.map((repository, index) =>
				repository.create({ title: `CAS issue ${index}`, actor: `oms:cas-${index}` }),
			);
			const remembered = repositories.map((repository, index) => repository.remember(`CAS memory ${index}`));
			try {
				await Promise.all(repositories.map(repository => syncNativeBeads(repository, "origin")));
			} finally {
				for (const repository of repositories) repository.close();
			}

			const clone = path.join(temp.path(), "clone");
			initializeGitWorktree(clone, remote);
			const cloneRepository = NativeBeadsRepository.initialize(clone);
			try {
				await syncNativeBeads(cloneRepository, "origin");
				expect(
					cloneRepository
						.list(undefined, 100)
						.map(value => value.id)
						.sort(),
				).toEqual(created.map(value => value.id).sort());
				expect(
					cloneRepository
						.memories(100)
						.map(value => value.value)
						.sort(),
				).toEqual(remembered.map(value => value.value).sort());
			} finally {
				cloneRepository.close();
			}
		} finally {
			temp.removeSync();
		}
	}, 30_000);

	it("preserves SHA-256 object format when supported", async () => {
		const temp = TempDir.createSync("@beads-sync-sha256-");
		try {
			const remote = path.join(temp.path(), "remote.git");
			const probe = gitResult(temp.path(), ["init", "--bare", "--object-format=sha256", remote]);
			if (probe.exitCode !== 0) return;
			const root = path.join(temp.path(), "work");
			initializeGitWorktree(root, remote, "sha256");
			const repository = NativeBeadsRepository.initialize(root);
			repository.create({ title: "SHA-256 issue", actor: "oms:test" });
			await syncNativeBeads(repository, "origin");
			repository.close();
			expect(git(remote, ["rev-parse", "refs/heads/oms-beads"])).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			temp.removeSync();
		}
	});

	it("terminates fetches whose temporary object store exceeds the sync budget", async () => {
		const temp = TempDir.createSync("@beads-sync-budget-");
		const priorTempEnvironment = redirectTemporaryDirectory(path.join(temp.path(), "sync-temp"));
		try {
			const remote = path.join(temp.path(), "remote.git");
			const root = path.join(temp.path(), "work");
			git(temp.path(), ["init", "--bare", remote]);
			initializeGitWorktree(root, remote);
			const beadsDir = path.join(root, ".beads");
			fs.mkdirSync(beadsDir, { recursive: true });
			fs.writeFileSync(path.join(beadsDir, "issues.jsonl"), "", "utf8");
			fs.writeFileSync(path.join(beadsDir, "oms-memories.jsonl"), "", "utf8");
			const payload = path.join(root, "oversized-pack.bin");
			const descriptor = fs.openSync(payload, "w");
			try {
				const chunk = Buffer.allocUnsafe(1024 * 1024);
				for (let index = 0; index < 84; index++) {
					randomFillSync(chunk);
					fs.writeSync(descriptor, chunk);
				}
			} finally {
				fs.closeSync(descriptor);
			}
			git(root, ["add", ".beads/issues.jsonl", ".beads/oms-memories.jsonl", "oversized-pack.bin"]);
			git(root, ["commit", "-m", "oversized remote snapshot"]);
			git(root, ["push", "origin", "HEAD:refs/heads/oms-beads"]);

			const repository = NativeBeadsRepository.initialize(root);
			const beforeTemps = temporarySyncDirectories();
			try {
				repository.create({ title: "Bounded fetch", actor: "oms:test" });
				await expect(syncNativeBeads(repository, "origin")).rejects.toThrow(
					"Temporary Git object storage exceeds the 80 MiB native Beads sync limit.",
				);
			} finally {
				repository.close();
			}
			const leakedTemps = [...temporarySyncDirectories()].filter(entry => !beforeTemps.has(entry));
			expect(leakedTemps).toEqual([]);
		} finally {
			restoreEnvironment(priorTempEnvironment);
			temp.removeSync();
		}
	}, 60_000);

	it("fails HTTP authentication without invoking ambient prompt helpers and cleans temporary repositories", async () => {
		const temp = TempDir.createSync("@beads-sync-auth-");
		const oldAskPass = Bun.env.GIT_ASKPASS;
		const priorTempEnvironment = redirectTemporaryDirectory(path.join(temp.path(), "sync-temp"));
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response("authentication required", {
					status: 401,
					headers: { "WWW-Authenticate": 'Basic realm="test"' },
				}),
		});
		try {
			const root = path.join(temp.path(), "work");
			fs.mkdirSync(root);
			git(root, ["init"]);
			git(root, ["config", "user.name", "Auth Test"]);
			git(root, ["config", "user.email", "auth@oms.local"]);
			git(root, ["remote", "add", "origin", `http://127.0.0.1:${server.port}/repo.git`]);
			const repository = NativeBeadsRepository.initialize(root);
			repository.create({ title: "Auth failure", actor: "oms:test" });
			const marker = path.join(temp.path(), "askpass-used");
			const askPass = path.join(temp.path(), process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
			if (process.platform === "win32") {
				fs.writeFileSync(
					askPass,
					`@echo off\r\n> "${marker.replaceAll("%", "%%")}" echo used\r\necho secret\r\n`,
					"utf8",
				);
			} else {
				writeShellScript(askPass, `echo used > ${shellQuote(marker)}\necho secret\n`);
			}
			const preflight = Bun.spawnSync(process.platform === "win32" ? ["cmd.exe", "/d", "/c", askPass] : [askPass], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
				windowsHide: true,
			});
			expect(preflight.exitCode).toBe(0);
			expect(fs.existsSync(marker)).toBe(true);
			fs.rmSync(marker);
			Bun.env.GIT_ASKPASS = askPass;
			const beforeTemps = temporarySyncDirectories();
			const started = performance.now();
			try {
				await expect(syncNativeBeads(repository, "origin", AbortSignal.timeout(10_000))).rejects.toThrow();
				expect(performance.now() - started).toBeLessThan(10_000);
				expect(fs.existsSync(marker)).toBe(false);
				const leakedTemps = [...temporarySyncDirectories()].filter(entry => !beforeTemps.has(entry));
				expect(leakedTemps).toEqual([]);
			} finally {
				repository.close();
			}
		} finally {
			if (oldAskPass === undefined) delete Bun.env.GIT_ASKPASS;
			else Bun.env.GIT_ASKPASS = oldAskPass;
			server.stop(true);
			restoreEnvironment(priorTempEnvironment);
			temp.removeSync();
		}
	});
});
