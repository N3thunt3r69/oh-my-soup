import { describe, expect, test } from "bun:test";
import { buildParams } from "@oh-my-soup/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, Model } from "@oh-my-soup/pi-ai/types";
import { buildOpenAIResponsesCompat } from "@oh-my-soup/pi-catalog/compat/openai";
import { Effort } from "@oh-my-soup/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-soup/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-soup/pi-catalog/models";

// Pins fix #2 of the compaction effort-override bug. Models that reason
// natively but reject the wire `reasoning.effort` param (e.g.
// `xai-oauth/grok-build`, `compat.supportsReasoningEffort: false` on
// openai-responses*) are encoded at build time as `thinking: undefined` —
// "thinks, but exposes no control surface". `resolveOpenAiReasoningEffort`
// returns undefined for them instead of tripping `requireSupportedEffort`
// (the old user-visible "Compaction failed: Thinking effort high is not
// supported by xai-oauth/grok-build. Supported efforts:" with an empty list),
// and the wire-side `omitReasoningEffort` gate (stream.ts) remains the single
// source of truth for the actual strip.
describe("effort-dial-less reasoner encoding (regression)", () => {
	test("xai-oauth/grok-build reasons but carries no thinking config", () => {
		const grokBuild = getBundledModel("xai-oauth", "grok-build");
		if (!grokBuild) throw new Error("xai-oauth/grok-build must be in bundled models.json");
		expect(grokBuild.reasoning).toBe(true);
		expect(grokBuild.thinking).toBeUndefined();
		expect(getSupportedEfforts(grokBuild)).toEqual([]);
	});

	test("xai-oauth/grok-4.3 keeps its effort dial", () => {
		const grok43 = getBundledModel("xai-oauth", "grok-4.3");
		if (!grok43) throw new Error("xai-oauth/grok-4.3 must be in bundled models.json");
		expect(grok43.thinking).toBeDefined();
		expect(getSupportedEfforts(grok43).length).toBeGreaterThan(0);
	});

	test("xai-oauth/grok-4.20-0309-reasoning reasons but carries no thinking config", () => {
		const grokR = getBundledModel("xai-oauth", "grok-4.20-0309-reasoning");
		if (!grokR) throw new Error("xai-oauth/grok-4.20-0309-reasoning must be in bundled models.json");
		expect(grokR.reasoning).toBe(true);
		expect(grokR.thinking).toBeUndefined();
	});

	test("the no-dial encoding stays scoped to openai-responses*", () => {
		const claude = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!claude) throw new Error("anthropic/claude-sonnet-4-6 must be in bundled models.json");
		expect(claude.thinking).toBeDefined();
	});
});

const singleUserContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("xAI Responses reasoning payload (regression)", () => {
	test("xai-oauth/grok-4.5 leaves reasoning unset when no reasoning was requested", () => {
		const grok45 = getXaiOAuthGrok45();
		const { params } = buildParams(grok45, singleUserContext, undefined, undefined);

		expect(params.reasoning).toBeUndefined();
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	test("xai-oauth/grok-4.5 omits unsupported reasoning summary", () => {
		const grok45 = getXaiOAuthGrok45();
		const { params } = buildParams(grok45, singleUserContext, { reasoning: Effort.High }, undefined);

		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	test("paid xai/grok-4.5 requests encrypted reasoning without a summary", () => {
		const grok45 = buildPaidXaiModel("grok-4.5", true);
		const { params } = buildParams(grok45, singleUserContext, { reasoning: Effort.High }, undefined);

		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	test("paid xai Responses omit penalties for reasoning and non-reasoning models", () => {
		for (const model of [buildPaidXaiModel("grok-4.5", true), buildPaidXaiModel("grok-2", false)]) {
			const { params } = buildParams(
				model,
				singleUserContext,
				{ reasoning: model.reasoning ? Effort.High : undefined, presencePenalty: 0.4, temperature: 0.2 },
				undefined,
			);

			expect(params, model.id).not.toHaveProperty("presence_penalty");
			expect(params.temperature, model.id).toBe(0.2);
		}
	});

	test("paid and OAuth grok-4.5 clamp minimal reasoning effort to low", () => {
		for (const model of [buildPaidXaiModel("grok-4.5", true), getXaiOAuthGrok45()]) {
			const { params } = buildParams(model, singleUserContext, { reasoning: Effort.Minimal }, undefined);
			expect(params.reasoning, model.provider).toEqual({ effort: "low" });
		}
	});

	test("paid and OAuth grok-4.5 replay encrypted reasoning on the next turn", () => {
		for (const model of [buildPaidXaiModel("grok-4.5", true), getXaiOAuthGrok45()]) {
			const { params } = buildParams(model, followUpContextWithEncryptedReasoning(model), undefined, undefined);

			expect(params.include, model.provider).toContain("reasoning.encrypted_content");
			expect(findEncryptedReasoning(params.input), model.provider).toEqual({
				type: "reasoning",
				id: "rs_xai_next_turn",
				encrypted_content: "enc_next_turn",
			});
		}
	});
});

function getXaiOAuthGrok45(): Model<"openai-responses"> {
	const bundled = getBundledModel<"openai-responses">("xai-oauth", "grok-4.5");
	if (!bundled) throw new Error("xai-oauth/grok-4.5 must be in bundled models.json");
	return {
		...bundled,
		compat: buildOpenAIResponsesCompat({
			id: bundled.id,
			name: bundled.name,
			provider: bundled.provider,
			baseUrl: bundled.baseUrl,
			reasoning: bundled.reasoning,
		}),
	};
}

function buildPaidXaiModel(id: string, reasoning: boolean): Model<"openai-responses"> {
	const template = getXaiOAuthGrok45();
	return {
		...template,
		id,
		name: id,
		provider: "xai",
		reasoning,
		thinking: reasoning ? template.thinking : undefined,
		compat: buildOpenAIResponsesCompat({
			id,
			name: id,
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning,
		}),
	};
}

function followUpContextWithEncryptedReasoning(model: Model<"openai-responses">): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "internal plan",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: "rs_xai_next_turn",
					encrypted_content: "enc_next_turn",
				}),
			},
			{ type: "text", text: "done" },
		],
		api: "openai-responses",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	return {
		messages: [
			{ role: "user", content: "first", timestamp: 0 },
			assistant,
			{ role: "user", content: "continue", timestamp: 2 },
		],
	};
}

function findEncryptedReasoning(input: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(input)) return undefined;
	return input.find(item => {
		if (!item || typeof item !== "object") return false;
		const candidate = item as { type?: unknown; encrypted_content?: unknown };
		return candidate.type === "reasoning" && typeof candidate.encrypted_content === "string";
	}) as Record<string, unknown> | undefined;
}
