// Fireworks can abort mid-generation with an HTTP 400 whose body is shaped
// like a request-validation error but reports a replay-safe model-side numerical
// fault. Drive the real completions path so status/body propagation and persisted
// AssistantMessage reclassification remain covered together.
import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-soup/pi-ai/error";
import { streamOpenAICompletions } from "@oh-my-soup/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-soup/pi-ai/types";
import { getBundledModel } from "@oh-my-soup/pi-catalog/models";

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return { messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] };
}

function jsonErrorFetch(status: number, body: unknown): FetchImpl {
	return async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
}

describe("Fireworks mid-generation NaN 400", () => {
	it("surfaces a retryable provider error through the completions path", async () => {
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: jsonErrorFetch(400, {
				error: {
					object: "error",
					type: "invalid_request_error",
					code: "invalid_request_error",
					message:
						"Floating point NaN (not-a-number) is detected in generation. This is a model-side numerical error.",
				},
			}),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(AIError.retriable(result.errorId)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
		const reclassified = AIError.classifyMessage({ errorId: result.errorId, errorMessage: result.errorMessage });
		expect(AIError.retriable(reclassified)).toBe(true);
	}, 10_000);

	it("keeps genuine request-validation failures terminal", async () => {
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: jsonErrorFetch(400, {
				error: { type: "invalid_request_error", message: "Invalid value for 'temperature': must be <= 2." },
			}),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(AIError.retriable(result.errorId)).toBe(false);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(false);
		const reclassified = AIError.classifyMessage({ errorId: result.errorId, errorMessage: result.errorMessage });
		expect(AIError.retriable(reclassified)).toBe(false);
	}, 10_000);
});
