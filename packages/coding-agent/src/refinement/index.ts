/**
 * /refine continual harness: audited, rollback-able trajectory-review loop.
 *
 * `runRefinementPass` plans ops with one oneshot LLM call and applies them to
 * omp's existing stores; `rollbackRefinement` reverse-applies a logged pass.
 * Every applied pass appends to `<state>/refinements.jsonl`.
 */
import {
	type KindBackend,
	REFINEMENT_BACKENDS,
	type RefinementStorePaths,
	readFileOrNull,
	slugifyEntryId,
} from "./backends";
import { appendRefinementLogEntry, loadRefinementLog } from "./log";
import { type PlanRefinementOptions, planRefinementProposal } from "./planner";
import {
	type AppliedRefinementOp,
	REFINEMENT_KINDS,
	type RefinementEntrySnapshot,
	type RefinementFileSnapshot,
	type RefinementLogEntry,
	type RefinementOp,
	type RefinementProposal,
	type RefinementTrigger,
} from "./types";

export {
	getPromptNotesPath,
	getRefinementLogPath,
	getRefinementStateDir,
	getSubagentSpecsPath,
	listSubagentSpecs,
	type RefinementStorePaths,
	resolveRefinementStorePaths,
	type SubagentSpec,
} from "./backends";
export { loadRefinementLog } from "./log";
export { parseRefinementProposal } from "./planner";
export * from "./types";

/** Ids that would target the immutable base system prompt (prime invariant). */
const BASE_PROMPT_IDS: Record<string, true> = {
	"base-system-prompt": true,
	base_system_prompt: true,
	"system-prompt": true,
	system_prompt: true,
	"base-prompt": true,
};

const MAX_OVERVIEW_CONTENT_CHARS = 240;

function compactText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Validate one op against the base-prompt invariant and per-kind field
 * contract. Returns an error string, or undefined when the op is applicable.
 */
export function validateRefinementOp(
	op: RefinementOp,
	id: string,
	before: RefinementEntrySnapshot | undefined,
): string | undefined {
	if (op.kind === "promptNote" && BASE_PROMPT_IDS[id]) {
		return "the base system prompt is immutable and cannot be refined";
	}
	if (op.action !== "add" && !op.id) return `${op.action} requires id`;
	if (op.action === "add" && before) return "entry already exists";
	if (op.action !== "add" && !before) return "entry not found";
	if (op.action !== "remove" && !op.content && !before?.content) return `${op.action} requires content`;
	if (
		op.action === "add" &&
		(op.kind === "skillDescription" || op.kind === "subagentSpec" || op.kind === "promptNote") &&
		!op.title
	) {
		return `add ${op.kind} requires title`;
	}
	return undefined;
}

/** Apply validated ops to their backends, recording lossless before/after state. */
export async function applyRefinementOps(
	paths: RefinementStorePaths,
	ops: readonly RefinementOp[],
): Promise<{ applied: AppliedRefinementOp[]; files: Record<string, RefinementFileSnapshot> }> {
	const applied: AppliedRefinementOp[] = [];
	const beforeBytes = new Map<string, string | null>();
	const touched = new Set<string>();

	for (const op of ops) {
		const backend: KindBackend | undefined = REFINEMENT_BACKENDS[op.kind];
		if (!backend) {
			applied.push({
				action: op.action,
				kind: op.kind,
				id: op.id ?? "",
				applied: false,
				error: `unsupported kind ${String(op.kind)}`,
				reason: op.reason,
			});
			continue;
		}
		let id: string;
		try {
			id = backend.normalizeId(op.id ?? (op.action === "add" ? slugifyEntryId(op.title ?? op.kind, op.kind) : ""));
		} catch (error) {
			applied.push({
				action: op.action,
				kind: op.kind,
				id: op.id ?? "",
				applied: false,
				error: error instanceof Error ? error.message : String(error),
				reason: op.reason,
			});
			continue;
		}

		const before = await backend.read(paths, id);
		const validationError = validateRefinementOp(op, id, before);
		if (validationError) {
			applied.push({
				action: op.action,
				kind: op.kind,
				id,
				applied: false,
				error: validationError,
				reason: op.reason,
				before,
			});
			continue;
		}

		// Snapshot every file this op touches BEFORE the first mutation so the
		// pass-level snapshot captures pristine pre-pass bytes.
		for (const filePath of backend.filesFor(paths, id)) {
			if (!beforeBytes.has(filePath)) beforeBytes.set(filePath, await readFileOrNull(filePath));
			touched.add(filePath);
		}

		try {
			if (op.action === "remove") {
				await backend.remove(paths, id);
				applied.push({ action: op.action, kind: op.kind, id, applied: true, reason: op.reason, before });
				continue;
			}
			const after: RefinementEntrySnapshot = {
				id,
				title: op.title ?? before?.title,
				content: op.content ?? before?.content ?? "",
				model: op.model ?? before?.model,
			};
			await backend.write(paths, after);
			applied.push({ action: op.action, kind: op.kind, id, applied: true, reason: op.reason, before, after });
		} catch (error) {
			applied.push({
				action: op.action,
				kind: op.kind,
				id,
				applied: false,
				error: error instanceof Error ? error.message : String(error),
				reason: op.reason,
				before,
			});
		}
	}

	const files: Record<string, RefinementFileSnapshot> = {};
	for (const filePath of touched) {
		files[filePath] = { before: beforeBytes.get(filePath) ?? null, after: await readFileOrNull(filePath) };
	}
	return { applied, files };
}

