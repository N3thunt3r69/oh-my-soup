import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { coworkFetch } from "@oh-my-soup/pi-ai/providers/cowork-fetch";

describe("coworkFetch proxy handling", () => {
	const nativeFetch = globalThis.fetch;
	let calls: Array<{ url: string; proxy: unknown }>;

	beforeEach(() => {
		calls = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: input instanceof Request ? input.url : String(input),
				proxy: (init as { proxy?: unknown } | undefined)?.proxy,
			});
			return new Response("ok");
		}) as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = nativeFetch;
	});

	it("delegates proxied requests to Bun fetch with the proxy intact", async () => {
		const response = await coworkFetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
			proxy: "http://127.0.0.1:24560",
		} as RequestInit);

		expect(await response.text()).toBe("ok");
		expect(calls).toEqual([{ url: "https://api.anthropic.com/v1/messages", proxy: "http://127.0.0.1:24560" }]);
	});

	it("keeps direct HTTPS requests on the Cowork transport", async () => {
		await expect(coworkFetch("https://127.0.0.1:1/v1/messages", { headers: { accept: "*/*" } })).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
});
