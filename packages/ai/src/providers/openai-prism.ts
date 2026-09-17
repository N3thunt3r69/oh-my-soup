/**
 * Cookie-authenticated Prism transport. A server-registered conversation owns
 * the native Codex history; only new user/tool-result input is sent on continuation.
 * Prism's remote tools are distinct from local tools carried by the XML dialect.
 */
import { scheduler } from "node:timers/promises";
import { Effort } from "@oh-my-soup/pi-catalog/effort";
import { calculateCost } from "@oh-my-soup/pi-catalog/models";
import { isRecord } from "@oh-my-soup/pi-utils";
import { encodeInbandToolHistory, renderInbandToolPrompt, wrapInbandToolStream } from "../dialect";
import * as AIError from "../error";
import type {
	AssistantMessage,
	Context,
	ProviderSessionState,
	StreamFunction,
	StreamOptions,
	ToolChoice,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { PRISM_BASE_URL, PrismHttpClient, parsePrismCredentials } from "./openai-prism-client";
import harnessPrompt from "./openai-prism-harness.md" with { type: "text" };
import type { ResponseInputImage, ResponseInputItem } from "./openai-responses-wire";
import { convertResponsesInputContent } from "./openai-shared";

export interface OpenAIPrismOptions extends StreamOptions {
	reasoning?: Effort;
	/** Dedicated Prism project UUID or project URL; overrides the stored project. */
	projectId?: string;
	toolChoice?: ToolChoice;
	/** Drop Codex reasoning summaries from the emitted stream. */
	hideThinkingSummary?: boolean;
}

const POLL_INTERVAL_MS = 3_000;
const TURN_TIMEOUT_MS = 15 * 60_000;

interface PrismConversation {
	sandboxUrl: URL;
	sandboxToken: string;
	snapshot: Record<string, unknown>;
}

interface PrismSessionState extends ProviderSessionState {
	conversations: Map<string, PrismConversation>;
}

function getSessionState(options: OpenAIPrismOptions): PrismSessionState | undefined {
	const store = options.providerSessionState;
	if (!store) return undefined;
	const key = "openai-prism";
	const existing = store.get(key) as PrismSessionState | undefined;
	if (existing) return existing;
	const conversations = new Map<string, PrismConversation>();
	const state: PrismSessionState = { conversations, close: () => conversations.clear() };
	store.set(key, state);
	return state;
}

/** Match the browser: context followed by one user item with one text part. */
function toPrismInput(context: Context, supportsImages: boolean, tail: readonly string[]): ResponseInputItem[] {
	const input: ResponseInputItem[] = [];
	const systemText = context.systemPrompt?.join("\n\n");
	if (systemText?.trim()) input.push({ role: "system", content: [{ type: "input_text", text: systemText }] });
	const text: string[] = [];
	const images: ResponseInputImage[] = [];
	for (const message of encodeInbandToolHistory(context.messages, "xml", context.tools)) {
		if (message.role === "developer") {
			const content = convertResponsesInputContent(message.content, supportsImages, false);
			if (content?.length) input.push({ role: "system", content });
		} else if (message.role === "user") {
			for (const part of convertResponsesInputContent(message.content, supportsImages, false) ?? []) {
				if (part.type === "input_text") text.push(part.text);
				else if (part.type === "input_image") images.push(part);
			}
		}
	}
	text.push(...tail.filter(value => value.trim()));
	input.push({ type: "message", role: "user", content: [{ type: "input_text", text: text.join("\n\n") }, ...images] });
	return input;
}

/** Read only the supported response fields; opaque turn_state is never decoded. */
function validateTurn(turn: Record<string, unknown>, pollState: unknown): void {
	if (turn.status !== "started" && turn.status !== "pending" && turn.status !== "completed") {
		throw new AIError.ProviderResponseError("Prism returned an invalid turn status");
	}
	if (turn.status !== "completed" && pollState == null) {
		throw new AIError.ProviderResponseError("Prism returned no polling state");
	}
}

export const streamOpenAIPrism: StreamFunction<"openai-prism"> = (model, context, rawOptions) => {
	const options = rawOptions as OpenAIPrismOptions | undefined;
	const stream = new AssistantMessageEventStream();
	const tools = options?.toolChoice === "none" ? [] : (context.tools ?? []);
	const controller = new AbortController();
	const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-prism",
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const startedAt = performance.now();
		let firstTokenAt: number | undefined;
		let client: PrismHttpClient | undefined;
		let requestId: string | undefined;
		let turnState: unknown;
		let completed = false;
		let conversationId: string | undefined;
		let sessionState: PrismSessionState | undefined;
		let conversation: PrismConversation | undefined;
		const timeout = setTimeout(
			() => controller.abort(new AIError.StreamTimeoutError("Prism turn timed out")),
			TURN_TIMEOUT_MS,
		);
		const seenThinking = new Set<string>();
		const emitThinking = (text: string) => {
			if (!text.trim() || options?.hideThinkingSummary || seenThinking.has(text)) return;
			seenThinking.add(text);
			firstTokenAt ??= performance.now();
			const contentIndex = output.content.length;
			output.content.push({ type: "thinking", thinking: text });
			stream.push({ type: "thinking_start", contentIndex, partial: output });
			stream.push({ type: "thinking_delta", contentIndex, delta: text, partial: output });
			stream.push({ type: "thinking_end", contentIndex, content: text, partial: output });
		};
		try {
			signal.throwIfAborted();
			if (!options?.apiKey) throw new AIError.MissingApiKeyError(model.provider);
			if (options.toolChoice && options.toolChoice !== "auto" && options.toolChoice !== "none") {
				throw new AIError.ConfigurationError("Prism supports toolChoice auto or none, not forced tool selection");
			}
			const credentials = parsePrismCredentials(options.apiKey, options.projectId);
			client = new PrismHttpClient(credentials, {
				fetch: options.fetch,
				headers: { ...model.headers, ...options.headers },
				onResponse: options.onResponse,
			});
			stream.push({ type: "start", partial: output });
			const { userId } = await client.authenticate(signal);
			const projectId = credentials.projectId;
			// Failed turns stay in OMS history but do not advance the native response pointer.
			// Do not skip a successful foreign turn: attaching that transcript would lose context.
			const previousIndex = context.messages.findLastIndex(
				message =>
					message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted",
			);
			const previous = context.messages[previousIndex];
			const history = previous?.role === "assistant" ? previous.providerPayload : undefined;
			if (
				previous &&
				(history?.type !== "openaiPrismHistory" || history.projectId !== projectId || history.userId !== userId)
			) {
				throw new AIError.ConfigurationError(
					"This transcript has no resumable Prism conversation for this account and project. Start a new Prism chat.",
				);
			}
			conversationId =
				history?.type === "openaiPrismHistory" ? history.conversationId : await client.createConversation(signal);
			const workspaceId = conversationId.replace(/^cdx1_/, "");
			sessionState = getSessionState(options);
			conversation = sessionState?.conversations.get(conversationId);
			if (!conversation) {
				const sandbox = await client.request("/api/backend/1/new", { method: "POST", signal });
				if (typeof sandbox.url !== "string" || typeof sandbox.token !== "string" || !sandbox.token) {
					throw new AIError.ProviderResponseError("Prism returned invalid sandbox credentials");
				}
				const sandboxUrl = new URL(sandbox.url.endsWith("/") ? sandbox.url : `${sandbox.url}/`);
				if (sandboxUrl.origin !== PRISM_BASE_URL || sandboxUrl.username || sandboxUrl.password) {
					throw new AIError.ProviderResponseError("Prism returned a sandbox outside the trusted origin");
				}
				const sandboxToken = sandbox.token;
				const resource = await client.request(`/api/projects/${projectId}/sandbox/resources-token`, {
					method: "POST",
					body: { sandbox_session_id: null, sandbox_token: sandboxToken },
					signal,
				});
				if (typeof resource.access_token !== "string" || typeof resource.resources_base_url !== "string") {
					throw new AIError.ProviderResponseError("Prism returned invalid project resource credentials");
				}
				const resourcesUrl = new URL(resource.resources_base_url);
				if (resourcesUrl.origin !== PRISM_BASE_URL || resourcesUrl.username || resourcesUrl.password) {
					throw new AIError.ProviderResponseError("Prism returned resources outside the trusted origin");
				}
				await client.request(new URL("resources-token", sandboxUrl).href, {
					method: "POST",
					sandboxToken,
					signal,
					body: {
						token: resource.access_token,
						resourceBaseUrl: resource.resources_base_url.replace(/\/?$/, "/"),
						projectId,
					},
				});
				const y = await client.request("/api/y", {
					method: "POST",
					signal,
					body: {
						docId: projectId,
						requestContext: {
							source: "initial-bootstrap",
							bootstrapAttempt: 1,
							previouslyConnected: false,
							reprovisionSource: null,
							sandboxUrl: sandboxUrl.href,
							sandboxId: null,
							sandboxSessionId: null,
							maxAttempts: 5,
							requestSeriesId: crypto.randomUUID(),
						},
					},
				});
				if (typeof y.token !== "string" || typeof y.url !== "string" || y.docId !== projectId) {
					throw new AIError.ProviderResponseError("Prism returned invalid project synchronization credentials");
				}
				await client.request(new URL("token", sandboxUrl).href, { method: "POST", sandboxToken, body: y, signal });
				const sync = await client.request(new URL("wait-for-sync?wait_ms=10000", sandboxUrl).href, {
					sandboxToken,
					signal,
				});
				if (sync.status !== "synced")
					throw new AIError.ProviderResponseError("Prism project sandbox did not synchronize");
				const timestamp = new Date().toISOString();
				const snapshot = {
					user_id: userId,
					project_id: projectId,
					conversation_id: conversationId,
					sandbox_url: sandboxUrl.href,
					sandbox_token: sandboxToken,
					workspace_session_id: workspaceId,
					codex_session_id: null,
					last_turn_id: null,
					endpoint_identity: null,
					last_exec_at: null,
					transcript_cursor: 0,
					created_at: timestamp,
					updated_at: timestamp,
					last_saved_at: null,
				};
				conversation = { sandboxUrl, sandboxToken, snapshot };
			}
			const { sandboxUrl, sandboxToken } = conversation;
			const callContext: Context = {
				...context,
				messages: context.messages.slice(previousIndex + 1),
				systemPrompt: tools.length ? context.systemPrompt : [...(context.systemPrompt ?? []), harnessPrompt],
			};
			const tail = tools.length ? [harnessPrompt, renderInbandToolPrompt(tools, "xml")] : [];
			const effort = options.reasoning;
			const reasoningEffort =
				effort === Effort.Minimal || effort === Effort.Low
					? "low"
					: effort === Effort.High
						? "high"
						: effort === Effort.XHigh || effort === Effort.Max
							? "xhigh"
							: "medium";
			let turn = await client.request("/api/llm/response_with_tools_start", {
				method: "POST",
				signal,
				body: {
					input: toPrismInput(callContext, model.input.includes("image"), tail),
					conversationId,
					previousResponseId: previous?.role === "assistant" ? previous.responseId : undefined,
					metadata: {
						projectId,
						userId,
						model: model.requestModelId ?? model.id,
						reasoning_effort: reasoningEffort,
						frontend_origin: PRISM_BASE_URL,
						sandbox_url: sandboxUrl.href,
						sandbox_token: sandboxToken,
						codex_listen_snapshot: JSON.stringify(conversation.snapshot),
					},
				},
			});
			if (typeof turn.request_id !== "string" || !turn.request_id) {
				throw new AIError.ProviderResponseError("Prism returned no request ID");
			}
			requestId = turn.request_id;
			let polls = 0;
			for (;;) {
				turnState = turn.turn_state ?? turnState;
				validateTurn(turn, turnState);
				if (isRecord(turn.codex_listen_snapshot)) conversation.snapshot = turn.codex_listen_snapshot;
				const progress = turn.codex_live_progress;
				if (isRecord(progress)) {
					if (Array.isArray(progress.reasoningSummaries)) {
						for (const summary of progress.reasoningSummaries) {
							if (isRecord(summary) && typeof summary.text === "string") emitThinking(summary.text);
						}
					}
					// Remote Codex tool previews must never dispatch local OMS tools.
					if (Array.isArray(progress.toolCalls)) {
						for (const call of progress.toolCalls) {
							if (isRecord(call) && typeof call.name === "string")
								emitThinking(`[Prism remote tool: ${call.name}]`);
						}
					}
				}
				if (turn.status === "completed") {
					completed = true;
					break;
				}
				if (polls++) await scheduler.wait(POLL_INTERVAL_MS, { signal });
				turn = await client.request("/api/llm/response_with_tools_status", {
					method: "POST",
					body: { request_id: requestId, turn_state: turnState },
					signal,
				});
			}
			const response = turn.response;
			if (!isRecord(response) || response.status !== "success" || !isRecord(response.payload)) {
				// Backend diagnostics can contain cookie/sandbox credentials. Do not echo them.
				const status = isRecord(response) && isRecord(response.payload) ? response.payload.httpStatus : undefined;
				const message = `Prism model turn failed for ${model.id}`;
				if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
					throw new AIError.ProviderHttpError(
						`${message} (HTTP ${status}); check the project and session in Prism`,
						status,
					);
				}
				throw new AIError.ProviderResponseError(`${message}; check the project and session in Prism`);
			}
			const payload = response.payload;
			if (!Array.isArray(payload.output))
				throw new AIError.ProviderResponseError("Prism returned invalid model output");
			if (isRecord(payload.codexListenSnapshot)) conversation.snapshot = payload.codexListenSnapshot;
			output.providerPayload = { type: "openaiPrismHistory", conversationId, projectId, userId };
			if (typeof payload.id === "string") output.responseId = payload.id;
			for (const item of payload.output) {
				if (!isRecord(item)) throw new AIError.ProviderResponseError("Prism returned an invalid output item");
				if (item.type === "reasoning" && Array.isArray(item.summary)) {
					for (const part of item.summary) {
						if (isRecord(part) && part.type === "summary_text" && typeof part.text === "string")
							emitThinking(part.text);
					}
				} else if (item.type === "message" && item.role === "assistant") {
					if (!Array.isArray(item.content))
						throw new AIError.ProviderResponseError("Prism returned invalid message content");
					for (const part of item.content) {
						if (!isRecord(part))
							throw new AIError.ProviderResponseError("Prism returned an invalid content part");
						const text =
							part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : undefined;
						if (typeof text !== "string" || !text) continue;
						firstTokenAt ??= performance.now();
						const contentIndex = output.content.length;
						output.content.push({ type: "text", text });
						stream.push({ type: "text_start", contentIndex, partial: output });
						stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
						stream.push({ type: "text_end", contentIndex, content: text, partial: output });
					}
				}
			}
			if (!output.content.some(block => block.type === "text" && block.text.trim())) {
				throw new AIError.ProviderResponseError("Prism returned no assistant text");
			}
			sessionState?.conversations.set(conversationId, conversation);
			if (isRecord(payload.usage)) {
				const usage = payload.usage;
				const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
				const cached =
					isRecord(usage.input_tokens_details) && typeof usage.input_tokens_details.cached_tokens === "number"
						? usage.input_tokens_details.cached_tokens
						: 0;
				output.usage.input = Math.max(0, input - cached);
				output.usage.cacheRead = cached;
				output.usage.output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
				output.usage.totalTokens =
					typeof usage.total_tokens === "number" ? usage.total_tokens : input + output.usage.output;
				output.usage.cost = calculateCost(model, output.usage);
			}
			output.duration = performance.now() - startedAt;
			if (firstTokenAt !== undefined) output.ttft = firstTokenAt - startedAt;
			stream.push({ type: "done", reason: "stop", message: output });
		} catch (error) {
			if (conversationId) sessionState?.conversations.delete(conversationId);
			if (client && requestId && !completed) {
				try {
					await client.request("/api/llm/response_with_tools_stop", {
						method: "POST",
						timeoutMs: 10_000,
						body: { request_id: requestId, conversation_id: conversationId, turn_state: turnState },
					});
				} catch {
					/* Best-effort remote cancellation must not replace the original error. */
				}
			}
			const failure = await AIError.finalize(controller.signal.aborted ? controller.signal.reason : error, {
				api: model.api,
				provider: model.provider,
				model: model.id,
				signal: options?.signal,
			});
			output.stopReason = failure.stopReason;
			output.errorId = failure.id;
			output.errorStatus = failure.status;
			output.errorMessage = failure.message;
			output.duration = performance.now() - startedAt;
			if (firstTokenAt !== undefined) output.ttft = firstTokenAt - startedAt;
			stream.push({ type: "error", reason: failure.stopReason, error: output });
		} finally {
			clearTimeout(timeout);
			stream.end();
		}
	})();
	return tools.length ? wrapInbandToolStream(stream, tools, "xml", () => controller.abort()) : stream;
};
