import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-soup/pi-catalog/model-manager";
import { PROVIDER_DESCRIPTORS } from "@oh-my-soup/pi-catalog/provider-models/descriptors";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
} from "@oh-my-soup/pi-catalog/provider-models/openai-compat";

const LIVE_FREE_MODEL_IDS = [
	"deepseek-v4-flash-free",
	"hy3-free",
	"mimo-v2.5-free",
	"nemotron-3-ultra-free",
	"north-mini-code-free",
] as const;

const LIVE_PAID_MODEL_IDS = ["claude-opus-4-8", "gpt-5.5"] as const;

function modelListResponse(ids: readonly string[]): Response {
	return Response.json({
		object: "list",
		data: ids.map(id => ({ id, object: "model", owned_by: "opencode" })),
	});
}

describe("OpenCode provider discovery", () => {
	test("treats the OpenCode model endpoints as authoritative catalogs", () => {
		for (const providerId of ["opencode-go", "opencode-zen"]) {
			const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === providerId);
			expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		}
		expect(opencodeGoModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
		expect(opencodeZenModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
	});

	test("routes opencode-go deepseek-v4-flash to the responses API", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(item => item.providerId === "opencode-go");
		// stencil.so lists deepseek-v4-flash without provider.npm, so it would
		// fall through to openai-completions — but the Go gateway does not serve
		// this model at /zen/go/v1/chat/completions while /zen/go/v1/responses
		// works (user-verified against the live gateway, 2026-08-08).
		expect(descriptor?.resolveApi?.("deepseek-v4-flash", { tool_call: true })).toEqual({
			api: "openai-responses",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
		// Flash only: deepseek-v4-pro serves fine on chat completions.
		expect(descriptor?.resolveApi?.("deepseek-v4-pro", { tool_call: true })).toEqual({
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
	});

	test("pins gateway-only Muse Spark ids to Responses and invalidates stale routes", async () => {
		const options = opencodeGoModelManagerOptions({
			apiKey: "test-key",
			fetch: async () => modelListResponse(["muse-spark-1.2", "muse-spark-1.2-contributor", "kimi-k3"]),
		});
		const models = await options.fetchDynamicModels?.();
		const byId = new Map((models ?? []).map(model => [model.id, model]));
		for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor"]) {
			expect(byId.get(id)).toMatchObject({
				api: "openai-responses",
				baseUrl: "https://opencode.ai/zen/go/v1",
			});
		}
		expect(byId.get("kimi-k3")).toMatchObject({ api: "openai-completions" });
		expect(options.dropCachedModelIdsOnStaticMismatch).toContain("muse-spark-1.2-contributor");
	});

	test("routes gateway-first ids via sibling and billing-variant evidence", async () => {
		const options = opencodeGoModelManagerOptions({
			apiKey: "test-key",
			fetch: async () =>
				modelListResponse(["gpt-5.5", "deepseek-v4-flash-free", "minimax-m2.5-free", "brand-new-model"]),
		});
		const models = await options.fetchDynamicModels?.();
		const apiById = new Map((models ?? []).map(model => [model.id, model.api]));
		expect(apiById.get("gpt-5.5")).toBe("openai-responses");
		expect(apiById.get("deepseek-v4-flash-free")).toBe("openai-responses");
		expect(apiById.get("minimax-m2.5-free")).toBe("openai-completions");
		expect(apiById.get("brand-new-model")).toBe("openai-completions");
	});

	test("replaces stale bundled Zen models with each credential's live endpoint list", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-opencode-zen-"));
		try {
			let freeFetches = 0;
			const freeOptions = opencodeZenModelManagerOptions({
				apiKey: "free-account-key",
				fetch: async () => {
					freeFetches++;
					return modelListResponse(LIVE_FREE_MODEL_IDS);
				},
			});
			const freeResult = await resolveProviderModels(
				{ ...freeOptions, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);

			let paidFetches = 0;
			const paidOptions = opencodeZenModelManagerOptions({
				apiKey: "paid-account-key",
				fetch: async () => {
					paidFetches++;
					return modelListResponse(LIVE_PAID_MODEL_IDS);
				},
			});
			const paidResult = await resolveProviderModels(
				{ ...paidOptions, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);

			expect(freeOptions.cacheProviderId).not.toBe(paidOptions.cacheProviderId);
			expect(freeResult.stale).toBe(false);
			expect(freeResult.models.map(model => model.id).sort()).toEqual([...LIVE_FREE_MODEL_IDS].sort());
			expect(paidResult.stale).toBe(false);
			expect(paidResult.models.map(model => model.id).sort()).toEqual([...LIVE_PAID_MODEL_IDS].sort());
			expect([freeFetches, paidFetches]).toEqual([1, 1]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
