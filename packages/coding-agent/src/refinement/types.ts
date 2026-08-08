/**
 * /refine continual-harness types.
 *
 * A refinement pass reviews the recent trajectory and emits structured CRUD
 * ops over four entry kinds, each backed by an EXISTING omp store:
 *
 * - promptNote       -> project supplemental instructions (`.omp/AGENTS.md` managed block)
 * - memory           -> local memories learned-lessons file (`learned.md`)
 * - skillDescription -> isolated managed skill metadata (`~/.omp/agent/managed-skills/<name>/SKILL.md`)
 * - subagentSpec     -> refinement state store (`<state>/subagent-specs.json`)
 *
 * Every applied pass is appended to `<state>/refinements.jsonl` with enough
 * before-state to reverse it losslessly (`/refine rollback <id>`).
 */
import { type } from "@oh-my-pi/omptype";

export type RefinementKind = "promptNote" | "memory" | "skillDescription" | "subagentSpec";
export type RefinementAction = "add" | "update" | "remove";

export const REFINEMENT_KINDS: readonly RefinementKind[] = ["promptNote", "memory", "skillDescription", "subagentSpec"];

/** One CRUD op proposed by the refiner model. */
export const refinementOpSchema = type({
	action: "'add' | 'update' | 'remove'",
	kind: "'promptNote' | 'memory' | 'skillDescription' | 'subagentSpec'",
	"id?": type("string").describe("stable id for update/remove; optional for add"),
	"title?": type("string").describe("promptNote heading, skill description, or subagent spec description"),
	"content?": type("string").describe("note body, memory text, SKILL.md body, or subagent prompt"),
	"model?": type("string").describe("subagentSpec only: preferred model"),
	"reason?": type("string").describe("why this op is justified by the trajectory"),
});

export const refinementProposalSchema = type({
	summary: "string",
	rationale: "string",
	"expectedOutcome?": "string",
	ops: refinementOpSchema.array(),
});

export type RefinementOp = typeof refinementOpSchema.infer;
export type RefinementProposal = typeof refinementProposalSchema.infer;

/** Full state of one entry as it exists in its backing store. */
export interface RefinementEntrySnapshot {
	id: string;
	title?: string;
	content: string;
	model?: string;
}

/** An op after application, carrying lossless before/after entry state. */
export interface AppliedRefinementOp {
	action: RefinementAction;
	kind: RefinementKind;
	id: string;
	applied: boolean;
	error?: string;
	reason?: string;
	before?: RefinementEntrySnapshot;
	after?: RefinementEntrySnapshot;
}

/** Byte-exact file snapshot taken around a pass; `null` means "file absent". */
export interface RefinementFileSnapshot {
	before: string | null;
	after: string | null;
}

export type RefinementTrigger = "manual" | "auto:compact" | "auto:turnInterval" | "rollback";

/** One line of `<state>/refinements.jsonl`. */
export interface RefinementLogEntry {
	id: string;
	timestamp: string;
	trigger: RefinementTrigger;
	summary: string;
	/** Refiner rationale — the trajectory evidence backing the ops. */
	evidence: string;
	expectedOutcome?: string;
	ops: AppliedRefinementOp[];
	/** Byte-exact snapshots of every file the pass touched, keyed by absolute path. */
	files: Record<string, RefinementFileSnapshot>;
	rollbackOf?: string;
}

export function isRefinementLogEntry(value: unknown): value is RefinementLogEntry {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as RefinementLogEntry).id === "string" &&
		Array.isArray((value as RefinementLogEntry).ops)
	);
}
