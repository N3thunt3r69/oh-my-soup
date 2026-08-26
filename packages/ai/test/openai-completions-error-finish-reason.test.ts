// Regression coverage for gateways (OpenRouter, Vercel AI Gateway, …) that
// report upstream model failures as a bare `finish_reason: "error"` — e.g.
// Gemini MALFORMED_FUNCTION_CALL behind an OpenAI-compat endpoint. The mapped
// error message must match the session retry classifier's transient-transport
// pattern (`provider.?returned.?error` in agent-session's
// #isTransientTransportErrorMessage) so the turn is auto-retried instead of
// stopping with a pinned error banner.
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-soup/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-soup/pi-ai/types";
import { getBundledModel } from "@oh-my-soup/pi-catalog/models";

// Mirrors the transient-transport alternative the session retry gate matches on.
const RETRYABLE_PATTERN = /provider.?returned.?error/i;

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createSseFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) {
					const data = typeof event === "string" ? event : JSON.stringify(event);
					controller.enqueue(encoder.encode(`data: ${data}\n\n`));
				}
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return mockFetch as typeof fetch;
}

function completionChunk(extra: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-error-finish",
		object: "chat.completion.chunk",
		created: 0,
		model: completionsModel.id,
		...extra,
	};
}

describe("finish_reason: error", () => {
	it("maps to a retryable error message", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
	}, 10_000);

	it("stays an error even when the stream carried tool calls", async () => {
		// The user-visible failure mode: the model garbles a tool call, the
		// gateway ends the stream with `finish_reason: "error"`. Tool-call
		// promotion (stop → toolUse) must not paper over the error finish.
		const fetchMock = createSseFetch([
			completionChunk({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: '{"pattern":"x"}' },
								},
							],
						},
					},
				],
			}),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
	}, 10_000);
});

describe("finish_reason: insufficient_system_resource", () => {
	it("maps to a retryable error message", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "insufficient_system_resource" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
	}, 10_000);
});

describe("[DONE] without finish_reason", () => {
	const doneTerminatedCases: Array<[string, unknown[]]> = [
		[
			"content followed directly by [DONE]",
			[
				completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
				completionChunk({ choices: [{ index: 0, delta: { content: "lo" } }] }),
				"[DONE]",
			],
		],
		[
			"null finish_reason followed by [DONE]",
			[
				completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] }),
				completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: null }] }),
				"[DONE]",
			],
		],
		[
			"empty choices followed by [DONE]",
			[
				completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] }),
				completionChunk({ choices: [] }),
				"[DONE]",
			],
		],
	];

	for (const [label, events] of doneTerminatedCases) {
		it(`finalizes cleanly: ${label}`, async () => {
			const result = await streamOpenAICompletions(completionsModel, baseContext(), {
				apiKey: "test-key",
				fetch: createSseFetch(events),
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(result.errorMessage).toBeUndefined();
			expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		}, 10_000);
	}

	it("promotes a [DONE]-terminated tool-call turn to toolUse", async () => {
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch([
				completionChunk({
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_1",
										type: "function",
										function: { name: "read", arguments: '{"path":"README.md"}' },
									},
								],
							},
						},
					],
				}),
				"[DONE]",
			]),
		}).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content.some(block => block.type === "toolCall")).toBe(true);
	}, 10_000);
});

describe("premature stream closure", () => {
	it("fails without emitting a duplicate block end", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: { content: "lo" } }] }),
		]);

		const eventTypes: string[] = [];
		let errorMessage: string | undefined;
		for await (const event of streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		})) {
			eventTypes.push(event.type);
			if (event.type === "error") errorMessage = event.error.errorMessage;
		}

		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "error"]);
		expect(errorMessage).toContain("finish_reason");
	}, 10_000);

	it("still retries a genuinely empty close", async () => {
		let attempts = 0;
		async function fetchMock(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
			attempts++;
			const events =
				attempts === 1
					? []
					: [
							completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] }),
							completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
							"[DONE]",
						];
			return createSseFetch(events)(_input, _init);
		}

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock as typeof fetch,
		}).result();

		expect(attempts).toBeGreaterThan(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
	}, 10_000);
});

describe("case-insensitive finish_reason", () => {
	it("maps STOP to a clean stop", async () => {
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch([
				completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
				completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "STOP" }] }),
				"[DONE]",
			]),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	}, 10_000);

	it("maps MAX_TOKENS to length", async () => {
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch([
				completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
				completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "MAX_TOKENS" }] }),
				"[DONE]",
			]),
		}).result();

		expect(result.stopReason).toBe("length");
		expect(result.errorMessage).toBeUndefined();
	}, 10_000);

	it("retains the raw unknown reason in diagnostics", async () => {
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch([
				completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
				completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "CUSTOM_REASON" }] }),
				"[DONE]",
			]),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider finish_reason: CUSTOM_REASON");
	}, 10_000);

	it("does not throw while diagnosing a non-string reason", async () => {
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch([
				completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
				completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: 42 }] }),
				"[DONE]",
			]),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider finish_reason: 42");
	}, 10_000);
});