function newPassId(): string {
	return `refine_${new Date()
		.toISOString()
		.replace(/[^0-9]/g, "")
		.slice(0, 17)}`;
}

/** Apply a proposal, append the audit entry, and return it. */
export async function applyRefinementProposal(
	paths: RefinementStorePaths,
	proposal: RefinementProposal,
	options: { trigger: RefinementTrigger; rollbackOf?: string },
): Promise<RefinementLogEntry> {
	const { applied, files } = await applyRefinementOps(paths, proposal.ops);
	const entry: RefinementLogEntry = {
		id: newPassId(),
		timestamp: new Date().toISOString(),
		trigger: options.trigger,
		summary: proposal.summary,
		evidence: proposal.rationale,
		expectedOutcome: proposal.expectedOutcome,
		ops: applied,
		files,
		rollbackOf: options.rollbackOf,
	};
	await appendRefinementLogEntry(paths, entry);
	return entry;
}

export interface RunRefinementPassOptions extends Omit<PlanRefinementOptions, "stateOverview" | "historyText"> {
	paths: RefinementStorePaths;
	trigger: RefinementTrigger;
}

/** Compact per-kind overview of current entries, with stable ids for the refiner. */
export async function buildStateOverview(paths: RefinementStorePaths): Promise<string> {
	const lines: string[] = [];
	for (const kind of REFINEMENT_KINDS) {
		const entries = await REFINEMENT_BACKENDS[kind].list(paths);
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, 40)) {
			const title = entry.title ? ` ${compactText(entry.title, 120)}` : "";
			lines.push(`- [${entry.id}]${title}: ${compactText(entry.content, MAX_OVERVIEW_CONTENT_CHARS)}`);
		}
		if (entries.length > 40) lines.push(`- +${entries.length - 40} more ${kind} entries`);
	}
	return lines.join("\n");
}

function historyForPrompt(history: RefinementLogEntry[]): string {
	if (history.length === 0) return "No prior refinement history.";
	return history
		.slice(-20)
		.map(item => {
			const ops = item.ops
				.map(op => `${op.applied ? "applied" : "failed"} ${op.action} ${op.kind}:${op.id}`)
				.join(", ");
			const rollback = item.rollbackOf ? ` rollbackOf=${item.rollbackOf}` : "";
			return `[${item.id}]${rollback} ${item.summary}\n${ops || "no ops"}`;
		})
		.join("\n\n");
}

/** Full manual/auto pass: plan via the refiner oneshot, apply, log. */
export async function runRefinementPass(options: RunRefinementPassOptions): Promise<RefinementLogEntry> {
	const { paths, trigger, ...planOptions } = options;
	const history = await loadRefinementLog(paths);
	const proposal = await planRefinementProposal({
		...planOptions,
		stateOverview: await buildStateOverview(paths),
		historyText: historyForPrompt(history),
	});
	return applyRefinementProposal(paths, proposal, { trigger });
}

/**
 * Reverse-apply the pass recorded under `targetId`.
 *
 * Fast path: when every file the pass touched still carries the pass's exact
 * after-bytes, the recorded before-bytes are restored — byte-identical prior
 * state by construction. Otherwise falls back to entry-wise reversal through
 * the backends so later unrelated edits survive.
 */
