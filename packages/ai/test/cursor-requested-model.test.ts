import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-soup/pi-ai";
import { streamCursor } from "@oh-my-soup/pi-ai/providers/cursor";
import { streamSimple } from "@oh-my-soup/pi-ai/stream";
import type { Context, Model } from "@oh-my-soup/pi-ai/types";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import type { AgentRunRequest } from "@oh-my-soup/pi-catalog/discovery/cursor-gen/agent_pb";
import type { ModelSpec } from "@oh-my-soup/pi-catalog/types";

function cursorModel(id: string): Model<"cursor-agent"> {
	return buildModel({
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

function capture(model: Model<"cursor-agent">): Promise<AgentRunRequest> {
	const captured = Promise.withResolvers<AgentRunRequest>();
	streamCursor(model, { messages: [{ role: "user", content: "pong", timestamp: 0 }] } satisfies Context, {
		apiKey: "test-token",
		onPayload: payload => {
			if (payload && typeof payload === "object" && "$typeName" in payload) {
				captured.resolve(payload as AgentRunRequest);
			} else {
				captured.reject(new Error("Cursor payload was not an AgentRunRequest"));
			}
			throw new Error("stop after capturing Cursor payload");
		},
	});
	return captured.promise;
}

function captureSimple(model: Model<"cursor-agent">, reasoning?: Effort): Promise<AgentRunRequest> {
	const captured = Promise.withResolvers<AgentRunRequest>();
	streamSimple(
		model,
		{ messages: [{ role: "user", content: "pong", timestamp: 0 }] },
		{
			apiKey: "test-token",
			reasoning,
			onPayload: payload => {
				if (payload && typeof payload === "object" && "$typeName" in payload) {
					captured.resolve(payload as AgentRunRequest);
				} else {
					captured.reject(new Error("Cursor payload was not an AgentRunRequest"));
				}
				throw new Error("stop after capturing Cursor payload");
			},
		},
	);
	return captured.promise;
}

function collapsedCursorModel(fast: boolean): Model<"cursor-agent"> {
	const laneSuffix = fast ? "-fast" : "";
	return buildModel({
		id: `gpt-5.6-sol${laneSuffix}`,
		requestModelId: `gpt-5.6-sol-none${laneSuffix}`,
		name: `GPT-5.6 Sol${fast ? " Fast" : ""}`,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			effortRouting: {
				off: `gpt-5.6-sol-none${laneSuffix}`,
				[Effort.Low]: `gpt-5.6-sol-low${laneSuffix}`,
				[Effort.Medium]: `gpt-5.6-sol-medium${laneSuffix}`,
				[Effort.High]: `gpt-5.6-sol-high${laneSuffix}`,
				[Effort.XHigh]: `gpt-5.6-sol-xhigh${laneSuffix}`,
				[Effort.Max]: `gpt-5.6-sol-max${laneSuffix}`,
			},
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	} satisfies ModelSpec<"cursor-agent">);
}

describe("Cursor requestedModel wire shape", () => {
	it("splits an OpenAI reasoning sibling into base id plus reasoning parameter", async () => {
		const payload = await capture(cursorModel("gpt-5.4-mini-low"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.4-mini");
		expect(payload.requestedModel?.parameters).toEqual([expect.objectContaining({ id: "reasoning", value: "low" })]);
		expect(payload.modelDetails?.modelId).toBe("gpt-5.4-mini");
	});

	it("routes the selected effort from a collapsed catalog model", async () => {
		const payload = await captureSimple(collapsedCursorModel(false), Effort.XHigh);
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "xhigh" }),
		]);
	});

	it("preserves the fast lane while splitting its effort token", async () => {
		const payload = await captureSimple(collapsedCursorModel(true), Effort.High);
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol-fast");
		expect(payload.requestedModel?.parameters).toEqual([expect.objectContaining({ id: "reasoning", value: "high" })]);
	});

	it("leaves Cursor-native and non-OpenAI sibling ids unchanged", async () => {
		const cursorNative = await capture(cursorModel("cursor-composer-2.5"));
		expect(cursorNative.requestedModel?.modelId).toBe("cursor-composer-2.5");
		expect(cursorNative.requestedModel?.parameters).toEqual([]);

		const claude = await capture(cursorModel("claude-fable-5-low"));
		expect(claude.requestedModel?.modelId).toBe("claude-fable-5-low");
		expect(claude.requestedModel?.parameters).toEqual([]);
	});
});
