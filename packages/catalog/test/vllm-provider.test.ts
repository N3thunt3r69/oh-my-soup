import { describe, expect, test } from "bun:test";
import { vllmModelManagerOptions } from "@oh-my-soup/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-soup/pi-catalog/types";

describe("vLLM provider discovery", () => {
	test("lights up the reasoning dial for Qwen 3.8+ despite silent /v1/models metadata", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "qwen3.8-27b", object: "model", max_model_len: 262144 },
						{ id: "qwen2.5-coder-7b", object: "model", max_model_len: 131072 },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const options = vllmModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models?.find(model => model.id === "qwen3.8-27b")).toMatchObject({
			provider: "vllm",
			api: "openai-completions",
			reasoning: true,
			contextWindow: 262144,
		});
		expect(models?.find(model => model.id === "qwen2.5-coder-7b")?.reasoning).toBe(false);
	});
});
