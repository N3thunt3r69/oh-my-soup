/**
 * Host-side handler for the eval `agent()` helper.
 */
import { type } from "@oh-my-pi/omptype";
import {
	buildStructuredSubagentRecoveryHint,
	type EffectiveSubagentPolicy,
	reserveStructuredSubagentId,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentIsolationControls,
	type StructuredSubagentRequest,
	type StructuredSubagentResult,
	type StructuredSubagentSchemaMode,
} from "../task/structured-subagent";
import type { AgentProgress, SingleResult } from "../task/types";
import type { NestedRepoPatch } from "../task/worktree";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { withBridgeTimeoutPause } from "./bridge-timeout";
import type { JsStatusEvent } from "./js/shared/types";
// Import review tools for side effects (registers subagent tool handlers).
import "../tools/review";

/** Synthetic bridge name reserved for the `agent()` helper across both runtimes. */
export const EVAL_AGENT_BRIDGE_NAME = "__agent__";

const agentArgsSchema = type({
	prompt: "string>0",
	"agent?": "string>0",
	"label?": "string",
	"schema?": "unknown",
	"schemaMode?": "'permissive' | 'strict'",
	"isolated?": "boolean",
	"apply?": "boolean",
	"merge?": "boolean",
	"handle?": "boolean",
	"detach?": "boolean",
	"+": "delete",
});

interface EvalAgentArgs {
	prompt: string;
	agent?: string;
	label?: string;
	schema?: unknown;
	schemaMode?: StructuredSubagentSchemaMode;
	isolated?: boolean;
	apply?: boolean;
	merge?: boolean;
	handle?: boolean;
	detach?: boolean;
}

export interface EvalAgentBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalAgentResult {
	text: string;
	/** Parsed structured data returned by the child executor. */
	data?: unknown;
	/** Set when the call was admitted with `detach`: the child runs as a background job and no result was awaited. */
	detached?: true;
	details: {
		agent: string;
		id: string;
		/** Background job id for a detached admission (matches the agent id). */
		jobId?: string;
		/** Caller-supplied label echoed back for detached admissions. */
		label?: string;
		model?: string | string[];
		structured: boolean;
		schemaSource?: "caller" | "agent" | "session";
		schemaMode?: StructuredSubagentSchemaMode;
		schemaStatus?: "valid" | "invalid";
		isolated?: boolean;
		patchPath?: string;
		branchName?: string;
		nestedPatches?: NestedRepoPatch[];
		changesApplied?: boolean | null;
		isolationSummary?: string;
	};
}

