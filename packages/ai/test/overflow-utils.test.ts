import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isContextOverflow } from "@oh-my-pi/pi-ai/error";

function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow - model_context_window_exceeded", () => {
	it("detects model_context_window_exceeded in finish_reason error message", () => {
		const message = createErrorMessage("Provider finish_reason: model_context_window_exceeded");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("detects raw model_context_window_exceeded in error message", () => {
		const message = createErrorMessage("model_context_window_exceeded");
		expect(isContextOverflow(message)).toBe(true);
	});
	it("detects empty Ollama length completion guidance", () => {
		const message = createErrorMessage(
			"Model returned no content: prompt filled the context window; raise Ollama num_ctx or shorten the prompt.",
		);
		expect(isContextOverflow(message)).toBe(true);
	});
});

describe("isContextOverflow - HTTP 413 variants", () => {
	it("detects generic 413 payload-too-large errors", () => {
		const message = createErrorMessage("413 Request Entity Too Large: payload too large for request body");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("detects Anthropic request size overflow wording", () => {
		const message = createErrorMessage("Request exceeds the maximum size allowed by this model");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("does not classify unrelated 413 errors as overflow", () => {
		const message = createErrorMessage("413 Forbidden");
		expect(isContextOverflow(message)).toBe(false);
	});
});

describe("isContextOverflow - 400/413 no-body (Cerebras, Mistral, proxy wrappers)", () => {
	it("detects bare '400 status code (no body)'", () => {
		expect(isContextOverflow(createErrorMessage("400 status code (no body)"))).toBe(true);
	});

	it("detects bare '413 status code (no body)'", () => {
		expect(isContextOverflow(createErrorMessage("413 status code (no body)"))).toBe(true);
	});

	it("detects '400 (no body)' without 'status code' word", () => {
		expect(isContextOverflow(createErrorMessage("400 (no body)"))).toBe(true);
	});

	// Regression: api.synthetic.new wraps upstream HF 400-no-body in a JSON envelope.
	// finalizeErrorMessage transforms the response to "400 status code: {JSON}" where
	// the JSON value contains the inner "400 status code (no body)" text.
	it('detects wrapped proxy envelope: \'400 status code: {"error":"... 400 status code (no body)"}\'', () => {
		const errorMessage = '400 status code: {"error":"Error from inference backend: 400 status code (no body)"}';
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(true);
	});

	it("detects when status code phrase is embedded deeper in the message", () => {
		const errorMessage = "Upstream rejected request: 400 status code (no body)";
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(true);
	});

	it("does not classify unrelated 400 errors as overflow", () => {
		expect(isContextOverflow(createErrorMessage("400 Bad Request: invalid API key"))).toBe(false);
	});

	it("does not classify 429 (rate limit) as overflow", () => {
		expect(isContextOverflow(createErrorMessage("429 status code (no body)"))).toBe(false);
	});
});

describe("isContextOverflow - provider patterns", () => {
	it("detects Mistral prompt-too-large wording", () => {
		const message = createErrorMessage(
			"Prompt contains 300735 tokens and 0 images, which is too large for model with 131072 maximum context length",
		);
		expect(isContextOverflow(message)).toBe(true);
	});

	it("detects Ollama explicit overflow error", () => {
		const message = createErrorMessage("prompt too long; exceeded max context length by 4821 tokens");
		expect(isContextOverflow(message)).toBe(true);
	});
});

describe("isContextOverflow - non-overflow exclusions", () => {
	it("does not classify Bedrock throttling as overflow despite 'Too many tokens' wording", () => {
		const message = createErrorMessage("ThrottlingException: Too many tokens, please wait before trying again.");
		expect(isContextOverflow(message)).toBe(false);
	});

	it("does not classify formatted Bedrock throttling prefix as overflow", () => {
		const message = createErrorMessage("Throttling error: Too many tokens, please wait before trying again.");
		expect(isContextOverflow(message)).toBe(false);
	});

	it("does not classify rate-limit wording as overflow even with token-limit phrasing", () => {
		const message = createErrorMessage("rate limit reached: token limit exceeded for this minute");
		expect(isContextOverflow(message)).toBe(false);
	});

	it("does not classify 'too many requests' as overflow", () => {
		const message = createErrorMessage("429 too many requests: reduce the length of the messages");
		expect(isContextOverflow(message)).toBe(false);
	});
});

describe("isContextOverflow - silent overflow (usage exceeds window)", () => {
	function createStopMessage(input: number, cacheRead: number): AssistantMessage {
		return {
			...createErrorMessage(""),
			stopReason: "stop",
			errorMessage: undefined,
			usage: {
				input,
				output: 50,
				cacheRead,
				cacheWrite: 0,
				totalTokens: input + cacheRead + 50,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	}

	it("detects a successful response whose input + cacheRead exceeds the context window", () => {
		expect(isContextOverflow(createStopMessage(150_000, 60_000), 200_000)).toBe(true);
	});

	it("does not flag a successful response within the context window", () => {
		expect(isContextOverflow(createStopMessage(100_000, 50_000), 200_000)).toBe(false);
	});

	it("does not flag without a context window to compare against", () => {
		expect(isContextOverflow(createStopMessage(150_000, 60_000))).toBe(false);
	});
});
