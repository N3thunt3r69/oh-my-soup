/**
 * Contracts: beads tool (bd CLI wrapper).
 *
 * 1. Availability: the tool activates only when the bd binary is resolvable
 *    AND the workspace has a `.beads/` database (nearest-ancestor walk).
 * 2. Argv construction: each op maps to the documented bd command line;
 *    description-like fields ride as single `--flag=value` argv entries (no
 *    shell, no escaping), `deps` repeat the `--deps` flag.
 * 3. JSON contract: both the `BD_JSON_ENVELOPE=1` envelope and legacy raw
 *    shapes parse; JSON error payloads (`{error, hint}`) surface as ToolError
 *    messages.
 * 4. Approval tiers: readonly ops → read, mutations → write, sync → exec.
 * 5. Output: list-like ops render status-glyph issue lines and cap at 50 with
 *    a truncation marker.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toolWireSchema } from "@oh-my-soup/pi-ai/utils/schema";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { type BeadsIssue, BeadsTool, bd } from "@oh-my-soup/pi-coding-agent/tools/beads";
import { ToolError } from "@oh-my-soup/pi-coding-agent/tools/tool-errors";
import { TempDir } from "@oh-my-soup/pi-utils";

function createSession(cwd = "/tmp/beads-test", settings?: Record<string, unknown>): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "beads.enabled": true, ...settings }),
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content.find(entry => entry.type === "text");
	return part?.text ?? "";
}

function makeIssue(id: string, overrides: Partial<BeadsIssue> = {}): BeadsIssue {
	return {
		id,
		title: `Issue ${id}`,
		status: "open",
		priority: 2,
		issue_type: "task",
		...overrides,
	};
}

function createTool(session: ToolSession = createSession()): BeadsTool {
	vi.spyOn(bd, "available").mockReturnValue(true);
	vi.spyOn(bd, "workspaceRoot").mockReturnValue(session.cwd);
	const tool = BeadsTool.createIf(session);
	if (!tool) throw new Error("expected BeadsTool to be constructible");
	return tool;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("availability gating", () => {
	it("requires both the binary and a .beads workspace", () => {
		const session = createSession();
		vi.spyOn(bd, "available").mockReturnValue(false);
		vi.spyOn(bd, "workspaceRoot").mockReturnValue(session.cwd);
		expect(BeadsTool.createIf(session)).toBeNull();

		vi.restoreAllMocks();
		vi.spyOn(bd, "available").mockReturnValue(true);
		vi.spyOn(bd, "workspaceRoot").mockReturnValue(null);
		expect(BeadsTool.createIf(session)).toBeNull();

		vi.restoreAllMocks();
		vi.spyOn(bd, "available").mockReturnValue(true);
		vi.spyOn(bd, "workspaceRoot").mockReturnValue(session.cwd);
		expect(BeadsTool.createIf(session)).toBeInstanceOf(BeadsTool);
	});

	it("finds the nearest ancestor .beads directory", () => {
		const tempDir = TempDir.createSync("@oms-beads-ws-");
		try {
			const root = tempDir.path();
			fs.mkdirSync(path.join(root, ".beads"), { recursive: true });
			const nested = path.join(root, "packages", "app", "src");
			fs.mkdirSync(nested, { recursive: true });
			expect(bd.workspaceRoot(nested)).toBe(path.resolve(root));
			expect(bd.workspaceRoot(root)).toBe(path.resolve(root));
		} finally {
			tempDir.removeSync();
		}
	});

	it("returns null when no .beads exists up the tree", () => {
		const tempDir = TempDir.createSync("@oms-beads-none-");
		try {
			expect(bd.workspaceRoot(tempDir.path())).toBeNull();
		} finally {
			tempDir.removeSync();
		}
	});

	it("ignores the user-level ~/.beads config dir", () => {
		const tempDir = TempDir.createSync("@oms-beads-home-");
		try {
			const fakeHome = tempDir.path();
			// bd creates ~/.beads as user-level CONFIG; it must not activate the
			// tool for every directory under $HOME.
			fs.mkdirSync(path.join(fakeHome, ".beads"), { recursive: true });
			const below = path.join(fakeHome, "some", "dir");
			fs.mkdirSync(below, { recursive: true });
			const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
			try {
				expect(bd.workspaceRoot(below)).toBeNull();
				// A real project database below home still resolves.
				const project = path.join(fakeHome, "proj");
				fs.mkdirSync(path.join(project, ".beads"), { recursive: true });
				expect(bd.workspaceRoot(path.join(project, "src"))).toBe(path.resolve(project));
			} finally {
				homedirSpy.mockRestore();
			}
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("approval tiers", () => {
	it("maps readonly ops to read, mutations to write, sync to exec", () => {
		const tool = createTool();
		const approval = tool.approval;
		for (const op of ["ready", "blocked", "list", "show", "dep_tree", "prime", "stats"]) {
			expect(approval({ op })).toBe("read");
		}
		for (const op of ["create", "update", "close", "dep_add", "remember"]) {
			expect(approval({ op })).toBe("write");
		}
		expect(approval({ op: "sync" })).toBe("exec");
	});
});

describe("op argv construction", () => {
	it("ready passes --json and honors limit", async () => {
		const tool = createTool();
		const json = vi.spyOn(bd, "json").mockResolvedValue([makeIssue("bd-1")]);
		const result = await tool.execute("t1", { op: "ready", limit: 5 });
		expect(json.mock.calls[0]?.[1]).toEqual(["ready", "--json", "--limit", "5"]);
		expect(getFirstText(result)).toContain("○ bd-1 [P2] [task] Issue bd-1");
		expect(result.details?.issues).toHaveLength(1);
	});

	it("list forwards the status filter", async () => {
		const tool = createTool();
		const json = vi.spyOn(bd, "json").mockResolvedValue([]);
		const result = await tool.execute("t2", { op: "list", status: "in_progress" });
		expect(json.mock.calls[0]?.[1]).toEqual(["list", "--json", "--status", "in_progress"]);
		expect(getFirstText(result)).toBe("No issues found.");
	});

	it("create builds the full flag set with repeated --deps", async () => {
		const tool = createTool();
		const created = makeIssue("bd-9", { title: "Fix auth", priority: 1, issue_type: "bug" });
		const json = vi.spyOn(bd, "json").mockResolvedValue(created);
		const result = await tool.execute("t3", {
			op: "create",
			title: "Fix auth",
			priority: 1,
			issueType: "bug",
			description: 'Body with `backticks` and "quotes"',
			parent: "bd-epic",
			acceptance: "login works",
			deps: ["discovered-from:bd-2", "bd-3"],
		});
		expect(json.mock.calls[0]?.[1]).toEqual([
			"create",
			"Fix auth",
			"--json",
			"-p",
			"1",
			"-t",
			"bug",
			'--description=Body with `backticks` and "quotes"',
			"--parent",
			"bd-epic",
			"--acceptance=login works",
			"--deps",
			"discovered-from:bd-2",
			"--deps",
			"bd-3",
		]);
		expect(getFirstText(result)).toContain("Created ○ bd-9 [P1] [bug] Fix auth");
	});

	it("update requires id and at least one change", async () => {
		const tool = createTool();
		await expect(tool.execute("t4", { op: "update" })).rejects.toThrow("update requires `id`");
		await expect(tool.execute("t5", { op: "update", id: "bd-1" })).rejects.toThrow("at least one change");
	});

	it("update --claim marks the issue in progress", async () => {
		const tool = createTool();
		const claimed = makeIssue("bd-1", { status: "in_progress", assignee: "agent" });
		const json = vi.spyOn(bd, "json").mockResolvedValue([claimed]);
		const result = await tool.execute("t6", { op: "update", id: "bd-1", claim: true });
		expect(json.mock.calls[0]?.[1]).toEqual(["update", "bd-1", "--json", "--claim"]);
		expect(getFirstText(result)).toContain("◐ bd-1");
		expect(getFirstText(result)).toContain("claimed by agent");
	});

	it("close accepts multiple ids and a reason", async () => {
		const tool = createTool();
		const json = vi
			.spyOn(bd, "json")
			.mockResolvedValue([makeIssue("bd-1", { status: "closed" }), makeIssue("bd-2", { status: "closed" })]);
		const result = await tool.execute("t7", { op: "close", ids: ["bd-1", "bd-2"], reason: "Done" });
		expect(json.mock.calls[0]?.[1]).toEqual(["close", "bd-1", "bd-2", "--json", "--reason", "Done"]);
		expect(getFirstText(result)).toContain("Closed ✓ bd-1");
		expect(getFirstText(result)).toContain("Closed ✓ bd-2");
	});

	it("dep_add wires child and parent positionally", async () => {
		const tool = createTool();
		const text = vi.spyOn(bd, "text").mockResolvedValue("");
		const result = await tool.execute("t8", { op: "dep_add", id: "bd-3", parent: "bd-2" });
		expect(text.mock.calls[0]?.[1]).toEqual(["dep", "add", "bd-3", "bd-2"]);
		expect(getFirstText(result)).toBe("bd-3 now depends on bd-2.");
	});

	it("sync pulls before pushing", async () => {
		const tool = createTool();
		const text = vi.spyOn(bd, "text").mockResolvedValue("ok");
		await tool.execute("t9", { op: "sync" });
		expect(text.mock.calls.map(call => call[1])).toEqual([
			["dolt", "pull"],
			["dolt", "push"],
		]);
	});

	it("show requires an id and renders detail fields", async () => {
		const tool = createTool();
		await expect(tool.execute("t10", { op: "show" })).rejects.toThrow("show requires `id`");
		vi.spyOn(bd, "json").mockResolvedValue([
			makeIssue("bd-1", { description: "Long body", acceptance_criteria: "It works" }),
		]);
		const result = await tool.execute("t11", { op: "show", id: "bd-1" });
		expect(getFirstText(result)).toContain("Long body");
		expect(getFirstText(result)).toContain("Acceptance: It works");
	});
});

describe("json contract", () => {
	it("unwraps the BD_JSON_ENVELOPE shape and accepts legacy arrays", async () => {
		const session = createSession();
		const run = vi.spyOn(bd, "run");
		run.mockResolvedValueOnce({
			exitCode: 0,
			stdout: JSON.stringify({ schema_version: 1, data: [makeIssue("bd-1")] }),
			stderr: "",
		});
		const enveloped = await bd.json<BeadsIssue[]>(session, ["ready", "--json"]);
		expect(enveloped[0]?.id).toBe("bd-1");

		run.mockResolvedValueOnce({
			exitCode: 0,
			stdout: JSON.stringify([makeIssue("bd-2")]),
			stderr: "",
		});
		const legacy = await bd.json<BeadsIssue[]>(session, ["ready", "--json"]);
		expect(legacy[0]?.id).toBe("bd-2");
	});

	it("surfaces bd JSON error payloads with hints", async () => {
		const session = createSession();
		vi.spyOn(bd, "run").mockResolvedValue({
			exitCode: 1,
			stdout: "",
			stderr: JSON.stringify({ schema_version: 1, error: "issue not found: bd-zz", hint: "run bd list" }),
		});
		await expect(bd.json(session, ["show", "bd-zz", "--json"])).rejects.toThrow(
			"issue not found: bd-zz (run bd list)",
		);
	});

	it("falls back to raw stderr for non-JSON failures", async () => {
		const session = createSession();
		vi.spyOn(bd, "run").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "boom" });
		await expect(bd.text(session, ["stats"])).rejects.toThrow("boom");
		await expect(bd.text(session, ["stats"])).rejects.toBeInstanceOf(ToolError);
	});
});

describe("output shaping", () => {
	it("caps list output at 50 issues and flags truncation", async () => {
		const tool = createTool();
		const issues = Array.from({ length: 60 }, (_, index) => makeIssue(`bd-${index}`));
		vi.spyOn(bd, "json").mockResolvedValue(issues);
		const result = await tool.execute("t12", { op: "list" });
		const lines = getFirstText(result).split("\n");
		expect(lines).toHaveLength(51);
		expect(lines[50]).toContain("10");
		expect(result.details?.truncated).toBe(true);
		expect(result.details?.issues).toHaveLength(50);
	});

	it("annotates blockers and parents on issue lines", async () => {
		const tool = createTool();
		vi.spyOn(bd, "json").mockResolvedValue([
			makeIssue("bd-5", {
				blocked_by: [{ id: "bd-1" }, "bd-2"],
				parent: "bd-epic",
			}),
		]);
		const result = await tool.execute("t13", { op: "blocked" });
		expect(getFirstText(result)).toContain("blocked by: bd-1, bd-2");
		expect(getFirstText(result)).toContain("parent: bd-epic");
	});
});

describe("wire schema", () => {
	it("exposes the op enum and typed fields", () => {
		const tool = createTool();
		const schema = toolWireSchema(tool);
		const properties = schema.properties as Record<string, unknown>;
		expect(properties.op).toBeDefined();
		expect(properties.priority).toBeDefined();
		expect(schema.required).toEqual(["op"]);
	});
});
