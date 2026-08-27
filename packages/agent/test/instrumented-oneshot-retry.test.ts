import { describe, expect, it } from "bun:test";
import { instrumentedCompleteSimple } from "@oh-my-soup/pi-agent-core/telemetry";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-soup/pi-ai/types";

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
} as unknown as Model<Api>;
const ctx = { systemPrompt: "s", messages: [] } as unknown as Context;

function reply(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

const overloaded = (): AssistantMessage =>
	reply({ stopReason: "error", errorStatus: 529, errorMessage: "overloaded_error: Overloaded" });

describe("instrumentedCompleteSimple transient retry", () => {
	it("does not retry when the opt-in is omitted", async () => {
		let calls = 0;
		const result = await instrumentedCompleteSimple(model, ctx, {} as SimpleStreamOptions, {
			telemetry: undefined,
			oneshotKind: "test_no_retry",
			completeImpl: () => {
				calls += 1;
				return Promise.resolve(overloaded());
			},
		});
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("reissues transient failures when explicitly enabled", async () => {
		let calls = 0;
		const result = await instrumentedCompleteSimple(model, ctx, {} as SimpleStreamOptions, {
			telemetry: undefined,
			oneshotKind: "test_retry",
			retry: { baseDelayMs: 1 },
			completeImpl: () => {
				calls += 1;
				return Promise.resolve(calls === 1 ? overloaded() : reply());
			},
		});
		expect(calls).toBe(2);
		expect(result.stopReason).toBe("stop");
	});

	it("preserves the final failure after exhaustion", async () => {
		let calls = 0;
		const result = await instrumentedCompleteSimple(model, ctx, {} as SimpleStreamOptions, {
			telemetry: undefined,
			oneshotKind: "test_exhausted",
			retry: { baseDelayMs: 1, maxAttempts: 2 },
			completeImpl: () => {
				calls += 1;
				return Promise.resolve(overloaded());
			},
		});
		expect(calls).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("overloaded_error");
	});

	it("clears response headers between attempts", async () => {
		const waits: number[] = [];
		let calls = 0;
		await instrumentedCompleteSimple(model, ctx, {} as SimpleStreamOptions, {
			telemetry: undefined,
			oneshotKind: "test_header_reset",
			retry: { baseDelayMs: 1, maxAttempts: 3, onRetry: info => waits.push(info.delayMs) },
			completeImpl: (_model, _ctx, options) => {
				calls += 1;
				if (calls === 1) {
					options.onResponse?.({ status: 429, headers: { "retry-after-ms": "5" } }, undefined as never);
				}
				return Promise.resolve(calls < 3 ? overloaded() : reply());
			},
		});
		expect(calls).toBe(3);
		expect(waits).toHaveLength(2);
		expect(waits[0]).toBe(5);
		expect(waits[1]).toBeLessThan(5);
	});
});
