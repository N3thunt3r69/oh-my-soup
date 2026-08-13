/**
 * Beads tool — first-class wrapper around the `bd` CLI
 * (https://github.com/gastownhall/beads): a dependency-aware graph issue
 * tracker designed as persistent structured memory for coding agents.
 *
 * The tool activates only when the `bd` binary is installed AND the workspace
 * contains a `.beads/` database (i.e. the project opted in via `bd init`), so
 * it is zero-config in beads projects and absent everywhere else.
 *
 * All invocations run with `BD_JSON_ENVELOPE=1`; both the envelope shape
 * (`{schema_version, data}`) and the legacy raw array/object shapes are
 * accepted, so any bd version with `--json` support works.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-soup/omstype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-soup/pi-agent-core";
import { Text } from "@oh-my-soup/pi-tui";
import { $which, prompt, untilAborted } from "@oh-my-soup/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import beadsDescription from "../prompts/tools/beads.md" with { type: "text" };
import { framedBlock, renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { formatMoreItems } from "./render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";

const BD_COMMAND_TIMEOUT_MS = 120_000;
/** Client-side cap for list-like ops (`bd list` has no server-side pagination yet). */
const LIST_RESULT_CAP = 50;
/** Directory-walk bound for `.beads/` workspace detection. */
const WORKSPACE_WALK_LIMIT = 32;

const BEADS_READONLY_OPS: Record<string, true> = {
	ready: true,
	blocked: true,
	list: true,
	show: true,
	dep_tree: true,
	prime: true,
	stats: true,
};

const beadsSchema = type({
	op: type(
		"'ready' | 'blocked' | 'list' | 'show' | 'create' | 'update' | 'close' | 'dep_add' | 'dep_tree' | 'prime' | 'remember' | 'stats' | 'sync'",
	).describe("beads operation"),
	"id?": type("string").describe("issue id (update/close/dep_tree; the dependent child for dep_add)"),
	"ids?": type("string[]").describe("issue ids (show/close several at once)"),
	"title?": type("string").describe("issue title (create)"),
	"description?": type("string").describe("issue description (create/update)"),
	"issueType?": type("'bug' | 'feature' | 'task' | 'epic' | 'chore'").describe("issue type (create)"),
	"priority?": type("0 | 1 | 2 | 3 | 4").describe("priority: 0 critical … 4 backlog (create/update)"),
	"parent?": type("string").describe("parent epic id (create), or the blocking issue (dep_add)"),
	"deps?": type("string[]").describe("dependency links as 'type:id' or bare id (create), e.g. discovered-from:bd-12"),
	"claim?": type("boolean").describe("atomically claim: assignee + in_progress (update)"),
	"reason?": type("string").describe("close reason"),
	"notes?": type("string").describe("notes field (update)"),
	"design?": type("string").describe("design notes (create/update)"),
	"acceptance?": type("string").describe("acceptance criteria (create/update)"),
	"text?": type("string").describe("insight to store (remember)"),
	"status?": type("'open' | 'in_progress' | 'closed' | 'deferred'").describe("status filter (list)"),
	"limit?": type("number").describe("max results (ready/list)"),
});

type BeadsInput = typeof beadsSchema.infer;

/** Subset of the bd issue JSON contract the tool surfaces (unknown fields are ignored). */
export interface BeadsIssue {
	id: string;
	title: string;
	status: string;
	priority: number;
	issue_type: string;
	assignee?: string;
	owner?: string;
	parent?: string | null;
	labels?: string[];
	dependency_count?: number;
	dependent_count?: number;
	blocked_by?: Array<string | { id: string; title?: string; status?: string }>;
	description?: string;
	acceptance_criteria?: string;
	design?: string;
	notes?: string;
	created_at?: string;
	updated_at?: string;
	closed_at?: string;
}

export interface BeadsToolDetails {
	op: BeadsInput["op"];
	issues?: BeadsIssue[];
	text?: string;
	truncated?: boolean;
}

interface BdCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Read one string-valued field from an untrusted/partial object without asserting its shape. */
function readStringField(value: unknown, key: string): string | undefined {
	if (value !== null && typeof value === "object" && key in value) {
		const field = (value as Record<string, unknown>)[key];
		if (typeof field === "string") return field;
	}
	return undefined;
}

