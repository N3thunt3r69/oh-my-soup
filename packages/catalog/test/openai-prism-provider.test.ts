import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { Effort } from "@oh-my-soup/pi-catalog/effort";
import { clampThinkingLevelForModel, requireSupportedEffort } from "@oh-my-soup/pi-catalog/model-thinking";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-soup/pi-catalog/provider-models";
import { OPENAI_PRISM_STATIC_MODELS } from "@oh-my-soup/pi-catalog/provider-models/openai-compat";

describe("OpenAI Prism catalog", () => {
	test("clamps model selection to Prism's effort ladder instead of inheriting Codex-only efforts", () => {
		const models = OPENAI_PRISM_STATIC_MODELS.map(spec => buildModel(spec));
		const selected = models.find(model => model.id === DEFAULT_MODEL_PER_PROVIDER["openai-prism"]);
		if (!selected) throw new Error("Prism's default model is missing from its source catalog");

		expect(clampThinkingLevelForModel(selected, Effort.Minimal)).toBe(Effort.Low);
		expect(
			Object.fromEntries(models.map(model => [model.id, clampThinkingLevelForModel(model, Effort.Max)])),
		).toEqual({
			"gpt-6-astra": Effort.XHigh,
			"gpt-5.6-sol": Effort.XHigh,
			"gpt-5.6-terra": Effort.XHigh,
		});
		expect(() => requireSupportedEffort(selected, Effort.Max)).toThrow("is not supported");
	});
});
