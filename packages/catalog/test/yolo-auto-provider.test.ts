import { describe, expect, test } from "bun:test";
import { createModelManager } from "@oh-my-soup/pi-catalog/model-manager";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-soup/pi-catalog/provider-models/descriptors";
import {
	YOLO_AUTO_STATIC_MODELS,
	yoloAutoModelManagerOptions,
} from "@oh-my-soup/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-soup/pi-catalog/types";

function yoloCatalogFetch(ids: string[]): FetchImpl {
	return async () => Response.json({ data: ids.map(id => ({ id, object: "model", owned_by: "yolo-auto" })) });
}

describe("Yolo-Auto provider", () => {
	test("registers the documented model and curated fallback", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === "yolo-auto");
		expect(descriptor).toMatchObject({
			defaultModel: "deepseek-flash-v4",
			dynamicModelsAuthoritative: true,
			catalogDiscovery: { envVars: ["YOLO_AUTO_API_KEY"] },
		});
		expect(DEFAULT_MODEL_PER_PROVIDER["yolo-auto"]).toBe("deepseek-flash-v4");
		expect(YOLO_AUTO_STATIC_MODELS[0]).toMatchObject({
			id: "deepseek-flash-v4",
			provider: "yolo-auto",
			baseUrl: "https://yolo-auto.com/v1",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsStore: false, supportsDeveloperRole: false, thinkingFormat: "chat-template" },
		});
	});

	test("discovers with bearer auth and preserves curated thinking over wire placeholders", async () => {
		const authorizations: Array<string | null> = [];
		const fetchImpl: FetchImpl = async (_input, init) => {
			authorizations.push(new Headers(init?.headers).get("authorization"));
			return Response.json({
				data: ["deepseek-flash-v4", "future-model"].map(id => ({ id, object: "model", owned_by: "yolo-auto" })),
			});
		};
		const options = yoloAutoModelManagerOptions({ apiKey: "yolo_test", fetch: fetchImpl });
		const models = await options.fetchDynamicModels?.();
		expect(authorizations).toEqual(["Bearer yolo_test"]);
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const flash = models?.find(model => model.id === "deepseek-flash-v4");
		expect(flash).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 131072,
			thinking: {
				mode: "effort",
				effortMap: { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
			},
			compat: { supportsStore: false, supportsDeveloperRole: false, thinkingFormat: "chat-template" },
		});
		expect(models?.find(model => model.id === "future-model")).toMatchObject({
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsStore: false, supportsDeveloperRole: false },
		});
	});
	test("inherits global model metadata while retaining flat-rate provider constraints", async () => {
		const models = await yoloAutoModelManagerOptions({
			apiKey: "yolo_test",
			fetch: yoloCatalogFetch(["deepseek-v4-pro"]),
		}).fetchDynamicModels?.();
		const inherited = models?.[0];
		expect(inherited).toMatchObject({
			id: "deepseek-v4-pro",
			provider: "yolo-auto",
			reasoning: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsStore: false, supportsDeveloperRole: false },
		});
		expect(inherited?.contextWindow).not.toBeNull();
	});

	test("authoritative discovery prunes retired curated ids", async () => {
		const manager = createModelManager(
			yoloAutoModelManagerOptions({ apiKey: "yolo_test", fetch: yoloCatalogFetch(["live-only"]) }),
		);
		const { models } = await manager.refresh("online");
		expect(models.map(model => model.id)).toEqual(["live-only"]);
	});

	test("curated metadata wins over a stale bundled-shaped static row", async () => {
		const stale = {
			...YOLO_AUTO_STATIC_MODELS[0],
			contextWindow: 262144,
			thinking: undefined,
			compat: undefined,
		} satisfies ModelSpec<"openai-completions">;
		const options = yoloAutoModelManagerOptions({
			apiKey: "yolo_test",
			fetch: yoloCatalogFetch(["deepseek-flash-v4"]),
		});
		const manager = createModelManager({ ...options, staticModels: [stale] });
		const { models } = await manager.refresh("online");
		expect(models[0]).toMatchObject({
			contextWindow: 131072,
			compat: { thinkingFormat: "chat-template", supportsStore: false },
		});
	});
});
