import { $env } from "@oh-my-soup/pi-utils/env";
import { isRecord } from "@oh-my-soup/pi-utils/type-guards";
import * as AIError from "../error";
import type { FetchImpl, StreamOptions } from "../types";
import { normalizeProviderResponse } from "../utils/provider-response";

export const PRISM_BASE_URL = "https://prism.openai.com";

export interface PrismCredentials {
	cookie: string;
	projectId: string;
}

const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;
const SENSITIVE_HEADER = /cookie|token|secret|authorization|api[-_]key/i;

interface PrismRequestOptions {
	method?: "GET" | "POST";
	body?: unknown;
	sandboxToken?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface PrismTextRequestOptions extends PrismRequestOptions {
	actionId?: string;
}

function normalizeProjectId(raw: unknown): string {
	if (typeof raw !== "string" || !raw.trim()) {
		throw new AIError.ValidationError(
			"Prism requires an existing project URL or UUID. Use /login or set PRISM_PROJECT_ID.",
		);
	}
	if (/[\r\n]/.test(raw)) {
		throw new AIError.ValidationError("Prism project must be a single-line project URL or UUID.");
	}
	let projectId = raw.trim();
	if (!PROJECT_UUID.test(projectId)) {
		let url: URL;
		try {
			url = new URL(projectId);
		} catch {
			throw new AIError.ValidationError(
				"Invalid Prism project. Supply an existing prism.openai.com project URL or UUID.",
			);
		}
		if (url.origin !== PRISM_BASE_URL || url.username || url.password || url.searchParams.getAll("u").length !== 1) {
			throw new AIError.ValidationError(
				"Invalid Prism project. Supply an existing prism.openai.com project URL or UUID.",
			);
		}
		projectId = url.searchParams.get("u") ?? "";
	}
	if (!PROJECT_UUID.test(projectId)) {
		throw new AIError.ValidationError("Invalid Prism project UUID.");
	}
	return projectId.toLowerCase();
}

function parseCookieHeader(raw: string): Map<string, string> {
	if (/[\r\n]/.test(raw)) {
		throw new AIError.ValidationError("Prism Cookie header must not contain newlines.");
	}
	const value = raw.trim().replace(/^cookie:\s*/i, "");
	if (!value) {
		throw new AIError.ApiKeyRequiredError(
			"Prism requires the full Cookie header from a signed-in prism.openai.com tab.",
		);
	}
	const cookies = new Map<string, string>();
	for (const part of value.split(";")) {
		const pair = part.trim();
		const separator = pair.indexOf("=");
		const name = pair.slice(0, separator);
		const cookieValue = pair.slice(separator + 1);
		if (separator < 1 || !COOKIE_NAME.test(name) || !COOKIE_VALUE.test(cookieValue)) {
			throw new AIError.ValidationError(
				"Invalid Prism Cookie header. Paste the full Cookie header, not a bare session token.",
			);
		}
		cookies.set(name, cookieValue);
	}
	if (![...cookies.values()].some(cookie => cookie.length > 0)) {
		throw new AIError.ApiKeyRequiredError("Prism Cookie header does not contain a credential.");
	}
	return cookies;
}

function serializeCookies(cookies: Map<string, string>): string {
	return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** API-key text may contain stored JSON credentials or a full browser Cookie header. */
export function parsePrismCredentials(raw: string, projectId?: string): PrismCredentials {
	if (typeof raw !== "string" || !raw.trim()) {
		throw new AIError.ApiKeyRequiredError(
			"Prism credentials are missing. Use /login or set PRISM_COOKIE and PRISM_PROJECT_ID.",
		);
	}
	let cookie = raw;
	let storedProject: string | undefined;
	if (raw.trimStart().startsWith("{")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new AIError.ValidationError("Invalid Prism credential JSON. Expected cookie and projectId strings.");
		}
		if (
			!isRecord(parsed) ||
			typeof parsed.cookie !== "string" ||
			(parsed.projectId !== undefined && typeof parsed.projectId !== "string")
		) {
			throw new AIError.ValidationError("Invalid Prism credential JSON. Expected cookie and projectId strings.");
		}
		cookie = parsed.cookie;
		storedProject = parsed.projectId;
	}
	return {
		cookie: serializeCookies(parseCookieHeader(cookie)),
		projectId: normalizeProjectId(projectId ?? storedProject ?? $env.PRISM_PROJECT_ID),
	};
}

export class PrismHttpClient {
	readonly #cookies: Map<string, string>;
	readonly #projectId: string;
	readonly #fetch: FetchImpl;
	readonly #headers: Record<string, string> | undefined;
	readonly #onResponse: StreamOptions["onResponse"];
	#createConversationAction: string | undefined;

