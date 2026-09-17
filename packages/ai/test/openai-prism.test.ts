import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-soup/omstype";
import { streamSimple } from "@oh-my-soup/pi-ai";
import { streamOpenAIPrism } from "@oh-my-soup/pi-ai/providers/openai-prism";
import { PrismHttpClient } from "@oh-my-soup/pi-ai/providers/openai-prism-client";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
	Tool,
} from "@oh-my-soup/pi-ai/types";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { Effort } from "@oh-my-soup/pi-catalog/effort";

const BASE_URL = "https://prism.openai.com";
const PROJECT_ID = "00000000-0000-4000-8000-000000000011";
const OVERRIDE_PROJECT_ID = "00000000-0000-4000-8000-000000000012";
const COOKIE = "prism-session=fixture-session-secret; oai-sc=fixture-openai-secret";
const SANDBOX_TOKEN = "fixture-sandbox-secret";
const RESOURCE_TOKEN = "fixture-resource-secret";
const SYNC_TOKEN = "fixture-sync-secret";
const API_KEY = JSON.stringify({ cookie: COOKIE, projectId: PROJECT_ID });
const POLICY_USER_ID = "user-fixture-workspace";
const REQUEST_ID = "request-fixture-1";
const RESPONSE_ID = "resp_fixture_1";
const CONVERSATION_ID = "cdx1_00000000-0000-4000-8000-000000000021";
const COMPLETED_SNAPSHOT = {
	conversation_id: CONVERSATION_ID,
	codex_session_id: "native-codex-session",
	last_turn_id: "native-turn-1",
	transcript_cursor: 12,
	sandbox_url: "http://internal-prism-backend/sandboxes/proxy/",
	future_field: { retained: true },
};
const START_PATH = "/api/llm/response_with_tools_start";
const STATUS_PATH = "/api/llm/response_with_tools_status";
const STOP_PATH = "/api/llm/response_with_tools_stop";
const FIRST_STATE = { phase: "started", opaque: { cursor: [1, "a"] }, retainedOnlyInFirst: true };
const SECOND_STATE = { phase: "pending", opaque: { cursor: [2, "b"] } };
const THIRD_STATE = { phase: "pending", opaque: { cursor: [3, "c"] } };

const readTool: Tool = {
	name: "read",
	description: "Read a local file",
	parameters: type({ path: "string" }),
};

interface CapturedRequest {
	method: string;
	path: string;
	body: unknown;
	headers: Headers;
	signal: AbortSignal | null | undefined;
}

interface HttpStep {
	method: "GET" | "POST";
	path: string;
	response: unknown;
	rawBody?: string;
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected fixture request object");
	}
	return value as Record<string, unknown>;
}

