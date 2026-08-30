import { describe, expect, it } from "bun:test";
import modelsJson from "../src/models.json";

interface BundledModel {
	api: string;
	provider: string;
	baseUrl: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	thinking: { mode: string; efforts: string[]; defaultLevel?: string; requiresEffort?: boolean };
}

describe("zai bundled catalog", () => {
	it("pins glm-5.2 base entry to 1M context", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const model = zaiModels["glm-5.2"];

		expect(model).toBeDefined();
		expect(model.provider).toBe("zai");
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(Object.keys(zaiModels)).not.toContain("glm-5.2[1m]");
	});

	it("bundles GLM-5.3 with its documented Z.AI contract", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const model = zaiModels["glm-5.3"];

		expect(model).toBeDefined();
		expect(model).toMatchObject({
			provider: "zai",
			api: "anthropic-messages",
			baseUrl: "https://api.z.ai/api/anthropic",
			reasoning: true,
			input: ["text"],
			cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			thinking: {
				mode: "anthropic-budget-effort",
				efforts: ["low", "high", "max"],
			},
		});
	});

	it("bundles GLM-5.3-Flash with its documented Z.AI contract", () => {
		const zaiModels = modelsJson.zai as Record<string, BundledModel>;
		const model = zaiModels["glm-5.3-flash"];

		expect(model).toBeDefined();
		expect(model).toMatchObject({
			provider: "zai",
			api: "anthropic-messages",
			baseUrl: "https://api.z.ai/api/anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			thinking: {
				mode: "anthropic-budget-effort",
				efforts: ["low", "high", "max"],
				defaultLevel: "max",
				requiresEffort: true,
			},
		});
		expect(Object.keys(zaiModels)).not.toContain("glm-5.3-flash[1m]");
	});
});