	constructor(
		credentials: PrismCredentials,
		options?: { fetch?: FetchImpl; headers?: Record<string, string>; onResponse?: StreamOptions["onResponse"] },
	) {
		this.#cookies = parseCookieHeader(credentials.cookie);
		this.#projectId = normalizeProjectId(credentials.projectId);
		this.#fetch = options?.fetch ?? fetch;
		this.#headers = options?.headers;
		this.#onResponse = options?.onResponse;
	}

	serializeCredentials(): string {
		return JSON.stringify({ cookie: serializeCookies(this.#cookies), projectId: this.#projectId });
	}

	async authenticate(signal?: AbortSignal): Promise<{ userId: string }> {
		const session = await this.request("/api/auth/session", { signal });
		if (!isRecord(session.user) || session.user.is_anonymous !== false) {
			throw new AIError.ApiKeyRequiredError(
				"Prism requires a signed-in ChatGPT-linked session. Sign in and copy a fresh full Cookie header.",
			);
		}
		const policyUser = isRecord(session.policy) && isRecord(session.policy.user) ? session.policy.user : undefined;
		const workspace = policyUser?.selected_workspace;
		if (!policyUser || (workspace != null && !isRecord(workspace))) {
			throw new AIError.ApiKeyRequiredError(
				"Prism session is missing a valid OpenAI policy identity. Sign in again.",
			);
		}
		const workspaceUserId = isRecord(workspace) ? workspace.account_user_id : undefined;
		const openaiUserId = policyUser.openai_user_id;
		if (
			(workspaceUserId != null &&
				(typeof workspaceUserId !== "string" || !/^user-[a-z0-9_-]+$/i.test(workspaceUserId))) ||
			(openaiUserId != null && (typeof openaiUserId !== "string" || !/^user-[a-z0-9_-]+$/i.test(openaiUserId)))
		) {
			throw new AIError.ApiKeyRequiredError(
				"Prism session returned an invalid OpenAI policy identity. Sign in again.",
			);
		}
		const userId = workspaceUserId ?? openaiUserId;
		if (typeof userId !== "string") {
			throw new AIError.ApiKeyRequiredError(
				"Prism session is missing a valid OpenAI policy identity. Sign in again.",
			);
		}
		const project = await this.request(`/api/project-access?d=${this.#projectId}`, { signal });
		if (project.accessible !== true) {
			throw new AIError.ApiKeyRequiredError(
				"The signed-in Prism account cannot access this project. Supply an existing project owned by or shared with this account.",
			);
		}
		return { userId };
	}

	async createConversation(signal?: AbortSignal): Promise<string> {
		const path = `/?u=${this.#projectId}&pg=1&m=main.tex`;
		const actionId = this.#createConversationAction ?? (await this.#discoverCreateConversationAction(path, signal));
		const flight = await this.#requestText(path, {
			method: "POST",
			body: [this.#projectId],
			actionId,
			signal,
		});
		try {
			const records = new Map<string, string>();
			for (const line of flight.split(/\r?\n/)) {
				if (!line) continue;
				const record = /^([0-9a-f]+):(.+)$/i.exec(line);
				if (!record || record[2]!.startsWith("E")) throw new Error();
				const id = record[1]!.toLowerCase();
				if (records.has(id)) throw new Error();
				records.set(id, record[2]!);
			}
			const root: unknown = JSON.parse(records.get("0") ?? "");
			const reference = isRecord(root) && typeof root.a === "string" ? /^\$@([0-9a-f]+)$/i.exec(root.a) : null;
			if (!reference) throw new Error();
			const conversationId: unknown = JSON.parse(records.get(reference[1]!.toLowerCase()) ?? "");
			if (
				typeof conversationId !== "string" ||
				!conversationId.startsWith("cdx1_") ||
				!PROJECT_UUID.test(conversationId.slice(5))
			) {
				throw new Error();
			}
			return conversationId;
		} catch {
			throw new AIError.ProviderResponseError("Prism returned an invalid conversation action result.", {
				provider: "openai-prism",
				kind: "envelope",
			});
		}
	}

	async request(path: string, options?: PrismRequestOptions): Promise<Record<string, unknown>> {
		const data: unknown = await this.#request(path, options, response => response.json(), "JSON");
		if (!isRecord(data) || Object.getPrototypeOf(data) !== Object.prototype) {
			throw new AIError.ProviderResponseError("Prism returned an invalid response object.", {
				provider: "openai-prism",
				kind: "envelope",
			});
		}
		return data;
	}

	#requestText(path: string, options?: PrismTextRequestOptions): Promise<string> {
		return this.#request(path, options, response => response.text(), "text");
	}

	async #discoverCreateConversationAction(path: string, signal?: AbortSignal): Promise<string> {
		const page = await this.#requestText(path, { signal });
		const chunks = new Set<string>();
		for (const script of page.matchAll(/<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)) {
			const url = this.#resolveUrl((script[1] ?? script[2]!).replaceAll("&amp;", "&"));
			if (/^\/_next\/static\/chunks\/[\w.-]+\.js$/.test(url.pathname)) chunks.add(url.href);
		}
		for (const chunk of chunks) {
			const source = await this.#requestText(chunk, { signal });
			let actionId: string | undefined;
			// Next's client stub names the action in the final createServerReference argument.
			for (const binding of source.matchAll(
				/\(\s*0\s*,\s*([A-Za-z_$][\w$]*)\.createServerReference\s*\)\s*\(\s*["']([0-9a-fA-F]{42})["']\s*,\s*\1\.callServer\s*,\s*void\s+0\s*,\s*\1\.findSourceMapURL\s*,\s*["']createProjectConversation["']\s*\)/g,
			)) {
				if (actionId !== undefined && actionId !== binding[2]) {
					throw new AIError.ProviderResponseError("Prism returned ambiguous conversation action bindings.", {
						provider: "openai-prism",
						kind: "envelope",
					});
				}
				actionId = binding[2]!;
			}
			if (actionId !== undefined) {
				this.#createConversationAction = actionId;
				return actionId;
			}
		}
		throw new AIError.ProviderResponseError("Prism conversation creation action was not found in the project page.", {
			provider: "openai-prism",
			kind: "envelope",
		});
	}

	#resolveUrl(path: string): URL {
		let url: URL;
		try {
			if (/[\r\n]/.test(path)) throw new Error();
			url = new URL(path, PRISM_BASE_URL);
		} catch {
			throw new AIError.ValidationError("Invalid Prism request URL.");
		}
		if (url.origin !== PRISM_BASE_URL || url.username || url.password) {
			throw new AIError.ValidationError("Refusing to send Prism credentials outside prism.openai.com.");
		}
		return url;
	}

	async #request<T>(
		path: string,
		options: PrismTextRequestOptions | undefined,
		parseResponse: (response: Response) => Promise<T>,
		responseFormat: "JSON" | "text",
	): Promise<T> {
		const url = this.#resolveUrl(path);
		const method = options?.method ?? "GET";
		let headers: Headers;
		let body: string | undefined;
		try {
			headers = new Headers(this.#headers);
			headers.delete("authorization");
			headers.delete("proxy-authorization");
			headers.delete("host");
			headers.delete("x-crixet-sandbox-token");
			headers.delete("next-action");
			headers.set("cookie", serializeCookies(this.#cookies));
			headers.set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0");
			headers.set("accept", "*/*");
			headers.set("accept-language", "en-US,en;q=0.9");
			headers.set("referer", `${PRISM_BASE_URL}/?u=${this.#projectId}&pg=1&m=main.tex`);
			headers.set("sec-fetch-dest", "empty");
			headers.set("sec-fetch-mode", "cors");
			headers.set("sec-fetch-site", "same-origin");
			headers.delete("origin");
			if (method !== "GET") headers.set("origin", PRISM_BASE_URL);
			if (options?.body !== undefined) {
				headers.set("content-type", "application/json");
				body = JSON.stringify(options.body);
			}
			if (options?.sandboxToken !== undefined) headers.set("x-crixet-sandbox-token", options.sandboxToken);
			if (options?.actionId !== undefined) {
				headers.set("next-action", options.actionId);
				headers.set("accept", "text/x-component");
				headers.set("content-type", "text/plain;charset=UTF-8");
			}
		} catch {
			throw new AIError.ValidationError("Invalid Prism request headers or JSON body.");
		}
		// The deadline owns its own controller so a request timeout stays
		// distinguishable from caller cancellation, and the timer is neither
		// unref'd (a stalled poll must still wake the loop) nor left armed once
		// the attempt settles.
		const deadlineMs = options?.timeoutMs ?? 150_000;
		const deadlineController = new AbortController();
		const timer =
			deadlineMs > 0
				? setTimeout(
						() => deadlineController.abort(new AIError.StreamTimeoutError("Prism request timed out.")),
						deadlineMs,
					)
				: undefined;
		const signal = options?.signal
			? AbortSignal.any([options.signal, deadlineController.signal])
			: deadlineController.signal;
		const checkAbort = () => {
			if (options?.signal?.aborted) throw new AIError.AbortError();
			if (deadlineController.signal.aborted) throw new AIError.StreamTimeoutError("Prism request timed out.");
		};
		try {
			checkAbort();
			let response: Response;
			try {
				response = await this.#fetch(url, { method, headers, body, redirect: "error", signal });
			} catch {
				checkAbort();
				throw new AIError.ProviderResponseError(
					"Prism request failed. Check connectivity and sign in again if the session expired.",
					{ provider: "openai-prism", kind: "runtime" },
				);
			}
			checkAbort();
			if (
				response.redirected ||
				(response.url && new URL(response.url).origin !== PRISM_BASE_URL) ||
				(options?.actionId !== undefined && response.headers.has("x-action-redirect"))
			) {
				throw new AIError.ProviderResponseError("Prism returned an unexpected redirect.", {
					provider: "openai-prism",
					kind: "envelope",
				});
			}
			this.#updateCookies(response.headers);
			const metadata = normalizeProviderResponse(response, response.headers.get("x-request-id"));
			for (const key of Object.keys(metadata.headers)) {
				if (SENSITIVE_HEADER.test(key) || key === "location") delete metadata.headers[key];
			}
			await this.#onResponse?.(metadata);
			checkAbort();
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				throw new AIError.ProviderHttpError(`Prism request failed (HTTP ${response.status}).`, response.status, {
					headers: new Headers(metadata.headers),
				});
			}
			let data: T;
			try {
				data = await parseResponse(response);
			} catch {
				checkAbort();
				throw new AIError.ProviderResponseError(`Prism returned invalid ${responseFormat}.`, {
					provider: "openai-prism",
					kind: "envelope",
				});
			}
			checkAbort();
			return data;
		} finally {
			clearTimeout(timer);
		}
	}

	#updateCookies(headers: Headers): void {
		for (const header of headers.getSetCookie()) {
			const [pair = "", ...attributes] = header.split(";");
			const separator = pair.indexOf("=");
			const name = pair.slice(0, separator).trim();
			const value = pair.slice(separator + 1).trim();
			if (separator < 1 || !COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) continue;
			let expires: number | undefined;
			let maxAge: number | undefined;
			let validDomain = true;
			for (const attribute of attributes) {
				const index = attribute.indexOf("=");
				if (index < 0) continue;
				const key = attribute.slice(0, index).trim().toLowerCase();
				const content = attribute.slice(index + 1).trim();
				if (key === "max-age" && /^-?\d+$/.test(content)) maxAge = Number(content);
				if (key === "expires") expires = Date.parse(content);
				if (key === "domain") {
					const domain = content.toLowerCase().replace(/^\./, "");
					validDomain = domain === "prism.openai.com" || domain === "openai.com";
				}
			}
			if (!validDomain) continue;
			if (maxAge !== undefined ? maxAge <= 0 : expires !== undefined && expires <= Date.now())
				this.#cookies.delete(name);
			else this.#cookies.set(name, value);
		}
	}
}
