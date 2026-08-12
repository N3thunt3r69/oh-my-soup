import { describe, expect, test } from "bun:test";
import { buildParams } from "@oh-my-soup/pi-ai/providers/openai-responses";
import type { Context } from "@oh-my-soup/pi-ai/types";
import { Effort } from "@oh-my-soup/pi-catalog/effort";
import { getBundledModel } from "@oh-my-soup/pi-catalog/models";

const DAYBREAK_MODEL_IDS = ["daybreak-blue-latest", "daybreak-red-latest", "gpt-5.6-cyber", "gpt-5.6-sol"];
const DAYBREAK_EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
const CONTEXT: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("OpenAI Daybreak Responses reasoning payload", () => {
	for (const id of DAYBREAK_MODEL_IDS) {
		test(`${id} serializes off and every supported thinking level`, () => {
			const model = getBundledModel<"openai-responses">("openai", id);
			if (!model) throw new Error(`openai/${id} must be in bundled models.json`);

			const disabled = buildParams(model, CONTEXT, { disableReasoning: true }, undefined);
			expect(disabled.params.reasoning).toEqual({ effort: "none" });

			for (const effort of DAYBREAK_EFFORTS) {
				const enabled = buildParams(model, CONTEXT, { reasoning: effort }, undefined);
				expect(enabled.params.reasoning).toEqual({ effort, summary: "auto" });
			}
		});
	}
});
