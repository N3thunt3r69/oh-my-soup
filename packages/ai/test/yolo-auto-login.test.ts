import { describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "../src/registry/oauth";
import { loginYoloAuto } from "../src/registry/yolo-auto";
import type { FetchImpl } from "../src/types";

describe("Yolo-Auto login", () => {
	test("registers an available API-key provider", () => {
		expect(getOAuthProviders().find(provider => provider.id === "yolo-auto")).toMatchObject({
			id: "yolo-auto",
			name: "Yolo-Auto",
			available: true,
		});
	});

	test("opens the app and validates yolo_ credentials against the authoritative catalog", async () => {
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		let request: { url: string; authorization: string | null } | undefined;
		const fetchImpl: FetchImpl = vi.fn(async (input, init) => {
			request = {
				url: String(input),
				authorization: new Headers(init?.headers).get("authorization"),
			};
			return Response.json({ data: [{ id: "deepseek-flash-v4" }] });
		});

		await expect(
			loginYoloAuto({
				onAuth: event => authEvents.push(event),
				onPrompt: async () => " yolo_test-key ",
				fetch: fetchImpl,
			}),
		).resolves.toBe("yolo_test-key");
		expect(authEvents).toEqual([
			{ url: "https://yolo-auto.com/app", instructions: "Create or copy your Yolo-Auto API key (yolo_...)" },
		]);
		expect(request).toEqual({
			url: "https://yolo-auto.com/v1/models",
			authorization: "Bearer yolo_test-key",
		});
	});
});
