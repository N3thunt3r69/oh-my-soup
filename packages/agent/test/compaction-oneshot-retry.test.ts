import { describe, expect, it } from "bun:test";
import { generateSummary } from "@oh-my-soup/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-soup/pi-agent-core/types";
import type { AssistantMessage, Model, Usage } from "@oh-my-soup/pi-ai/types";

const emptyUsage = (): Usage =>
	({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}) as Usage;

const model = {
	id: "claude-sonnet-4-6",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	maxTokens: 8192,
} as unknown as Model;

const apiKey = "test-key";
const messages = [{ role: "user", content: "summarize this session", timestamp: 0 }] as unknown as AgentMessage[];

function overloaded(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: "overloaded_error: Overloaded",
		errorStatus: 529,
		timestamp: 0,
	} as AssistantMessage;
}

function summary(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage;
}

describe("SummaryOptions.oneshotRetry", () => {
	it("retries transient failures by default for manual compaction", async () => {
		let calls = 0;
		const text = await generateSummary(messages, model, 10_000, apiKey, undefined, undefined, undefined, {
			completeImpl: () => {
				calls += 1;
				return Promise.resolve(calls === 1 ? overloaded() : summary("recovered summary"));
			},
		});

		expect(calls).toBe(2);
		expect(text).toContain("recovered summary");
	});

	it("makes exactly one attempt when the caller owns the retry loop", async () => {
		let calls = 0;
		const attempt = generateSummary(messages, model, 10_000, apiKey, undefined, undefined, undefined, {
			oneshotRetry: false,
			completeImpl: () => {
				calls += 1;
				return Promise.resolve(overloaded());
			},
		});

		await expect(attempt).rejects.toThrow();
		expect(calls).toBe(1);
	});
});