export async function rollbackRefinement(paths: RefinementStorePaths, targetId: string): Promise<RefinementLogEntry> {
	const history = await loadRefinementLog(paths);
	const target = history.find(item => item.id === targetId);
	if (!target) throw new Error(`Refinement ${targetId} not found`);
	if (history.some(item => item.rollbackOf === targetId)) {
		throw new Error(`Refinement ${targetId} was already rolled back`);
	}

	const filePaths = Object.keys(target.files);
	let byteExact = filePaths.length > 0;
	for (const filePath of filePaths) {
		if ((await readFileOrNull(filePath)) !== target.files[filePath].after) {
			byteExact = false;
			break;
		}
	}

	if (byteExact) {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const files: Record<string, RefinementFileSnapshot> = {};
		for (const filePath of filePaths) {
			const snapshot = target.files[filePath];
			if (snapshot.before === null) {
				await fs.rm(filePath, { force: true });
			} else {
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await fs.writeFile(filePath, snapshot.before, "utf8");
			}
			files[filePath] = { before: snapshot.after, after: snapshot.before };
		}
		const entry: RefinementLogEntry = {
			id: newPassId(),
			timestamp: new Date().toISOString(),
			trigger: "rollback",
			summary: `Rollback refinement ${targetId} (byte-exact file restore)`,
			evidence: `Restored recorded pre-pass bytes for ${filePaths.length} file(s).`,
			ops: [...target.ops]
				.reverse()
				.filter(op => op.applied)
				.map(op => reverseOpRecord(op)),
			files,
			rollbackOf: targetId,
		};
		await appendRefinementLogEntry(paths, entry);
		return entry;
	}

	// Entry-wise reversal: reconstruct inverse ops from recorded before-state.
	const inverseOps: RefinementOp[] = [];
	for (const op of [...target.ops].reverse()) {
		if (!op.applied) continue;
		if (op.before) {
			inverseOps.push({
				// Re-adding a removed entry keeps its original id via the explicit id field.
				action: op.action === "remove" ? "add" : "update",
				kind: op.kind,
				id: op.id,
				title: op.before.title,
				content: op.before.content,
				model: op.before.model,
				reason: `Rollback ${targetId}`,
			});
		} else if (op.after) {
			inverseOps.push({ action: "remove", kind: op.kind, id: op.id, reason: `Rollback ${targetId}` });
		}
	}
	const proposal: RefinementProposal = {
		summary: `Rollback refinement ${targetId}`,
		rationale: `Reverse-applies the entry states recorded in refinement ${targetId}.`,
		expectedOutcome: "Faulty refinement ops are reverted.",
		ops: inverseOps,
	};
	return applyRefinementProposal(paths, proposal, { trigger: "rollback", rollbackOf: targetId });
}

function reverseOpRecord(op: AppliedRefinementOp): AppliedRefinementOp {
	if (op.action === "remove") {
		return { action: "add", kind: op.kind, id: op.id, applied: true, before: undefined, after: op.before };
	}
	if (op.before) {
		return { action: "update", kind: op.kind, id: op.id, applied: true, before: op.after, after: op.before };
	}
	return { action: "remove", kind: op.kind, id: op.id, applied: true, before: op.after, after: undefined };
}

/** Human-readable /refine log listing (newest first). */
export function formatRefinementLog(history: readonly RefinementLogEntry[], limit = 10): string {
	if (history.length === 0) return "No refinements recorded for this project.";
	const lines: string[] = [];
	for (const entry of [...history].reverse().slice(0, limit)) {
		const ok = entry.ops.filter(op => op.applied);
		const failed = entry.ops.length - ok.length;
		const opsText = ok.map(op => `${op.action} ${op.kind}:${op.id}`).join(", ") || "no applied ops";
		const suffix = failed > 0 ? ` (${failed} failed)` : "";
		const rollback = entry.rollbackOf ? ` [rollback of ${entry.rollbackOf}]` : "";
		lines.push(`${entry.id} — ${entry.timestamp} (${entry.trigger})${rollback}`);
		lines.push(`  ${compactText(entry.summary, 160)}`);
		lines.push(`  ops: ${opsText}${suffix}`);
	}
	if (history.length > limit) lines.push(`… ${history.length - limit} older entries (see refinements.jsonl)`);
	return lines.join("\n");
}
