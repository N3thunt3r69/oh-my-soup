import { describe, expect, test } from "bun:test";
import { vercelAiGatewayModelManagerOptions } from "@oh-my-soup/pi-catalog/provider-models/openai-compat";

describe("Vercel AI Gateway provider", () => {
	test("caps Muse Spark contributor output allowance while preserving its context window", async () => {
		const contributorId = "meta/muse-spark-1.2-contributor";
		const controlId = "anthropic/claude-sonnet-4-5-20250929";
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					{
						id: contributorId,
						object: "model",
						owned_by: "meta",
						tags: ["tool-use", "reasoning", "vision"],
						context_window: 1_048_576,
						max_tokens: 1_048_576,
						pricing: { input: 0.0000001, output: 0.0000002 },
					},
					{
						id: controlId,
						object: "model",
						owned_by: "anthropic",
						tags: ["tool-use", "reasoning"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000003, output: 0.000015 },
					},
				],
			})) as unknown as typeof fetch;

		const models = await vercelAiGatewayModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		const byId = new Map((models ?? []).map(model => [model.id, model]));
		expect(byId.get(contributorId)?.contextWindow).toBe(1_048_576);
		expect(byId.get(contributorId)?.maxTokens).toBe(131_072);
		expect(byId.get(controlId)?.contextWindow).toBe(200_000);
		expect(byId.get(controlId)?.maxTokens).toBe(8192);
	});
});
