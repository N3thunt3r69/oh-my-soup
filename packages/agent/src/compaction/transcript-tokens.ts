import type { AssistantMessage } from "@oh-my-soup/pi-ai";
import type { MessageCountOptions, Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import { calculateContextTokens, hasContextTokenUsage } from "./compaction";

/** A provider usage report that accounts for a prefix of the transcript. */
export interface TranscriptUsageAnchor {
	/** Index in the scanned array; messages at or before it are provider-accounted. */
	index: number;
	/** The anchoring assistant turn. */
	message: AssistantMessage;
	/** Conversation tokens the provider reported for that prompt. */
	tokens: number;
}

/** Whether this message's provider usage may anchor transcript accounting. */
export function isTranscriptUsageAnchor(message: AgentMessage): message is AssistantMessage {
	if (message.role !== "assistant") return false;
	const assistant = message as AssistantMessage;
	if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return false;
	return assistant.usage !== undefined && hasContextTokenUsage(assistant.usage);
}

/** Find the newest trustworthy provider usage report in the requested suffix. */
export function findTranscriptUsageAnchor(
	messages: readonly AgentMessage[],
	fromIndex = 0,
): TranscriptUsageAnchor | undefined {
	for (let index = messages.length - 1; index >= fromIndex; index--) {
		const message = messages[index];
		if (!isTranscriptUsageAnchor(message)) continue;
		return { index, message, tokens: calculateContextTokens(message.usage) };
	}
	return undefined;
}

export interface TranscriptTokenOptions {
	/** Ignore provider usage anchors before this index. */
	anchorFromIndex?: number;
	/** First message counted locally when no trustworthy anchor exists. */
	countFromIndex?: number;
	/** Exclude opaque reasoning payloads from locally counted messages. */
	excludeEncryptedReasoning?: boolean;
}

/** Provider-anchored total plus a local count of only the unaccounted tail. */
export function estimateTranscriptTokens(
	messages: readonly AgentMessage[],
	tokenizer: Tokenizer,
	options?: TranscriptTokenOptions,
): number {
	const estimateOptions: MessageCountOptions | undefined =
		options?.excludeEncryptedReasoning === true ? { excludeEncryptedReasoning: true } : undefined;
	const anchor = findTranscriptUsageAnchor(messages, options?.anchorFromIndex ?? 0);
	let total = anchor?.tokens ?? 0;
	for (let index = anchor ? anchor.index + 1 : (options?.countFromIndex ?? 0); index < messages.length; index++) {
		total += tokenizer.countMessage(messages[index], estimateOptions);
	}
	return total;
}