function unwrapEnvelope(value: unknown): unknown {
	if (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"schema_version" in value &&
		"data" in value
	) {
		return value.data;
	}
	return value;
}

/**
 * Humanize a bd failure. JSON-mode errors emit `{error, code?, hint?}` (most
 * to stderr, some to stdout); fall back to raw output.
 */
function formatBdFailure(args: readonly string[], stdout: string, stderr: string): string {
	for (const channel of [stderr, stdout]) {
		const trimmed = channel.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = unwrapEnvelope(JSON.parse(trimmed));
			const error = readStringField(parsed, "error");
			if (error) {
				const hint = readStringField(parsed, "hint");
				return hint ? `${error} (${hint})` : error;
			}
		} catch {
			// fall through to raw output
		}
	}
	const message = (stderr || stdout).trim();
	if (message.includes("schema version mismatch")) {
		return `${message}\nUpgrade the bd binary to match the database schema.`;
	}
	if (message.length > 0) return message;
	return `beads command failed: bd ${args.join(" ")}`;
}

export const bd = {
	/** Resolve the bd executable: `beads.binary` setting, else `bd` on PATH. */
	binary(session: ToolSession): string {
		const configured = session.settings.get("beads.binary")?.trim();
		return configured || "bd";
	},

	/** Check if the bd CLI is installed (or explicitly configured). */
	available(session: ToolSession): boolean {
		const configured = session.settings.get("beads.binary")?.trim();
		if (configured) return fs.existsSync(configured) || Boolean($which(configured));
		return Boolean($which("bd"));
	},

	/**
	 * Find the nearest ancestor of `cwd` containing a `.beads/` database, if
	 * any. The walk stops at the user's home directory: `~/.beads` is bd's
	 * user-level config dir, not a project database — treating it as one would
	 * light the tool up for every directory under `$HOME`.
	 */
	workspaceRoot(cwd: string): string | null {
		const home = path.resolve(os.homedir());
		let current = path.resolve(cwd);
		for (let depth = 0; depth < WORKSPACE_WALK_LIMIT; depth++) {
			if (current === home) return null;
			try {
				if (fs.statSync(path.join(current, ".beads")).isDirectory()) return current;
			} catch {
				// not here; keep walking up
			}
			const parentDir = path.dirname(current);
			if (parentDir === current) return null;
			current = parentDir;
		}
		return null;
	},

	/** Run a raw bd command. Does not throw on non-zero exit. */
	async run(session: ToolSession, args: string[], signal?: AbortSignal): Promise<BdCommandResult> {
		throwIfAborted(signal);
		const timeoutSignal = AbortSignal.timeout(BD_COMMAND_TIMEOUT_MS);
		const spawnSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			const child = Bun.spawn([bd.binary(session), ...args], {
				cwd: session.cwd,
				env: { ...Bun.env, BD_JSON_ENVELOPE: "1" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
				signal: spawnSignal,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			throwIfAborted(signal);
			if (timeoutSignal.aborted) {
				throw new ToolError(`beads command timed out after ${BD_COMMAND_TIMEOUT_MS / 1000}s: bd ${args.join(" ")}`);
			}
			return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
		} catch (error) {
			if (signal?.aborted) throw new ToolAbortError();
			if (error instanceof ToolError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("ENOENT") || message.includes("Executable not found")) {
				throw new ToolError(
					`beads CLI (${bd.binary(session)}) is not installed. Install it from https://github.com/gastownhall/beads and run \`bd init\` in the project.`,
				);
			}
			throw error;
		}
	},

	/** Run bd with `--json` semantics and parse stdout (envelope or legacy shape). */
	async json<T>(session: ToolSession, args: string[], signal?: AbortSignal): Promise<T> {
		const result = await bd.run(session, args, signal);
		if (result.exitCode !== 0) {
			throw new ToolError(formatBdFailure(args, result.stdout, result.stderr));
		}
		if (!result.stdout) {
			throw new ToolError("beads returned empty output.");
		}
		try {
			return unwrapEnvelope(JSON.parse(result.stdout)) as T;
		} catch {
			throw new ToolError("beads returned invalid JSON output.");
		}
	},

	/** Run bd and return stdout as text. Throws on non-zero exit. */
	async text(session: ToolSession, args: string[], signal?: AbortSignal): Promise<string> {
		const result = await bd.run(session, args, signal);
		if (result.exitCode !== 0) {
			throw new ToolError(formatBdFailure(args, result.stdout, result.stderr));
		}
		return result.stdout;
	},
};

const STATUS_GLYPHS: Record<string, string> = {
	open: "○",
	in_progress: "◐",
	blocked: "●",
	closed: "✓",
	deferred: "❄",
};

function formatIssueLine(issue: BeadsIssue): string {
	const glyph = STATUS_GLYPHS[issue.status] ?? "○";
	const parts = [glyph, issue.id, `[P${issue.priority}]`, `[${issue.issue_type}]`, issue.title];
	const qualifiers: string[] = [];
	if (issue.status === "in_progress") {
		const holder = issue.assignee || issue.owner;
		qualifiers.push(holder ? `claimed by ${holder}` : "in progress");
	}
	if (issue.blocked_by && issue.blocked_by.length > 0) {
		const blockers = issue.blocked_by.map(entry => (typeof entry === "string" ? entry : entry.id));
		qualifiers.push(`blocked by: ${blockers.join(", ")}`);
	}
	if (issue.parent) qualifiers.push(`parent: ${issue.parent}`);
	if (qualifiers.length > 0) parts.push(`(${qualifiers.join("; ")})`);
	return parts.join(" ");
}

function formatIssueDetail(issue: BeadsIssue): string {
	const lines = [formatIssueLine(issue)];
	if (issue.description?.trim()) lines.push("", issue.description.trim());
	if (issue.design?.trim()) lines.push("", `Design: ${issue.design.trim()}`);
	if (issue.acceptance_criteria?.trim()) lines.push("", `Acceptance: ${issue.acceptance_criteria.trim()}`);
	if (issue.notes?.trim()) lines.push("", `Notes: ${issue.notes.trim()}`);
	return lines.join("\n");
}

function issueListResult(
	op: BeadsInput["op"],
	issues: BeadsIssue[],
	emptyText: string,
	limit?: number,
): AgentToolResult<BeadsToolDetails> {
	const cap = limit && limit > 0 ? limit : LIST_RESULT_CAP;
	const visible = issues.slice(0, cap);
	const truncated = issues.length > visible.length;
	const lines = visible.map(formatIssueLine);
	if (truncated) lines.push(formatMoreItems(issues.length - visible.length, "issue"));
	return {
		content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : emptyText }],
		details: { op, issues: visible, truncated },
	};
}

