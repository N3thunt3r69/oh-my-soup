import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyRefinementOps,
	applyRefinementProposal,
	getPromptNotesPath,
	getRefinementLogPath,
	getSubagentSpecsPath,
	loadRefinementLog,
	type RefinementProposal,
	type RefinementStorePaths,
	rollbackRefinement,
} from "../src/refinement";
import { getMemoryNotesPath, getSkillFilePath } from "../src/refinement/backends";

let root: string;
let paths: RefinementStorePaths;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "oms-refine-"));
	paths = { cwd: path.join(root, "project"), agentDir: path.join(root, "agent") };
	await fs.mkdir(paths.cwd, { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function readOrNull(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return null;
	}
}

function proposal(ops: RefinementProposal["ops"], summary = "test pass"): RefinementProposal {
	return { summary, rationale: "test rationale", expectedOutcome: "test outcome", ops };
}

describe("refinement op application", () => {
	it("applies a promptNote add into the project supplemental instructions file", async () => {
		const { applied } = await applyRefinementOps(paths, [
			{ action: "add", kind: "promptNote", title: "Always run bun", content: "Use bun, not npm." },
		]);
		expect(applied).toHaveLength(1);
		expect(applied[0].applied).toBe(true);
		expect(applied[0].id).toBe("always-run-bun");
		const text = await readOrNull(getPromptNotesPath(paths));
		expect(text).toContain("oms-refine:notes:begin");
		expect(text).toContain("### Always run bun");
		expect(text).toContain("Use bun, not npm.");
	});

	it("preserves surrounding user content in AGENTS.md across add/update/remove", async () => {
		const notesPath = getPromptNotesPath(paths);
		await fs.mkdir(path.dirname(notesPath), { recursive: true });
		const userContent = "# My project rules\n\nHand-written guidance.\n";
		await fs.writeFile(notesPath, userContent, "utf8");

		await applyRefinementOps(paths, [{ action: "add", kind: "promptNote", title: "Note", content: "First." }]);
		await applyRefinementOps(paths, [{ action: "update", kind: "promptNote", id: "note", content: "Second." }]);
		let text = await readOrNull(notesPath);
		expect(text).toContain("Hand-written guidance.");
		expect(text).toContain("Second.");
		expect(text).not.toContain("First.");

		await applyRefinementOps(paths, [{ action: "remove", kind: "promptNote", id: "note" }]);
		text = await readOrNull(notesPath);
		expect(text).toContain("Hand-written guidance.");
		expect(text).not.toContain("oms-refine:notes:begin");
	});

	it("refuses ops targeting the base system prompt", async () => {
		const { applied, files } = await applyRefinementOps(paths, [
			{ action: "add", kind: "promptNote", id: "base_system_prompt", title: "X", content: "rewrite it" },
		]);
		expect(applied[0].applied).toBe(false);
		expect(applied[0].error).toContain("immutable");
		expect(Object.keys(files)).toHaveLength(0);
		expect(await readOrNull(getPromptNotesPath(paths))).toBeNull();
	});

	it("manages tagged memory lines without clobbering existing lessons", async () => {
		const memoryPath = getMemoryNotesPath(paths);
		await fs.mkdir(path.dirname(memoryPath), { recursive: true });
		await fs.writeFile(memoryPath, "- pre-existing lesson\n", "utf8");

		await applyRefinementOps(paths, [{ action: "add", kind: "memory", id: "uses-tabs", content: "Repo uses tabs." }]);
		let text = await readOrNull(memoryPath);
		expect(text).toContain("- Repo uses tabs. _(context: refine:uses-tabs)_");
		expect(text).toContain("- pre-existing lesson");

		await applyRefinementOps(paths, [{ action: "update", kind: "memory", id: "uses-tabs", content: "Tabs only." }]);
		text = await readOrNull(memoryPath);
		expect(text).toContain("- Tabs only. _(context: refine:uses-tabs)_");
		expect(text).not.toContain("Repo uses tabs.");

		await applyRefinementOps(paths, [{ action: "remove", kind: "memory", id: "uses-tabs" }]);
		text = await readOrNull(memoryPath);
		expect(text).toBe("- pre-existing lesson\n");
	});

	it("writes managed skill metadata in SKILL.md frontmatter shape", async () => {
		const { applied } = await applyRefinementOps(paths, [
			{
				action: "add",
				kind: "skillDescription",
				id: "release-notes",
				title: "Draft release notes from the changelog",
				content: "Read CHANGELOG.md and summarize.",
			},
		]);
		expect(applied[0].applied).toBe(true);
		const text = await readOrNull(getSkillFilePath(paths, "release-notes"));
		expect(text).toStartWith("---\n");
		expect(text).toContain("name: release-notes");
		expect(text).toContain("description: Draft release notes from the changelog");
		expect(text).toContain("Read CHANGELOG.md and summarize.");
	});

	it("stores subagent specs as task templates in subagent-specs.json", async () => {
		await applyRefinementOps(paths, [
			{
				action: "add",
				kind: "subagentSpec",
				title: "Reviews diffs for regressions",
				content: "You are a focused reviewer. Check the diff for regressions.",
				model: "smol",
			},
		]);
		const text = await readOrNull(getSubagentSpecsPath(paths));
		expect(text).not.toBeNull();
		const parsed = JSON.parse(text!);
		const spec = parsed.specs["reviews-diffs-for-regressions"];
		expect(spec.description).toBe("Reviews diffs for regressions");
		expect(spec.model).toBe("smol");
	});

	it("rejects add on an existing id and update/remove on a missing id", async () => {
		await applyRefinementOps(paths, [{ action: "add", kind: "memory", id: "fact", content: "A." }]);
		const { applied } = await applyRefinementOps(paths, [
			{ action: "add", kind: "memory", id: "fact", content: "B." },
			{ action: "update", kind: "memory", id: "missing", content: "C." },
			{ action: "remove", kind: "promptNote", id: "missing" },
		]);
		expect(applied.map(op => op.applied)).toEqual([false, false, false]);
		expect(applied[0].error).toBe("entry already exists");
		expect(applied[1].error).toBe("entry not found");
	});
});

describe("refinement rollback", () => {
	it("round-trips a multi-kind pass back to byte-identical prior state", async () => {
		const notesPath = getPromptNotesPath(paths);
		await fs.mkdir(path.dirname(notesPath), { recursive: true });
		await fs.writeFile(notesPath, "# Existing\n", "utf8");
		const snapshotBefore = {
			notes: await readOrNull(notesPath),
			memory: await readOrNull(getMemoryNotesPath(paths)),
			specs: await readOrNull(getSubagentSpecsPath(paths)),
			skill: await readOrNull(getSkillFilePath(paths, "helper")),
		};

		const entry = await applyRefinementProposal(
			paths,
			proposal([
				{ action: "add", kind: "promptNote", title: "Rule", content: "Do X." },
				{ action: "add", kind: "memory", id: "fact", content: "Y is true." },
				{ action: "add", kind: "subagentSpec", id: "helper", title: "Helps", content: "Help." },
				{ action: "add", kind: "skillDescription", id: "helper", title: "Skill", content: "Body." },
			]),
			{ trigger: "manual" },
		);
		expect(entry.ops.every(op => op.applied)).toBe(true);
		expect(await readOrNull(notesPath)).not.toBe(snapshotBefore.notes);

		const rollback = await rollbackRefinement(paths, entry.id);
		expect(rollback.rollbackOf).toBe(entry.id);
		expect(await readOrNull(notesPath)).toBe(snapshotBefore.notes);
		expect(await readOrNull(getMemoryNotesPath(paths))).toBe(snapshotBefore.memory);
		expect(await readOrNull(getSubagentSpecsPath(paths))).toBe(snapshotBefore.specs);
		expect(await readOrNull(getSkillFilePath(paths, "helper"))).toBe(snapshotBefore.skill);
	});

	it("round-trips update and remove ops losslessly", async () => {
		await applyRefinementOps(paths, [
			{ action: "add", kind: "memory", id: "fact", content: "Original." },
			{ action: "add", kind: "promptNote", id: "rule", title: "Rule", content: "Original rule." },
		]);
		const memoryBefore = await readOrNull(getMemoryNotesPath(paths));
		const notesBefore = await readOrNull(getPromptNotesPath(paths));

		const entry = await applyRefinementProposal(
			paths,
			proposal([
				{ action: "update", kind: "memory", id: "fact", content: "Changed." },
				{ action: "remove", kind: "promptNote", id: "rule" },
			]),
			{ trigger: "manual" },
		);
		expect(entry.ops.every(op => op.applied)).toBe(true);

		await rollbackRefinement(paths, entry.id);
		expect(await readOrNull(getMemoryNotesPath(paths))).toBe(memoryBefore);
		expect(await readOrNull(getPromptNotesPath(paths))).toBe(notesBefore);
	});

	it("falls back to entry-wise reversal when files changed after the pass", async () => {
		const entry = await applyRefinementProposal(
			paths,
			proposal([{ action: "add", kind: "memory", id: "fact", content: "Z." }]),
			{ trigger: "manual" },
		);
		const memoryPath = getMemoryNotesPath(paths);
		// External edit AFTER the pass: byte-exact restore must not clobber it.
		await fs.appendFile(memoryPath, "- later unrelated lesson\n", "utf8");

		await rollbackRefinement(paths, entry.id);
		const text = await readOrNull(memoryPath);
		expect(text).toContain("- later unrelated lesson");
		expect(text).not.toContain("refine:fact");
	});

	it("refuses double rollback and unknown ids", async () => {
		const entry = await applyRefinementProposal(
			paths,
			proposal([{ action: "add", kind: "memory", id: "fact", content: "Z." }]),
			{ trigger: "manual" },
		);
		await rollbackRefinement(paths, entry.id);
		await expect(rollbackRefinement(paths, entry.id)).rejects.toThrow("already rolled back");
		await expect(rollbackRefinement(paths, "refine_nope")).rejects.toThrow("not found");
	});
});

describe("refinement log", () => {
	it("appends one JSONL line per pass and replays them in order", async () => {
		const first = await applyRefinementProposal(
			paths,
			proposal([{ action: "add", kind: "memory", id: "a", content: "A." }], "first"),
			{ trigger: "manual" },
		);
		const second = await applyRefinementProposal(
			paths,
			proposal([{ action: "add", kind: "memory", id: "b", content: "B." }], "second"),
			{ trigger: "auto:compact" },
		);

		const raw = await readOrNull(getRefinementLogPath(paths));
		expect(raw!.trimEnd().split("\n")).toHaveLength(2);

		const history = await loadRefinementLog(paths);
		expect(history.map(item => item.id)).toEqual([first.id, second.id]);
		expect(history[0].summary).toBe("first");
		expect(history[1].trigger).toBe("auto:compact");
		expect(history[0].ops[0].applied).toBe(true);
		expect(Object.keys(history[0].files)).toHaveLength(1);
	});

	it("skips malformed log lines instead of breaking replay", async () => {
		const entry = await applyRefinementProposal(
			paths,
			proposal([{ action: "add", kind: "memory", id: "a", content: "A." }]),
			{ trigger: "manual" },
		);
		await fs.appendFile(getRefinementLogPath(paths), "{not json}\n", "utf8");
		const history = await loadRefinementLog(paths);
		expect(history.map(item => item.id)).toEqual([entry.id]);
	});
});
