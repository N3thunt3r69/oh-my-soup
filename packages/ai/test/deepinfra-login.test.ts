import { describe, expect, test, vi } from "bun:test";
import { loginDeepinfra } from "../src/registry/deepinfra";
import { getOAuthProviders } from "../src/registry/oauth";
import type { FetchImpl } from "../src/types";

describe("DeepInfra login", () => {
	test("registers an available API-key provider", () => {
		expect(getOAuthProviders().find(provider => provider.id === "deepinfra")).toMatchObject({
			id: "deepinfra",
			name: "DeepInfra",
			available: true,
		});
	});

	test("validates against authenticated inference instead of the public catalog", async () => {
		let request: { url: string; authorization: string | null; body: unknown } | undefined;
		const fetchImpl: FetchImpl = vi.fn(async (input, init) => {
			request = {
				url: String(input),
				authorization: new Headers(init?.headers).get("authorization"),
				body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
			};
			return Response.json({ choices: [{ message: { role: "assistant", content: "" } }] });
		});

		await expect(loginDeepinfra({ onPrompt: async () => " di-test-key ", fetch: fetchImpl })).resolves.toBe(
			"di-test-key",
		);
		expect(request).toEqual({
			url: "https://api.deepinfra.com/v1/openai/chat/completions",
			authorization: "Bearer di-test-key",
			body: {
				model: "deepseek-ai/DeepSeek-V4-Flash-0731",
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				temperature: 0,
			},
		});
	});
});
