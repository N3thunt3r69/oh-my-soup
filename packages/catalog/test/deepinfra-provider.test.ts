import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-soup/pi-catalog/effort";
import { createModelManager } from "@oh-my-soup/pi-catalog/model-manager";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-soup/pi-catalog/provider-models/descriptors";
import { deepinfraModelManagerOptions } from "@oh-my-soup/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-soup/pi-catalog/types";

function catalogFixture(): Response {
	return Response.json({
		data: [
			{
				id: "vendor/vision-thinker",
				metadata: {
					context_length: 262144,
					max_tokens: 131072,
					pricing: { input_tokens: 0.68, output_tokens: 3.4, cache_read_tokens: 0.136 },
					tags: ["chat", "vision", "reasoning_effort"],
				},
			},
			{
				id: "vendor/plain-chat",
				metadata: {
					context_length: 131072,
					max_tokens: 131072,
					pricing: { input_tokens: 0.09, output_tokens: 0.18 },
					tags: ["chat"],
				},
			},
			{ id: "vendor/embedder", metadata: { tags: ["embed"] } },
		],
	});
}

describe("DeepInfra provider", () => {
	test("registers public authoritative discovery and the authenticated default", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === "deepinfra");
		expect(descriptor).toMatchObject({
			defaultModel: "deepseek-ai/DeepSeek-V4-Flash-0731",
			dynamicModelsAuthoritative: true,
			catalogDiscovery: { envVars: ["DEEPINFRA_API_KEY"], allowUnauthenticated: true },
		});
		expect(DEFAULT_MODEL_PER_PROVIDER.deepinfra).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
	});

	test("maps tagged chat metadata, pricing and modality while preserving server priority", async () => {
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const fetchImpl: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
			return catalogFixture();
		};
		const models = await deepinfraModelManagerOptions({ apiKey: "di-key", fetch: fetchImpl }).fetchDynamicModels?.();
		expect(requests).toEqual([
			{
				url: "https://api.deepinfra.com/v1/openai/models?filter=with_meta&sort_by=omp",
				authorization: "Bearer di-key",
			},
		]);
		expect(models?.map(model => model.id)).toEqual(["vendor/vision-thinker", "vendor/plain-chat"]);
		expect(models?.[0]).toMatchObject({
			provider: "deepinfra",
			input: ["text", "image"],
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
			cost: { input: 0.68, output: 3.4, cacheRead: 0.136, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 131072,
		});
		expect(models?.[1]?.maxTokens).toBeNull();
	});

	test("keeps live modality removal authoritative through manager merging", async () => {
		const staticModel = {
			id: "vendor/plain-chat",
			name: "Plain Chat",
			api: "openai-completions",
			provider: "deepinfra",
			baseUrl: "https://api.deepinfra.com/v1/openai",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 16384,
		} satisfies ModelSpec<"openai-completions">;
		const manager = createModelManager({
			...deepinfraModelManagerOptions({ fetch: async () => catalogFixture() }),
			staticModels: [staticModel],
		});
		const { models } = await manager.refresh("online");
		expect(models.find(model => model.id === "vendor/plain-chat")?.input).toEqual(["text"]);
	});
});
