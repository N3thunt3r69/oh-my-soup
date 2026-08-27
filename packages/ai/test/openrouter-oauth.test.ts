import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-soup/pi-ai/auth-storage";
import * as AIError from "@oh-my-soup/pi-ai/error";
import { exchangeOpenRouterCode, OpenRouterOAuthFlow } from "@oh-my-soup/pi-ai/registry/oauth/openrouter";
import type { OAuthController } from "@oh-my-soup/pi-ai/registry/oauth/types";
import * as aiStream from "@oh-my-soup/pi-ai/stream";
import type { FetchImpl } from "@oh-my-soup/pi-ai/types";
import { removeWithRetries } from "../../utils/src/temp";

const KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const REDIRECT_URI = "http://localhost:54549/callback";

interface RecordedRequest {
	url: string;
	method: string;
	body: unknown;
}

function makeKeyFetch(response: Response): { fetchImpl: FetchImpl; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const fetchImpl: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		requests.push({
			url,
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		return response;
	});
	return { fetchImpl, requests };
}

function makeFlow(fetchImpl?: FetchImpl, signal?: AbortSignal): OpenRouterOAuthFlow {
	const ctrl: OAuthController = { onAuth: () => {}, fetch: fetchImpl, signal };
	return new OpenRouterOAuthFlow(ctrl);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OpenRouter OAuth flow", () => {
	it("binds the S256 authorize challenge to the verifier used for key provisioning", async () => {
		const { fetchImpl, requests } = makeKeyFetch(
			new Response(JSON.stringify({ key: "sk-or-v1-minted" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const flow = makeFlow(fetchImpl);

		const { url } = await flow.generateAuthUrl(flow.generateState(), REDIRECT_URI);
		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe("https://openrouter.ai/auth");
		expect(parsed.searchParams.get("callback_url")).toBe(REDIRECT_URI);
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.has("state")).toBe(false);

		const credentials = await flow.exchangeToken("auth-code-123");
		expect(credentials.access).toBe("sk-or-v1-minted");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(KEY_EXCHANGE_URL);
		expect(requests[0]?.method).toBe("POST");
		const body = requests[0]?.body as { code: string; code_verifier: string; code_challenge_method: string };
		expect(body.code).toBe("auth-code-123");
		expect(body.code_challenge_method).toBe("S256");
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier));
		expect(parsed.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
	});

	it("refuses to exchange a code before the authorize URL initializes PKCE", async () => {
		await expect(makeFlow().exchangeToken("orphan-code")).rejects.toThrow(/verifier was not initialized/i);
	});

	it("validates a pasted API key through /auth/key without invoking the PKCE exchange", async () => {
		const requests: RecordedRequest[] = [];
		const fetchImpl: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			requests.push({ url, method: init?.method ?? "GET", body: undefined });
			expect(new Headers(init?.headers ?? {}).get("authorization")).toBe("Bearer sk-or-v1-pasted");
			return new Response(JSON.stringify({ data: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const credentials = await makeFlow(fetchImpl).exchangeToken("sk-or-v1-pasted");
		expect(credentials.access).toBe("sk-or-v1-pasted");
		expect(requests).toEqual([{ url: "https://openrouter.ai/api/v1/auth/key", method: "GET", body: undefined }]);
	});

	it("rejects revoked pasted keys and honors login cancellation", async () => {
		const rejectedFetch: FetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
		await expect(makeFlow(rejectedFetch).exchangeToken("sk-or-v1-revoked")).rejects.toThrow(/401/);

		const controller = new AbortController();
		controller.abort("user cancelled");
		await expect(makeFlow(rejectedFetch, controller.signal).exchangeToken("sk-or-v1-pasted")).rejects.toBeInstanceOf(
			AIError.LoginCancelledError,
		);
	});

	it("provisions and durably persists a usable API-key credential through AuthStorage.login", async () => {
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openrouter-oauth-login-"));
		const dbPath = path.join(tempDir, "agent.db");
		let store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const storage = new AuthStorage(store);
			let authUrl = "";
			const identity = await storage.login("openrouter", {
				onAuth: info => {
					authUrl = info.url;
				},
				onPrompt: async () => "sk-or-v1-persisted",
				fetch: vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })),
			});
			expect(identity).toEqual({ type: "api_key" });
			expect(authUrl).toStartWith("https://openrouter.ai/auth?");
			expect(await storage.getApiKey("openrouter", "openrouter-login-session")).toBe("sk-or-v1-persisted");

			store.close();
			store = await SqliteAuthCredentialStore.open(dbPath);
			const reopened = new AuthStorage(store);
			await reopened.reload();
			expect(await reopened.getApiKey("openrouter", "openrouter-reopened-session")).toBe("sk-or-v1-persisted");
		} finally {
			store.close();
			await removeWithRetries(tempDir);
		}
	});
});

describe("exchangeOpenRouterCode", () => {
	it("surfaces rejected exchanges and malformed successful responses", async () => {
		const { fetchImpl } = makeKeyFetch(new Response("bad code", { status: 403 }));
		const error = await exchangeOpenRouterCode("bad-code", "verifier", fetchImpl).then(
			() => undefined,
			(cause: unknown) => cause,
		);
		expect(error).toBeInstanceOf(AIError.OAuthError);
		expect(error).toMatchObject({ status: 403, kind: "token-exchange" });

		const malformed = makeKeyFetch(
			new Response(JSON.stringify({ key: "" }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		await expect(exchangeOpenRouterCode("code", "verifier", malformed.fetchImpl)).rejects.toThrow(/empty key/i);
	});
});