function createHttpFixture(steps: HttpStep[], timeline: string[] = []) {
	const requests: CapturedRequest[] = [];
	const fetch: FetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const request: CapturedRequest = {
			method: init?.method ?? "GET",
			path: `${url.pathname}${url.search}`,
			body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
			headers: new Headers(init?.headers),
			signal: init?.signal,
		};
		requests.push(request);
		timeline.push(request.path);
		const step = steps[requests.length - 1];
		if (url.origin !== BASE_URL || !step || step.path !== request.path || step.method !== request.method) {
			throw new Error("Unexpected Prism fixture request");
		}
		return new Response(step.rawBody ?? JSON.stringify(step.response), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as FetchImpl;
	return {
		fetch,
		requests,
		assertConsumed() {
			expect(requests.map(({ method, path }) => ({ method, path }))).toEqual(
				steps.map(({ method, path }) => ({ method, path })),
			);
		},
	};
}

function createModel(id = "gpt-6-astra"): Model<"openai-prism"> {
	return buildModel({
		id,
		name: id,
		api: "openai-prism",
		provider: "openai-prism",
		baseUrl: BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		supportsTools: true,
	});
}

function createContext(): Context {
	return {
		systemPrompt: ["Preserve the caller's complete conversation."],
		messages: [{ role: "user", content: "What is 23 + 19?", timestamp: 1 }],
	};
}

function bootstrapSteps(projectId = PROJECT_ID, sandboxName = "fixture-a"): HttpStep[] {
	const sandboxUrl = `${BASE_URL}/s/sandboxes/${sandboxName}/`;
	const sync = {
		url: `wss://prism.openai.com/y/d/${projectId}/ws`,
		baseUrl: `${BASE_URL}/y/d/${projectId}`,
		docId: projectId,
		token: SYNC_TOKEN,
		authorization: "full",
	};
	return [
		{
			method: "GET",
			path: "/api/auth/session",
			response: {
				session: null,
				user: { id: "not-the-openai-policy-identity", is_anonymous: false },
				policy: {
					user: {
						openai_user_id: "user-fixture-fallback",
						selected_workspace: { account_user_id: POLICY_USER_ID },
					},
				},
			},
		},
		{ method: "GET", path: `/api/project-access?d=${projectId}`, response: { accessible: true } },
		{
			method: "POST",
			path: "/api/backend/1/new",
			response: { url: sandboxUrl.slice(0, -1), token: SANDBOX_TOKEN },
		},
		{
			method: "POST",
			path: `/api/projects/${projectId}/sandbox/resources-token`,
			response: { access_token: RESOURCE_TOKEN, resources_base_url: `${BASE_URL}/s/sandbox-resources` },
		},
		{
			method: "POST",
			path: `/s/sandboxes/${sandboxName}/resources-token`,
			response: { status: "success" },
		},
		{ method: "POST", path: "/api/y", response: sync },
		{ method: "POST", path: `/s/sandboxes/${sandboxName}/token`, response: { status: "success" } },
		{
			method: "GET",
			path: `/s/sandboxes/${sandboxName}/wait-for-sync?wait_ms=10000`,
			response: { status: "synced" },
		},
	];
}

function started(): HttpStep {
	return {
		method: "POST",
		path: START_PATH,
		response: { status: "started", request_id: REQUEST_ID, turn_state: FIRST_STATE },
	};
}

function pending(state: unknown, summaries: unknown[] = [], toolCalls: unknown[] = []): HttpStep {
	return {
		method: "POST",
		path: STATUS_PATH,
		response: {
			status: "pending",
			request_id: REQUEST_ID,
			turn_state: state,
			codex_live_progress: { reasoningSummaries: summaries, toolCalls, eventPreviews: [] },
		},
	};
}

function completed(text: string, responseId = RESPONSE_ID): HttpStep {
	return {
		method: "POST",
		path: STATUS_PATH,
		response: {
			status: "completed",
			request_id: REQUEST_ID,
			response: {
				status: "success",
				payload: {
					id: responseId,
					codexListenSnapshot: COMPLETED_SNAPSHOT,
					output: [
						{
							type: "message",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text, annotations: [] }],
						},
					],
				},
			},
		},
	};
}

async function collect(stream: AssistantMessageEventStream) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

function textOf(result: AssistantMessage): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
}

function inputMessages(body: unknown): { role: unknown; text: string }[] {
	const input = record(body).input;
	if (!Array.isArray(input)) throw new Error("Expected Prism input message array");
	return input.map(value => {
		const message = record(value);
		const content = message.content;
		return {
			role: message.role,
			text:
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content.map(part => record(part).text ?? "").join("")
						: "",
		};
	});
}

function expectContentEvents(events: AssistantMessageEvent[], result: AssistantMessage): void {
	for (const [contentIndex, block] of result.content.entries()) {
		if (block.type !== "text" && block.type !== "thinking") continue;
		const kind = block.type;
		const content = block.type === "text" ? block.text : block.thinking;
		const blockEvents = events.filter(event => event.contentIndex === contentIndex);
		expect(blockEvents[0]?.type).toBe(`${kind}_start`);
		expect(blockEvents.at(-1)?.type).toBe(`${kind}_end`);
		expect(blockEvents.filter(event => event.type === `${kind}_start`)).toHaveLength(1);
		expect(blockEvents.filter(event => event.type === `${kind}_end`)).toHaveLength(1);
		expect(
			blockEvents
				.flatMap(event => (event.type === "text_delta" || event.type === "thinking_delta" ? [event.delta] : []))
				.join(""),
		).toBe(content);
		const end = blockEvents.at(-1);
		if (end?.type !== "text_end" && end?.type !== "thinking_end") throw new Error("Missing block end");
		expect(end.content).toBe(content);
	}
}