function requireField(value: string | undefined, message: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new ToolError(message);
	return trimmed;
}

function collectIds(params: BeadsInput): string[] {
	const ids = [params.id, ...(params.ids ?? [])]
		.map(value => value?.trim())
		.filter((value): value is string => Boolean(value));
	return [...new Set(ids)];
}

export class BeadsTool implements AgentTool<typeof beadsSchema, BeadsToolDetails> {
	readonly name = "beads";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const op = readStringField(args, "op") ?? "";
		if (BEADS_READONLY_OPS[op]) return "read";
		return op === "sync" ? "exec" : "write";
	};
	readonly summary = "Track work in the project's beads (bd) dependency-aware issue graph";
	readonly loadMode = "discoverable";
	readonly label = "Beads";
	readonly description = prompt.render(beadsDescription);
	readonly parameters = beadsSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): BeadsTool | null {
		if (!bd.available(session)) return null;
		if (bd.workspaceRoot(session.cwd) === null) return null;
		return new BeadsTool(session);
	}

	async execute(
		_toolCallId: string,
		params: BeadsInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BeadsToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<BeadsToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "ready":
					return this.#executeReady(params, signal);
				case "blocked":
					return this.#executeBlocked(params, signal);
				case "list":
					return this.#executeList(params, signal);
				case "show":
					return this.#executeShow(params, signal);
				case "create":
					return this.#executeCreate(params, signal);
				case "update":
					return this.#executeUpdate(params, signal);
				case "close":
					return this.#executeClose(params, signal);
				case "dep_add":
					return this.#executeDepAdd(params, signal);
				case "dep_tree":
					return this.#executeTextOp(
						params.op,
						["dep", "tree", requireField(params.id, "dep_tree requires `id`.")],
						signal,
					);
				case "prime":
					return this.#executeTextOp(params.op, ["prime"], signal);
				case "remember":
					return this.#executeRemember(params, signal);
				case "stats":
					return this.#executeTextOp(params.op, ["stats"], signal);
				case "sync":
					return this.#executeSync(signal);
			}
		});
	}

	async #executeReady(params: BeadsInput, signal?: AbortSignal): Promise<AgentToolResult<BeadsToolDetails>> {
		const args = ["ready", "--json"];
		if (params.limit && params.limit > 0) args.push("--limit", String(Math.trunc(params.limit)));
		const issues = await bd.json<BeadsIssue[]>(this.session, args, signal);
		return issueListResult(
			params.op,
			issues,
			"No ready work — every open issue is blocked or claimed.",
			params.limit,
		);
	}

	async #executeBlocked(params: BeadsInput, signal?: AbortSignal): Promise<AgentToolResult<BeadsToolDetails>> {
		const issues = await bd.json<BeadsIssue[]>(this.session, ["blocked", "--json"], signal);
		return issueListResult(params.op, issues, "No blocked issues.", params.limit);
	}

	async #executeList(params: BeadsInput, signal?: AbortSignal): Promise<AgentToolResult<BeadsToolDetails>> {
		const args = ["list", "--json"];
		if (params.status) args.push("--status", params.status);
		const issues = await bd.json<BeadsIssue[]>(this.session, args, signal);
		return issueListResult(params.op, issues, "No issues found.", params.limit);
	}

	async #executeShow(params: BeadsInput, signal?: AbortSignal): Promise<AgentToolResult<BeadsToolDetails>> {
		const ids = collectIds(params);
		if (ids.length === 0) throw new ToolError("show requires `id` (or `ids`).");
		const issues = await bd.json<BeadsIssue[]>(this.session, ["show", ...ids, "--json"], signal);
		return {
			content: [{ type: "text", text: issues.map(formatIssueDetail).join("\n\n") || "Issue not found." }],
			details: { op: params.op, issues },
		};
	}

	async #executeCreate(params: BeadsInput, signal?: AbortSignal): Promise<AgentToolResult<BeadsToolDetails>> {
		const title = requireField(params.title, "create requires `title`.");
		const args = ["create", title, "--json", "-p", String(params.priority ?? 2)];
		if (params.issueType) args.push("-t", params.issueType);
		if (params.description?.trim()) args.push(`--description=${params.description}`);
		if (params.parent?.trim()) args.push("--parent", params.parent.trim());
		if (params.design?.trim()) args.push(`--design=${params.design}`);
		if (params.acceptance?.trim()) args.push(`--acceptance=${params.acceptance}`);
		for (const dep of params.deps ?? []) {
			if (dep.trim()) args.push("--deps", dep.trim());
		}
		const created = await bd.json<BeadsIssue>(this.session, args, signal);
		return {
			content: [{ type: "text", text: `Created ${formatIssueLine(created)}` }],
			details: { op: params.op, issues: [created] },
		};
	}

	async #executeUpdate(params: BeadsInput, signal?: AbortSignal): Promise<AgentToolResult<BeadsToolDetails>> {
		const id = requireField(params.id, "update requires `id`.");
		const args = ["update", id, "--json"];
		if (params.claim) args.push("--claim");
		if (params.title?.trim()) args.push("--title", params.title.trim());
		if (params.description !== undefined) args.push(`--description=${params.description}`);
		if (params.notes !== undefined) args.push(`--notes=${params.notes}`);
		if (params.design !== undefined) args.push(`--design=${params.design}`);
		if (params.acceptance !== undefined) args.push(`--acceptance=${params.acceptance}`);
		if (params.priority !== undefined) args.push("--priority", String(params.priority));
		if (args.length === 3) {
			throw new ToolError(
				"update requires at least one change (claim, title, description, notes, design, acceptance, priority).",
			);
		}
		const updated = await bd.json<BeadsIssue[]>(this.session, args, signal);
		const lines = updated.map(issue => `Updated ${formatIssueLine(issue)}`);
		return {
			content: [{ type: "text", text: lines.join("\n") || `Updated ${id}` }],
			details: { op: params.op, issues: updated },
		};
	}

	async #executeClose(params: BeadsInput, signal?: AbortSignal): Promise<AgentToolResult<BeadsToolDetails>> {
		const ids = collectIds(params);
		if (ids.length === 0) throw new ToolError("close requires `id` (or `ids`).");
		const args = ["close", ...ids, "--json"];
		if (params.reason?.trim()) args.push("--reason", params.reason.trim());
		const closed = await bd.json<BeadsIssue[]>(this.session, args, signal);
		const lines = closed.map(issue => `Closed ${formatIssueLine(issue)}`);
		return {
			content: [{ type: "text", text: lines.join("\n") || `Closed ${ids.join(", ")}` }],
			details: { op: params.op, issues: closed },
		};
	}

	async #executeDepAdd(params: BeadsInput, signal?: AbortSignal): Promise<AgentToolResult<BeadsToolDetails>> {
		const child = requireField(params.id, "dep_add requires `id` (the dependent issue).");
		const parent = requireField(params.parent, "dep_add requires `parent` (the issue it depends on).");
		const output = await bd.text(this.session, ["dep", "add", child, parent], signal);
		return {
			content: [{ type: "text", text: output || `${child} now depends on ${parent}.` }],
			details: { op: params.op, text: output },
		};
	}

	async #executeRemember(params: BeadsInput, signal?: AbortSignal): Promise<AgentToolResult<BeadsToolDetails>> {
		const insight = requireField(params.text, "remember requires `text` (the insight to store).");
		const output = await bd.text(this.session, ["remember", insight], signal);
		return {
			content: [{ type: "text", text: output || "Memory stored." }],
			details: { op: params.op, text: output },
		};
	}

	async #executeSync(signal?: AbortSignal): Promise<AgentToolResult<BeadsToolDetails>> {
		const pull = await bd.text(this.session, ["dolt", "pull"], signal);
		const push = await bd.text(this.session, ["dolt", "push"], signal);
		const text = [pull, push].filter(Boolean).join("\n") || "Beads database synced.";
		return {
			content: [{ type: "text", text }],
			details: { op: "sync", text },
		};
	}

	async #executeTextOp(
		op: BeadsInput["op"],
		args: string[],
		signal?: AbortSignal,
	): Promise<AgentToolResult<BeadsToolDetails>> {
		const output = await bd.text(this.session, args, signal);
		return {
			content: [{ type: "text", text: output || "(no output)" }],
			details: { op, text: output },
		};
	}
}

