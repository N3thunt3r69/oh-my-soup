import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { OPENAI_DAYBREAK_CURATED_FALLBACK_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";

const DAYBREAK_EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];

describe("OpenAI Daybreak models", () => {
	test("curates the documented aliases and Cyber snapshot with standard API pricing", () => {
		const byId = Object.fromEntries(OPENAI_DAYBREAK_CURATED_FALLBACK_MODELS.map(model => [model.id, model]));
		expect(Object.keys(byId)).toEqual(["daybreak-blue-latest", "daybreak-red-latest", "gpt-5.6-cyber"]);
		expect(byId["daybreak-blue-latest"]).toMatchObject({
			name: "Daybreak Blue",
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 1_050_000,
			maxTokens: 128_000,
		});
		for (const id of ["daybreak-red-latest", "gpt-5.6-cyber"]) {
			expect(byId[id]).toMatchObject({
				cost: { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 },
				contextWindow: 400_000,
				maxTokens: 128_000,
			});
		}
	});

	test("exposes off and every GPT-5.6 wire effort on all Daybreak IDs", () => {
		const generated: ModelSpec<Api>[] = OPENAI_DAYBREAK_CURATED_FALLBACK_MODELS.map(model => ({
			...model,
			cost: { ...model.cost },
		}));
		applyGeneratedModelPolicies(generated);

		for (const spec of generated) {
			const model = buildModel(spec);
			expect(getSupportedEfforts(model)).toEqual(DAYBREAK_EFFORTS);
			expect(model.thinking?.requiresEffort).not.toBe(true);
			expect(model.compat).toMatchObject({
				supportsPromptCacheBreakpoints: true,
				supportsSamplingParams: false,
				reasoningDisableMode: "none-effort",
			});
			expect(model.applyPatchToolType).toBe("freeform");
			expect(model.supportsComputerUse).toBe(true);
		}
	});
});