function expectSafeError(result: AssistantMessage): void {
	expect(result.stopReason).toBe("error");
	expect(typeof result.errorMessage).toBe("string");
	const serialized = JSON.stringify(result);
	for (const secret of [
		COOKIE,
		"fixture-session-secret",
		"fixture-openai-secret",
		SANDBOX_TOKEN,
		RESOURCE_TOKEN,
		SYNC_TOKEN,
	]) {
		expect(serialized).not.toContain(secret);
	}
}

beforeEach(() => {
	// The action-discovery/Flight transport has its own client contract tests.
	vi.spyOn(PrismHttpClient.prototype, "createConversation").mockResolvedValue(CONVERSATION_ID);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openai-prism HTTP provider", () => {
	it("bootstraps before generation and emits deduplicated reasoning followed by a complete answer", async () => {
		const timeline: string[] = [];
		const wait = vi.spyOn(scheduler, "wait").mockImplementation(async () => {
			timeline.push("wait");
		});
		const firstSummary = { line_index: 10, text: "Count the two quantities." };
		const secondSummary = { line_index: 14, text: "Check the sum." };
		const fixture = createHttpFixture(
			[
				...bootstrapSteps(),
				started(),
				pending(SECOND_STATE, [firstSummary]),
				pending(THIRD_STATE, [firstSummary, secondSummary]),
				completed("42"),
			],
			timeline,
		);
		const { events, result } = await collect(
			streamOpenAIPrism(createModel(), createContext(), {
				apiKey: API_KEY,
				fetch: fixture.fetch,
				reasoning: Effort.Medium,
			}),
		);

		fixture.assertConsumed();
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe(RESPONSE_ID);
		expect(textOf(result)).toBe("42");
		const thinking = result.content.flatMap(block => (block.type === "thinking" ? [block.thinking] : [])).join("\n");
		expect(thinking.match(/Count the two quantities\./g)).toHaveLength(1);
		expect(thinking.match(/Check the sum\./g)).toHaveLength(1);
		expect(thinking.indexOf(firstSummary.text)).toBeLessThan(thinking.indexOf(secondSummary.text));
		expect(events[0]?.type).toBe("start");
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expect(events.some(event => event.type === "error")).toBe(false);
		expectContentEvents(events, result);
		expect(timeline.indexOf(STATUS_PATH)).toBeLessThan(timeline.indexOf("wait"));
		expect(wait).toHaveBeenCalledTimes(2);

		const polls = fixture.requests.filter(request => request.path === STATUS_PATH);
		expect(polls.map(request => request.body)).toEqual([
			{ request_id: REQUEST_ID, turn_state: FIRST_STATE },
			{ request_id: REQUEST_ID, turn_state: SECOND_STATE },
			{ request_id: REQUEST_ID, turn_state: THIRD_STATE },
		]);
		const start = record(fixture.requests.find(request => request.path === START_PATH)?.body);
		const metadata = record(start.metadata);
		expect(start.conversationId).toMatch(/^cdx1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(metadata).toMatchObject({
			projectId: PROJECT_ID,
			userId: POLICY_USER_ID,
			model: "gpt-6-astra",
			reasoning_effort: "medium",
			frontend_origin: BASE_URL,
			sandbox_url: `${BASE_URL}/s/sandboxes/fixture-a/`,
			sandbox_token: SANDBOX_TOKEN,
		});
		const snapshot = record(JSON.parse(String(metadata.codex_listen_snapshot)) as unknown);
		expect(snapshot).toMatchObject({
			user_id: POLICY_USER_ID,
			project_id: PROJECT_ID,
			conversation_id: start.conversationId,
			workspace_session_id: String(start.conversationId).slice("cdx1_".length),
			sandbox_url: `${BASE_URL}/s/sandboxes/fixture-a/`,
			sandbox_token: SANDBOX_TOKEN,
			codex_session_id: null,
			last_turn_id: null,
			transcript_cursor: 0,
		});
		expect(fixture.requests[3]?.body).toEqual({ sandbox_session_id: null, sandbox_token: SANDBOX_TOKEN });
		expect(fixture.requests[4]?.body).toEqual({
			token: RESOURCE_TOKEN,
			resourceBaseUrl: `${BASE_URL}/s/sandbox-resources/`,
			projectId: PROJECT_ID,
		});
		expect(fixture.requests[5]?.body).toMatchObject({
			docId: PROJECT_ID,
			requestContext: { source: "initial-bootstrap", sandboxUrl: `${BASE_URL}/s/sandboxes/fixture-a/` },
		});
		expect(fixture.requests[6]?.body).toEqual(bootstrapSteps()[5]?.response);
		for (const index of [4, 6, 7]) {
			expect(fixture.requests[index]?.headers.get("x-crixet-sandbox-token")).toBe(SANDBOX_TOKEN);
		}
	});

	it.each([false, true])("routes hideThinkingSummary=%s through the public API", async hideThinkingSummary => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const summary = "Count the two quantities.";
		const fixture = createHttpFixture([
			...bootstrapSteps(),
			started(),
			pending(SECOND_STATE, [{ line_index: 10, text: summary }]),
			completed("42"),
		]);
		const { events, result } = await collect(
			streamSimple(createModel(), createContext(), {
				apiKey: API_KEY,
				fetch: fixture.fetch,
				reasoning: Effort.High,
				hideThinkingSummary,
			}),
		);

		fixture.assertConsumed();
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("42");
		expect(result.content.flatMap(block => (block.type === "thinking" ? [block.thinking] : []))).toEqual(
			hideThinkingSummary ? [] : [summary],
		);
		expect(events.some(event => event.type.startsWith("thinking_"))).toBe(!hideThinkingSummary);
		expectContentEvents(events, result);
		const start = record(fixture.requests.find(request => request.path === START_PATH)?.body);
		expect(record(start.metadata).reasoning_effort).toBe("high");
	});

	it("continues the registered native thread with only new input and the last server snapshot", async () => {
		const fixture = createHttpFixture([
			...bootstrapSteps(),
			started(),
			completed("42"),
			...bootstrapSteps().slice(0, 2),
			started(),
			completed("The earlier sum was 42.", "resp_fixture_2"),
		]);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = { apiKey: API_KEY, fetch: fixture.fetch, providerSessionState };
		const context = createContext();
		const first = await streamOpenAIPrism(createModel(), context, options).result();
		expect(first.stopReason).toBe("stop");
		const second = await streamOpenAIPrism(
			createModel(),
			{
				...context,
				messages: [...context.messages, first, { role: "user", content: "Recall the earlier sum.", timestamp: 3 }],
			},
			options,
		).result();
		fixture.assertConsumed();
		expect(second.stopReason).toBe("stop");
		expect(textOf(second)).toBe("The earlier sum was 42.");
		expect(PrismHttpClient.prototype.createConversation).toHaveBeenCalledTimes(1);
		const starts = fixture.requests
			.filter(request => request.path === START_PATH)
			.map(request => record(request.body));
		expect(starts.map(start => start.conversationId)).toEqual([CONVERSATION_ID, CONVERSATION_ID]);
		expect(starts[0]?.previousResponseId).toBeUndefined();
		expect(starts[1]?.previousResponseId).toBe(RESPONSE_ID);
		expect(JSON.parse(String(record(starts[1]?.metadata).codex_listen_snapshot))).toEqual(COMPLETED_SNAPSHOT);
		const delta = inputMessages(starts[1]);
		expect(delta.filter(message => message.role !== "system")).toEqual([
			{ role: "user", text: "Recall the earlier sum." },
		]);
		expect(delta.find(message => message.role === "system")?.text).toContain(context.systemPrompt![0]!);
		expect(first.providerPayload).toEqual({
			type: "openaiPrismHistory",
			conversationId: CONVERSATION_ID,
			userId: POLICY_USER_ID,
			projectId: PROJECT_ID,
		});
		expect(JSON.stringify(first.providerPayload)).not.toContain(SANDBOX_TOKEN);
	});

	it("resumes a serialized native thread after transport state is closed without registering a different chat", async () => {
		const fixture = createHttpFixture([
			...bootstrapSteps(),
			started(),
			completed("42"),
			...bootstrapSteps(PROJECT_ID, "fixture-b"),
			started(),
			completed("Still 42.", "resp_fixture_2"),
		]);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = { apiKey: API_KEY, fetch: fixture.fetch, providerSessionState };
		const context = createContext();
		const first = await streamOpenAIPrism(createModel(), context, options).result();
		for (const state of providerSessionState.values()) state.close();
		providerSessionState.clear();
		const persisted = JSON.parse(JSON.stringify(first)) as AssistantMessage;
		const second = await streamOpenAIPrism(
			createModel(),
			{
				...context,
				messages: [...context.messages, persisted, { role: "user", content: "Recall.", timestamp: 3 }],
			},
			options,
		).result();
		fixture.assertConsumed();
		expect(second.stopReason).toBe("stop");
		expect(PrismHttpClient.prototype.createConversation).toHaveBeenCalledTimes(1);
		const start = record(fixture.requests.filter(request => request.path === START_PATH)[1]?.body);
		expect(start.conversationId).toBe(CONVERSATION_ID);
		expect(start.previousResponseId).toBe(RESPONSE_ID);
		expect(record(start.metadata).sandbox_url).toBe(`${BASE_URL}/s/sandboxes/fixture-b/`);
	});

	it("does not attach a different account or project transcript to a native thread", async () => {
		const fixture = createHttpFixture(bootstrapSteps().slice(0, 2));
		const context = createContext();
		const previous: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Other account" }],
			api: "openai-prism",
			provider: "openai-prism",
			model: "gpt-6-astra",
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			providerPayload: {
				type: "openaiPrismHistory",
				conversationId: CONVERSATION_ID,
				projectId: PROJECT_ID,
				userId: "different-user",
			},
		};
		const result = await streamOpenAIPrism(
			createModel(),
			{
				...context,
				messages: [
					...context.messages,
					{
						...previous,
						providerPayload: {
							type: "openaiPrismHistory",
							conversationId: CONVERSATION_ID,
							projectId: PROJECT_ID,
							userId: POLICY_USER_ID,
						},
					},
					previous,
					{ role: "user", content: "Continue", timestamp: 3 },
				],
			},
			{ apiKey: API_KEY, fetch: fixture.fetch },
		).result();
		fixture.assertConsumed();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("no resumable Prism conversation");
		expect(PrismHttpClient.prototype.createConversation).not.toHaveBeenCalled();
	});

	it("uses the explicit project instead of the project stored in the API key", async () => {
		const fixture = createHttpFixture([
			...bootstrapSteps(OVERRIDE_PROJECT_ID),
			started(),
			completed("Override accepted"),
		]);
		const result = await streamOpenAIPrism(createModel("gpt-5.6-sol"), createContext(), {
			apiKey: API_KEY,
			projectId: `${BASE_URL}/?u=${OVERRIDE_PROJECT_ID}`,
			fetch: fixture.fetch,
		}).result();

		fixture.assertConsumed();
		expect(result.stopReason).toBe("stop");
		const start = record(fixture.requests.find(request => request.path === START_PATH)?.body);
		expect(record(start.metadata).projectId).toBe(OVERRIDE_PROJECT_ID);
		expect(record(start.metadata).model).toBe("gpt-5.6-sol");
	});

	it("surfaces a completed error envelope instead of a successful empty answer without leaking credentials", async () => {
		const fixture = createHttpFixture([
			...bootstrapSteps(),
			started(),
			{
				method: "POST",
				path: STATUS_PATH,
				response: {
					status: "completed",
					request_id: REQUEST_ID,
					response: {
						status: "error",
						message: `Upstream failure ${COOKIE} ${SANDBOX_TOKEN} ${RESOURCE_TOKEN} ${SYNC_TOKEN}`,
						payload: { output: [] },
					},
				},
			},
		]);
		const { events, result } = await collect(
			streamOpenAIPrism(createModel(), createContext(), { apiKey: API_KEY, fetch: fixture.fetch }),
		);

		fixture.assertConsumed();
		expectSafeError(result);
		expect(result.errorMessage).toContain("gpt-6-astra");
		expect(result.errorStatus).toBeUndefined();
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
		expect(events.some(event => event.type === "done")).toBe(false);
	});

	it.each([400, 599])("preserves nested upstream HTTP %s without exposing diagnostics", async httpStatus => {
		const fixture = createHttpFixture([
			...bootstrapSteps(),
			started(),
			{
				method: "POST",
				path: STATUS_PATH,
				response: {
					status: "completed",
					request_id: REQUEST_ID,
					response: {
						status: "error",
						payload: {
							reason: "unknown",
							httpStatus,
							message: `Upstream failure ${COOKIE}`,
							rootCause: { message: SANDBOX_TOKEN },
							codexRequestDebug: { resourcesToken: RESOURCE_TOKEN, syncToken: SYNC_TOKEN },
						},
					},
				},
			},
		]);
		const { events, result } = await collect(
			streamOpenAIPrism(createModel(), createContext(), { apiKey: API_KEY, fetch: fixture.fetch }),
		);

		fixture.assertConsumed();
		expectSafeError(result);
		expect(result.errorStatus).toBe(httpStatus);
		expect(result.errorMessage).toContain("gpt-6-astra");
		expect(result.errorMessage).toContain(`HTTP ${httpStatus}`);
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
		expect(events.some(event => event.type === "done")).toBe(false);
	});

	it.each([undefined, null, "400", 399, 600, 400.5, { httpStatus: 400 }])(
		"does not forward an invalid nested HTTP status %j",
		async httpStatus => {
			const fixture = createHttpFixture([
				...bootstrapSteps(),
				started(),
				{
					method: "POST",
					path: STATUS_PATH,
					response: {
						status: "completed",
						request_id: REQUEST_ID,
						response: {
							status: "error",
							payload: { httpStatus, message: COOKIE, rootCause: SANDBOX_TOKEN, codexRequestDebug: SYNC_TOKEN },
						},
					},
				},
			]);
			const result = await streamOpenAIPrism(createModel(), createContext(), {
				apiKey: API_KEY,
				fetch: fixture.fetch,
			}).result();

			fixture.assertConsumed();
			expectSafeError(result);
			expect(result.errorStatus).toBeUndefined();
			expect(result.errorMessage).toContain("gpt-6-astra");
			expect(result.errorMessage).not.toContain("HTTP");
		},
	);

	it("rejects malformed external JSON without including the response body in its error", async () => {
		const fixture = createHttpFixture([
			{
				method: "GET",
				path: "/api/auth/session",
				response: null,
				rawBody: `{"user": ${COOKIE} ${SANDBOX_TOKEN}`,
			},
		]);
		const result = await streamOpenAIPrism(createModel(), createContext(), {
			apiKey: API_KEY,
			fetch: fixture.fetch,
		}).result();

		fixture.assertConsumed();
		expectSafeError(result);
	});

	it.each(["aborted", "error"] as const)(
		"resumes the last successful native turn after a %s turn",
		async failureReason => {
			const controller = new AbortController();
			if (failureReason === "aborted") {
				vi.spyOn(scheduler, "wait").mockImplementation(async (_delay, options) => {
					controller.abort();
					options?.signal?.throwIfAborted();
				});
			}
			const failureSteps: HttpStep[] =
				failureReason === "aborted"
					? [pending(SECOND_STATE), { method: "POST", path: STOP_PATH, response: { status: "stopped" } }]
					: [
							{
								method: "POST",
								path: STATUS_PATH,
								response: {
									status: "completed",
									request_id: REQUEST_ID,
									response: { status: "error", payload: { output: [] } },
								},
							},
						];
			const fixture = createHttpFixture([
				...bootstrapSteps(),
				started(),
				completed("42"),
				...bootstrapSteps().slice(0, 2),
				started(),
				...failureSteps,
				...bootstrapSteps(),
				started(),
				completed("The earlier sum was 42.", "resp_resumed"),
			]);
			const context = createContext();
			const options = {
				apiKey: API_KEY,
				fetch: fixture.fetch,
				providerSessionState: new Map<string, ProviderSessionState>(),
			};
			const first = await streamOpenAIPrism(createModel(), context, options).result();
			expect(first.stopReason).toBe("stop");
			context.messages.push(first, { role: "user", content: "Interrupted request.", timestamp: 3 });
			const failed = await streamOpenAIPrism(createModel(), context, {
				...options,
				signal: controller.signal,
			}).result();
			expect(failed.stopReason).toBe(failureReason);
			expect(failed.providerPayload).toBeUndefined();
			context.messages.push(failed, { role: "user", content: "Recall the earlier sum instead.", timestamp: 4 });
			const resumed = await streamOpenAIPrism(createModel(), context, options).result();
			fixture.assertConsumed();
			expect(resumed.stopReason).toBe("stop");
			expect(textOf(resumed)).toBe("The earlier sum was 42.");
			expect(PrismHttpClient.prototype.createConversation).toHaveBeenCalledTimes(1);
			const starts = fixture.requests
				.filter(request => request.path === START_PATH)
				.map(request => record(request.body));
			expect(starts.map(start => start.conversationId)).toEqual([CONVERSATION_ID, CONVERSATION_ID, CONVERSATION_ID]);
			expect(starts[2]?.previousResponseId).toBe(RESPONSE_ID);
			expect(inputMessages(starts[2]).filter(message => message.role !== "system")).toEqual([
				{ role: "user", text: "Interrupted request.\n\nRecall the earlier sum instead." },
			]);
		},
	);

	it("makes no request when the caller has already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fixture = createHttpFixture([]);
		const { events, result } = await collect(
			streamOpenAIPrism(createModel(), createContext(), {
				apiKey: API_KEY,
				fetch: fixture.fetch,
				signal: controller.signal,
			}),
		);

		fixture.assertConsumed();
		expect(result.stopReason).toBe("aborted");
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
	});

	it("stops a running turn with its latest opaque state using an independent signal after polling is aborted", async () => {
		const controller = new AbortController();
		const wait = vi.spyOn(scheduler, "wait").mockImplementation(async (_delay, options) => {
			controller.abort();
			options?.signal?.throwIfAborted();
		});
		const fixture = createHttpFixture([
			...bootstrapSteps(),
			started(),
			pending(SECOND_STATE),
			{ method: "POST", path: STOP_PATH, response: { status: "stopped" } },
		]);
		const result = await streamOpenAIPrism(createModel(), createContext(), {
			apiKey: API_KEY,
			fetch: fixture.fetch,
			signal: controller.signal,
		}).result();

		fixture.assertConsumed();
		expect(result.stopReason).toBe("aborted");
		expect(wait).toHaveBeenCalledTimes(1);
		const start = record(fixture.requests.find(request => request.path === START_PATH)?.body);
		const stop = fixture.requests.at(-1);
		expect(stop?.body).toEqual({
			request_id: REQUEST_ID,
			conversation_id: start.conversationId,
			turn_state: SECOND_STATE,
		});
		expect(stop?.signal).toBeInstanceOf(AbortSignal);
		expect(stop?.signal).not.toBe(controller.signal);
		expect(stop?.signal?.aborted).toBe(false);
	});

	it("round-trips local XML tools and never treats remote sandbox previews as local calls", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const localCall =
			'<function_calls><invoke name="read"><parameter name="path">src/example.ts</parameter></invoke></function_calls>';
		const fixture = createHttpFixture([
			...bootstrapSteps(),
			started(),
			pending(
				SECOND_STATE,
				[],
				[{ line_index: 12, name: "exec_command", call_type: "function_call", arguments_preview: '{"cmd":"pwd"}' }],
			),
			completed(localCall),
			...bootstrapSteps(PROJECT_ID, "fixture-b"),
			started(),
			completed("The file exports the answer."),
		]);
		const context: Context = {
			systemPrompt: ["Use the local read tool for local source files."],
			messages: [{ role: "user", content: "Read src/example.ts and describe it.", timestamp: 1 }],
			tools: [readTool],
		};
		const first = await collect(streamSimple(createModel(), context, { apiKey: API_KEY, fetch: fixture.fetch }));
		expect(first.result.stopReason).toBe("toolUse");
		const calls = first.result.content.filter(block => block.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ name: "read", arguments: { path: "src/example.ts" } });
		expect(first.events.filter(event => event.type === "toolcall_end")).toHaveLength(1);
		expect(first.events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
		expect(first.events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
		expect(textOf(first.result)).not.toContain("<invoke");
		const call = calls[0];
		if (!call) throw new Error("Expected local read call");
		const nextContext: Context = {
			...context,
			messages: [
				...context.messages,
				first.result,
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "export const answer = 42;" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		const second = await streamOpenAIPrism(createModel(), nextContext, {
			apiKey: API_KEY,
			fetch: fixture.fetch,
		}).result();

		fixture.assertConsumed();
		expect(second.stopReason).toBe("stop");
		expect(textOf(second)).toBe("The file exports the answer.");
		const starts = fixture.requests.filter(request => request.path === START_PATH);
		const firstBody = record(starts[0]?.body);
		expect(firstBody.tools).toBeUndefined();
		const firstUser = (
			firstBody.input as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
		).find(item => item.role === "user");
		const textParts = firstUser?.content.filter(part => part.type === "input_text");
		expect(textParts).toHaveLength(1);
		expect(textParts?.[0]?.text).toContain("Read src/example.ts and describe it.");
		expect(textParts?.[0]?.text).toContain("<invoke name=");
		const firstMessages = inputMessages(firstBody);
		expect(firstMessages.filter(message => message.role === "system")).toEqual([
			{ role: "system", text: context.systemPrompt![0]! },
		]);
		expect(
			firstMessages
				.map(message => message.text)
				.join("\n")
				.match(/# Client execution contract/g),
		).toHaveLength(1);
		expect(textParts?.[0]?.text).toContain("# Client execution contract");
		expect(textParts?.[0]?.text).toContain("Read a local file");
		const replay = inputMessages(starts[1]?.body);
		expect(replay.some(message => message.role === "assistant")).toBe(false);
		const replayedResult = replay.find(message => message.text.includes("export const answer = 42;"));
		expect(replayedResult?.text).toContain("<tool_response>");
		expect(record(starts[1]?.body).conversationId).toBe(record(starts[0]?.body).conversationId);
		expect(record(starts[1]?.body).previousResponseId).toBe(RESPONSE_ID);
		expect(PrismHttpClient.prototype.createConversation).toHaveBeenCalledTimes(1);
	});

	it("routes toolChoice none through the public API without creating local calls from XML-looking text", async () => {
		const text =
			'<function_calls><invoke name="read"><parameter name="path">example.ts</parameter></invoke></function_calls>';
		const fixture = createHttpFixture([...bootstrapSteps(), started(), completed(text)]);
		const { events, result } = await collect(
			streamSimple(
				createModel("gpt-5.6-terra"),
				{ ...createContext(), tools: [readTool] },
				{
					apiKey: API_KEY,
					fetch: fixture.fetch,
					toolChoice: "none",
				},
			),
		);

		fixture.assertConsumed();
		expect(result.stopReason).toBe("stop");
		expect(result.content.some(block => block.type === "toolCall")).toBe(false);
		expect(events.some(event => event.type.startsWith("toolcall_"))).toBe(false);
		expect(textOf(result)).toBe(text);
		const start = record(fixture.requests.find(request => request.path === START_PATH)?.body);
		expect(start.tools).toBeUndefined();
		expect(record(start.metadata).model).toBe("gpt-5.6-terra");
		const messages = inputMessages(start);
		expect(messages.find(message => message.role === "system")?.text).toContain("# Client execution contract");
		expect(messages.filter(message => message.role === "user")).toEqual([{ role: "user", text: "What is 23 + 19?" }]);
	});
});