function parseAgentArgs(args: unknown): EvalAgentArgs {
	const result = agentArgsSchema(args);
	if (result instanceof type.errors) {
		throw new ToolError(`agent() received invalid arguments: ${result.summary}`);
	}
	return result;
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function emitProgressStatus(emitStatus: ((event: JsStatusEvent) => void) | undefined, progress: AgentProgress): void {
	if (!emitStatus) return;
	const preview = (progress.assignment ?? progress.task ?? "").split("\n")[0]?.slice(0, 120);
	emitStatus({
		op: "agent",
		id: progress.id,
		agent: progress.agent,
		status: progress.status,
		lastIntent: progress.lastIntent,
		currentTool: progress.currentTool,
		currentToolArgs: progress.currentToolArgs,
		taskPreview: preview || undefined,
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
		cost: progress.cost,
		durationMs: progress.durationMs,
		model: progress.resolvedModel,
	});
}

function buildSubagentFailureMessage(agentName: string, result: SingleResult): string {
	const abortReason = trimToUndefined(result.abortReason);
	if (result.aborted && abortReason) return abortReason;
	return (
		trimToUndefined(result.error) ??
		trimToUndefined(result.stderr) ??
		abortReason ??
		`agent() subagent '${agentName}' failed.`
	);
}

/** Normalize the caller's isolated/apply/merge flags into isolation controls. */
function buildIsolationControls(parsed: EvalAgentArgs): StructuredSubagentIsolationControls | undefined {
	if (!Object.hasOwn(parsed, "isolated") && !Object.hasOwn(parsed, "apply") && !Object.hasOwn(parsed, "merge")) {
		return undefined;
	}
	return {
		...(parsed.isolated !== undefined ? { requested: parsed.isolated } : {}),
		...(parsed.merge === false ? { merge: "patch" as const } : {}),
		...(parsed.apply !== undefined ? { apply: parsed.apply } : {}),
	};
}

/**
 * Admit a detached subagent: preflight and id reservation run inline so the
 * caller sees validation errors immediately, then execution is registered as
 * a background job on the session's AsyncJobManager — the same channel task
 * async spawns use, so the child shows up in `hub jobs` and its result
 * auto-delivers to the owning agent. The eval cell's abort signal is
 * deliberately NOT wired to the job: detached children outlive the cell and
 * are cancelled through the job manager instead.
 */
async function spawnDetachedEvalAgent(
	parsed: EvalAgentArgs,
	options: EvalAgentBridgeOptions,
): Promise<EvalAgentResult> {
	const session = options.session;
	const manager = session.settings.get("async.enabled") ? session.asyncJobManager : undefined;
	if (!manager) {
		throw new ToolError(
			"agent(detach) requires background jobs: enable `async.enabled` (with a registered job manager) or call agent() without detach.",
		);
	}
	const label = trimToUndefined(parsed.label);
	const isolation = buildIsolationControls(parsed);
	const request: StructuredSubagentRequest = {
		session,
		invocationKind: "eval",
		assignment: parsed.prompt,
		detached: true,
		...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
		...(Object.hasOwn(parsed, "schema") ? { outputSchema: parsed.schema } : {}),
		...(parsed.schemaMode !== undefined ? { schemaMode: parsed.schemaMode } : {}),
		...(isolation ? { isolation } : {}),
		// The finished child must stay reachable: agent://<id> needs retained
		// artifacts and keepAlive leaves an idle registry ref for hub follow-up,
		// matching task async spawns rather than eval's blocking one-shots.
		retainArtifacts: true,
		keepAlive: true,
		shareEvalSession: false,
	};
	let policy: EffectiveSubagentPolicy;
	try {
		policy = await resolveEffectiveSubagentPolicy(request);
	} catch (error) {
		if (error instanceof StructuredSubagentError) throw new ToolError(error.message);
		throw error;
	}
	const id = await reserveStructuredSubagentId(session, { label: label ?? "EvalAgent" });
	const ownerId = session.getAgentId?.() ?? undefined;
	const jobId = manager.register(
		"task",
		id,
		async ({ signal, reportProgress, markRunning }) => {
			markRunning();
			await reportProgress(`Running detached agent ${id}...`);
			let execution: StructuredSubagentResult;
			try {
				execution = await runStructuredSubagent({
					...request,
					identity: { id, ...(label !== undefined ? { label } : {}) },
					signal,
					onProgress: progress => {
						const intent = progress.lastIntent ? ` — ${progress.lastIntent}` : "";
						void reportProgress(`${id}: ${progress.status}${intent}`);
					},
				});
			} catch (error) {
				if (error instanceof StructuredSubagentError) throw new Error(error.message, { cause: error });
				throw error;
			}
			const { result, mergeSummary, changesApplied, artifactsDir } = execution;
			if (result.exitCode !== 0 || result.error || result.aborted) {
				const failureMessage = buildSubagentFailureMessage(policy.agentName, result)
					.replace(/<\/?system-notification>/g, "")
					.trim();
				const recoveryHint = policy.isIsolated
					? await buildStructuredSubagentRecoveryHint(result, artifactsDir)
					: "";
				throw new Error(`${failureMessage}${recoveryHint}`);
			}
			if (policy.isIsolated && changesApplied === false) {
				const summary = mergeSummary.replace(/<\/?system-notification>/g, "").trim();
				const recoveryHint = await buildStructuredSubagentRecoveryHint(result, artifactsDir);
				throw new Error(
					`agent(detach) isolated apply failed for ${result.id}${summary ? `: ${summary}` : ""}${recoveryHint}`,
				);
			}
			return `${result.output}${mergeSummary}\n\nDetached agent ${id} finished — full output at agent://${id}.`;
		},
		{
			id,
			agentId: id,
			...(ownerId !== undefined ? { ownerId } : {}),
		},
	);
	return {
		text: `Spawned detached agent ${id} (job ${jobId}). The result auto-delivers when it settles; poll via hub jobs or read agent://${id} afterwards.`,
		detached: true,
		details: { agent: policy.agentName, id, jobId, structured: false, ...(label !== undefined ? { label } : {}) },
	};
}

/**
 * Run a single subagent on behalf of an eval cell's `agent()` call.
 */
export async function runEvalAgent(args: unknown, options: EvalAgentBridgeOptions): Promise<EvalAgentResult> {
	const parsed = parseAgentArgs(args);
	const turnBudget = options.session.getTurnBudget?.();
	if (turnBudget?.hard && turnBudget.total !== null && turnBudget.spent >= turnBudget.total) {
		throw new ToolError(
			`agent() blocked: turn token budget exhausted (${turnBudget.spent}/${turnBudget.total} output tokens). Raise or drop the +Nk! ceiling to continue.`,
		);
	}
	if (parsed.detach) {
		return spawnDetachedEvalAgent(parsed, options);
	}
	const isolation = buildIsolationControls(parsed);

	try {
		const execution = await withBridgeTimeoutPause(
			options.emitStatus,
			() =>
				runStructuredSubagent({
					session: options.session,
					invocationKind: "eval",
					assignment: parsed.prompt,
					...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
					...(Object.hasOwn(parsed, "schema") ? { outputSchema: parsed.schema } : {}),
					...(parsed.schemaMode !== undefined ? { schemaMode: parsed.schemaMode } : {}),
					...(parsed.label !== undefined ? { identity: { label: parsed.label } } : {}),
					...(isolation ? { isolation } : {}),
					...(parsed.handle ? { retainArtifacts: true } : {}),
					keepAlive: false,
					// `maxRuntimeMs` is intentionally omitted: the executor then inherits
					// `task.maxRuntimeMs`, matching the task tool. Pinning it to 0 here
					// silently overrode the user's wall-clock cap for eval fan-outs.
					shareEvalSession: false,
					...(options.signal !== undefined ? { signal: options.signal } : {}),
					...(options.emitStatus
						? { onProgress: (progress: AgentProgress) => emitProgressStatus(options.emitStatus, progress) }
						: {}),
				}),
			{ deferExternalAbort: true },
		);
		const { result, policy, mergeSummary, changesApplied, artifactsDir } = execution;
		if (result.exitCode !== 0 || result.error || result.aborted) {
			const failureMessage = buildSubagentFailureMessage(policy.agentName, result)
				.replace(/<\/?system-notification>/g, "")
				.trim();
			const recoveryHint = policy.isIsolated ? await buildStructuredSubagentRecoveryHint(result, artifactsDir) : "";
			throw new ToolError(`${failureMessage}${recoveryHint}`);
		}
		if (policy.isIsolated && changesApplied === false) {
			const summary = mergeSummary.replace(/<\/?system-notification>/g, "").trim();
			const recoveryHint = await buildStructuredSubagentRecoveryHint(result, artifactsDir);
			throw new ToolError(
				`agent() isolated apply failed for ${result.id}${summary ? `: ${summary}` : ""}${recoveryHint}`,
			);
		}

		const structuredOutput = result.structuredOutput;
		const structured = structuredOutput?.source !== undefined && structuredOutput.source !== "none";
		if (structured && mergeSummary.includes("<system-notification>")) {
			const recoveryHint = await buildStructuredSubagentRecoveryHint(result, artifactsDir);
			throw new ToolError(
				`agent() isolated nested patch apply failed for ${result.id}: ${mergeSummary.replace(/<\/?system-notification>/g, "").trim()}${recoveryHint}`,
			);
		}

		const hasData = structured && structuredOutput !== undefined && Object.hasOwn(structuredOutput, "data");
		const data = structuredOutput?.data;
		const text = structured ? result.output : result.output + mergeSummary;
		const schemaSource = structuredOutput?.source === "none" ? undefined : structuredOutput?.source;
		const schemaMode = structured ? structuredOutput?.mode : undefined;
		const schemaStatus = structuredOutput?.status === "unavailable" ? undefined : structuredOutput?.status;

		const model = result.resolvedModel ?? policy.modelOverride;
		const nestedPatches = result.nestedPatches?.length ? result.nestedPatches : undefined;
		const isolationSummary = mergeSummary ? mergeSummary.trim() : undefined;
		return {
			text,
			...(hasData ? { data } : {}),
			details: {
				agent: result.agent,
				id: result.id,
				...(model !== undefined ? { model } : {}),
				structured,
				...(schemaSource !== undefined ? { schemaSource } : {}),
				...(schemaMode !== undefined ? { schemaMode } : {}),
				...(schemaStatus !== undefined ? { schemaStatus } : {}),
				...(policy.isIsolated ? { isolated: true, changesApplied } : {}),
				...(result.patchPath !== undefined ? { patchPath: result.patchPath } : {}),
				...(result.branchName !== undefined ? { branchName: result.branchName } : {}),
				...(nestedPatches !== undefined ? { nestedPatches } : {}),
				...(isolationSummary !== undefined ? { isolationSummary } : {}),
			},
		};
	} catch (error) {
		if (error instanceof StructuredSubagentError) throw new ToolError(error.message);
		throw error;
	}
}