const RENDER_LINE_CAP = 12;

export const beadsToolRenderer = {
	renderCall(args: unknown, options: RenderResultOptions, uiTheme: Theme) {
		// Streaming partial args: every field may be absent or mistyped mid-delta.
		const meta: string[] = [];
		const op = readStringField(args, "op");
		const id = readStringField(args, "id");
		const title = readStringField(args, "title");
		if (op) meta.push(op);
		if (id) meta.push(id);
		if (title) meta.push(title);
		const header = renderStatusLine(
			{ icon: "pending", spinnerFrame: options?.spinnerFrame, title: "Beads", meta },
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: BeadsToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: unknown,
	) {
		const op = result.details?.op ?? readStringField(args, "op");
		const meta = op ? [op] : [];
		if (result.isError) {
			const errorText = result.content?.find(entry => entry.type === "text")?.text ?? "beads operation failed";
			const header = renderStatusLine({ icon: "error", title: "Beads", meta }, uiTheme);
			return framedBlock(uiTheme, width => ({ header, width, sections: [{ lines: errorText.split("\n") }] }));
		}
		const text = result.content?.find(entry => entry.type === "text")?.text ?? "";
		const lines = text.split("\n");
		const visible = lines.slice(0, RENDER_LINE_CAP);
		if (lines.length > visible.length) visible.push(formatMoreItems(lines.length - visible.length, "line"));
		const header = renderStatusLine({ icon: "done", title: "Beads", meta }, uiTheme);
		return framedBlock(uiTheme, width => ({ header, width, sections: [{ lines: visible }] }));
	},
};
