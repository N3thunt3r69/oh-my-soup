import type { Model } from "@oh-my-soup/pi-ai";
import type { ModelTokenizer } from "@oh-my-soup/pi-catalog/types";
import { countTokens as countTokensNative, Encoding } from "@oh-my-soup/pi-natives";
import { stringifyJson } from "@oh-my-soup/pi-utils";
import * as snapcompact from "@oh-my-soup/snapcompact";
import { isEstimateCacheable, messageEstimateVersion } from "./compaction/message-cache";
import type { AgentMessage } from "./types";

const testEnv = Bun.env.NODE_ENV === "test";
const accurate = process.env.PI_TOKENIZER_ACCURATE === "1" && !testEnv;

const NATIVE_ENCODING: Record<ModelTokenizer, Encoding> = {
	"claude-v3": Encoding.ClaudeV3,
	"claude-v47": Encoding.ClaudeV47,
	"claude-v5": Encoding.ClaudeV5,
	"claude-v5-sonnet": Encoding.ClaudeV5Sonnet,
	qwen3: Encoding.Qwen3,
	"deepseek-v3": Encoding.DeepSeekV3,
	"kimi-k2": Encoding.KimiK2,
	glm5: Encoding.Glm5,
};

/** Maps catalog-resolved tokenizer policy to the native implementation. */
export function tokenizerEncodingForModel(model: Pick<Model, "tokenizer"> | null | undefined): Encoding | null {
	return model?.tokenizer ? NATIVE_ENCODING[model.tokenizer] : null;
}

export type TokenCountMode = "strict" | "approximate" | "upperbound";

export interface MessageCountOptions {
	/**
	 * Exclude opaque provider reasoning payloads from compaction-floor counts.
	 * Providers bill those payloads on replay, but their local byte size does not
	 * reliably represent the provider's token charge.
	 */
	excludeEncryptedReasoning?: boolean;
}

export interface TokenBudgetCheck {
	fits: boolean;
	tokens: number;
	/** Whether the exact native tokenizer ran after the byte bound failed. */
	exact: boolean;
}

interface MessageEstimate {
	version: number;
	default?: number;
	floored?: number;
}

const IMAGE_TOKEN_ESTIMATE = 1200;

function byteEstimate(text: string): number {
	return (Buffer.byteLength(text, "utf-8") + 3) >> 2;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function sumFragments(text: string | string[], measure: (fragment: string) => number): number {
	return Array.isArray(text) ? text.reduce((sum, fragment) => sum + measure(fragment), 0) : measure(text);
}

/**
 * Immutable, model-scoped local tokenizer. Known catalog families use their
 * exact embedded vocabulary; unknown families retain the cheap byte estimate
 * unless strict or explicitly configured for accurate counting.
 */
export class Tokenizer {
	readonly #encoding: Encoding | null;
	#estimates = new WeakMap<AgentMessage, MessageEstimate>();

	constructor(model?: Pick<Model, "tokenizer"> | null) {
		this.#encoding = tokenizerEncodingForModel(model);
	}

	get encoding(): Encoding | null {
		return this.#encoding;
	}

	countTokens(text: string | string[], mode: TokenCountMode = "approximate"): number {
		if (mode === "strict") return countTokensNative(text, this.#encoding);
		if (!testEnv && this.#encoding !== null) return countTokensNative(text, this.#encoding);
		if (accurate) return countTokensNative(text);
		return sumFragments(text, mode === "upperbound" ? byteLength : byteEstimate);
	}

	/**
	 * Prove a budget fit with the byte-length upper bound first, invoking the
	 * exact native tokenizer only when the bound itself exceeds the budget.
	 */
	checkTokenBudget(text: string | string[], budget: number): TokenBudgetCheck {
		const bound = sumFragments(text, byteLength);
		if (bound <= budget) return { fits: true, tokens: bound, exact: false };
		const tokens = this.countTokens(text, "strict");
		return { fits: tokens <= budget, tokens, exact: true };
	}

	countMessage(message: AgentMessage, options?: MessageCountOptions): number {
		const floored = options?.excludeEncryptedReasoning === true;
		if (!isEstimateCacheable(message)) return this.#measureMessage(message, floored);

		const version = messageEstimateVersion(message);
		let estimate = this.#estimates.get(message);
		if (estimate === undefined || estimate.version !== version) {
			estimate = { version };
			this.#estimates.set(message, estimate);
		}
		const cached = floored ? estimate.floored : estimate.default;
		if (cached !== undefined) return cached;

		const measured = this.#measureMessage(message, floored);
		if (floored) estimate.floored = measured;
		else estimate.default = measured;
		return measured;
	}

	countMessages(messages: readonly AgentMessage[], options?: MessageCountOptions): number {
		let total = 0;
		for (const message of messages) total += this.countMessage(message, options);
		return total;
	}

	#measureMessage(message: AgentMessage, excludeEncryptedReasoning: boolean): number {
		const fragments: string[] = [];
		let extra = 0;
		const role: string = message.role;
		if (role === "bashExecution") {
			if ("command" in message && typeof message.command === "string") fragments.push(message.command);
			if ("output" in message && typeof message.output === "string") fragments.push(message.output);
			return fragments.length === 0 ? 0 : this.countTokens(fragments);
		}

		switch (message.role) {
			case "user": {
				const content: string | Array<{ type: string; text?: string }> = message.content;
				if (typeof content === "string") {
					fragments.push(content);
				} else {
					for (const block of content) {
						if (block.type === "text" && block.text) fragments.push(block.text);
					}
				}
				break;
			}
			case "assistant":
				for (const block of message.content) {
					if (block.type === "text") {
						fragments.push(block.text);
					} else if (block.type === "thinking") {
						fragments.push(block.thinking);
						if (block.thinkingSignature && !excludeEncryptedReasoning) fragments.push(block.thinkingSignature);
					} else if (block.type === "toolCall") {
						fragments.push(block.name, stringifyJson(block.arguments) ?? "null");
					} else if (block.type === "redactedThinking") {
						if (!excludeEncryptedReasoning) fragments.push(block.data);
					} else if (block.type === "anthropicServerTool") {
						if (!excludeEncryptedReasoning) fragments.push(stringifyJson(block.block) ?? "null");
					}
				}
				break;
			case "hookMessage":
			case "toolResult":
				if (typeof message.content === "string") {
					fragments.push(message.content);
				} else {
					for (const block of message.content) {
						if (block.type === "text" && block.text) fragments.push(block.text);
						else if (block.type === "image") extra += IMAGE_TOKEN_ESTIMATE;
					}
				}
				break;
			case "branchSummary":
			case "compactionSummary":
				fragments.push(message.summary);
				if (message.role === "compactionSummary") {
					if (message.blocks) {
						for (const block of message.blocks) {
							if (block.type === "text") fragments.push(block.text);
							else extra += snapcompact.FRAME_TOKEN_ESTIMATE;
						}
					} else if (message.images) {
						extra += message.images.length * snapcompact.FRAME_TOKEN_ESTIMATE;
					}
				}
				break;
			default:
				return 0;
		}

		return fragments.length === 0 ? extra : extra + this.countTokens(fragments);
	}
}
