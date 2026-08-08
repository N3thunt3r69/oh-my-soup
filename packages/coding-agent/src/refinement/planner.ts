/**
 * The /refine LLM pass: one oneshot completion over the serialized recent
 * trajectory + current continual-harness state, returning structured CRUD ops.
 */
import { type } from "@oh-my-pi/omptype";
import { type ApiKey, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import refinerSystemPrompt from "./prompts/refiner-system.md" with { type: "text" };
import { type RefinementProposal, refinementProposalSchema } from "./types";

/** Output budget mirrors prime-agent's refiner cap, clamped to the model. */
const REFINEMENT_MAX_OUTPUT_TOKENS = 32_000;
/** Trajectory tail budget (chars) fed to the refiner. */
const CONVERSATION_TAIL_CHARS = 80_000;

const TRUNCATED_JSON_ERROR =
	"the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

/**
 * Whether a JSON candidate ends mid-value: an unterminated string, or unclosed
 * objects/arrays. A reply cut off by an exhausted output budget is incomplete
 * in this sense, while a complete-but-malformed reply is balanced.
 */
function isIncompleteJson(candidate: string): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const char of candidate) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") depth--;
	}
	return inString || depth > 0;
}

function parseJsonCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch (error) {
		// A truncated reply and a malformed one both fail here, and JSON.parse
		// describes the fragment rather than the cause. Name the cause instead.
		if (isIncompleteJson(candidate)) {
			throw new Error(TRUNCATED_JSON_ERROR);
		}
		throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Extract the JSON object from a refiner reply (bare, fenced, or prose-wrapped). */
export function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return parseJsonCandidate(trimmed);
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		return parseJsonCandidate(fenced[1].trim());
	}
	// Brace slicing recovers JSON wrapped in prose. On a reply truncated inside
	// the ops array it slices to an earlier op's closing brace, so a failure here
	// is diagnosed against the original text rather than the balanced fragment.
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return parseJsonCandidate(trimmed.slice(start));
		}
	}
	if (isIncompleteJson(trimmed)) {
		throw new Error(TRUNCATED_JSON_ERROR);
	}
	throw new Error("Refiner did not return a JSON object");
}

/** Parse + schema-validate a refiner reply into a proposal. */
export function parseRefinementProposal(text: string): RefinementProposal {
	const value = extractJsonObject(text);
	const result = refinementProposalSchema(value);
	if (result instanceof type.errors) {
		throw new Error(`Refiner JSON failed schema validation: ${result.summary}`);
	}
	return result;
}

export interface PlanRefinementOptions {
	/** Serialized recent trajectory (already through the session's LLM conversion). */
	conversationText: string;
	/** Compact overview of current entries per kind, with stable ids. */
	stateOverview: string;
	/** Compact prior refinement history. */
	historyText: string;
	model: Model;
	apiKey: ApiKey;
	metadata?: Record<string, unknown>;
	instructions?: string;
	signal?: AbortSignal;
}

/** Run the refiner oneshot and return its validated proposal (no state mutation). */
export async function planRefinementProposal(options: PlanRefinementOptions): Promise<RefinementProposal> {
	const userPrompt = [
		`<current_harness_state>\n${options.stateOverview}\n</current_harness_state>`,
		`<refinement_history>\n${options.historyText}\n</refinement_history>`,
		`<conversation>\n${options.conversationText.slice(-CONVERSATION_TAIL_CHARS)}\n</conversation>`,
		options.instructions ? `<user_refine_instructions>\n${options.instructions}\n</user_refine_instructions>` : "",
		"Return only JSON ops. If no useful op is justified, return an empty ops array with a rationale.",
	]
		.filter(Boolean)
		.join("\n\n");

	const response = await completeSimple(
		options.model,
		{
			systemPrompt: [prompt.render(refinerSystemPrompt)],
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{
			apiKey: options.apiKey,
			metadata: options.metadata,
			maxTokens: Math.min(options.model.maxTokens ?? REFINEMENT_MAX_OUTPUT_TOKENS, REFINEMENT_MAX_OUTPUT_TOKENS),
			signal: options.signal,
		},
	);

	if (response.stopReason === "error") {
		throw new Error(`Refinement failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(`Refinement failed: ${TRUNCATED_JSON_ERROR}`);
	}

	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map(content => content.text)
		.join("\n");
	return parseRefinementProposal(text);
}
