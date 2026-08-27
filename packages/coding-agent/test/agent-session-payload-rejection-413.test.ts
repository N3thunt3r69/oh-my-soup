import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-soup/pi-agent-core";
import * as compactionModule from "@oh-my-soup/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-soup/pi-ai";
import * as AIError from "@oh-my-soup/pi-ai/error";
import { getBundledModel } from "@oh-my-soup/pi-catalog/models";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-soup/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-soup/pi-utils";

describe("AgentSession payload-rejection 413 handling", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@oms-payload-413-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function assistantError(
		model: Model,
		errorMessage: string,
		options: { errorStatus?: number; inputTokens?: number } = {},
	): AssistantMessage {
		const inputTokens = options.inputTokens ?? 0;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: inputTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: inputTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			errorStatus: options.errorStatus,
			timestamp: Date.now(),
		};
		message.errorId = AIError.classifyMessage(message);
		return message;
	}

	function createSession(
		model: Model,
		settingsOverrides: Parameters<typeof Settings.isolated>[0] = {},
	): { sessionManager: SessionManager; notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> } {
		const userMessage: AgentMessage = { role: "user", content: "seed", timestamp: Date.now() };
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(userMessage);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [userMessage],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"contextPromotion.enabled": false,
				...settingsOverrides,
			}),
		});
		const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event);
		});
		return { sessionManager, notices };
	}

	async function settle(message: AssistantMessage): Promise<void> {
		if (!session) throw new Error("Expected active session");
		const completed = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end") completed.resolve();
		});
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		await completed.promise;
		unsubscribe();
		await session.waitForIdle();
	}

	function terminalErrors(sessionManager: SessionManager): AssistantMessage[] {
		return sessionManager
			.getBranch()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []))
			.filter(message => message.stopReason === "error");
	}

	it("persists an active-goal payload dead end without compaction or transport replay", async () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled Anthropic model");
		const model = { ...bundled, contextWindow: 200_000 };
		const { sessionManager, notices } = createSession(model);
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const continueSpy = vi.spyOn(session!.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session!.agent, "prompt").mockResolvedValue(undefined as never);
		const now = Date.now();
		session!.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "payload-dead-end",
				objective: "finish the goal",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		await settle(
			assistantError(
				model,
				"413 request body exceeds the configured payload limit (type=invalid_request_error param=request_too_large)",
			),
		);

		expect(prepareSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(
			notices.some(notice => notice.source === "compaction" && notice.message.includes("NOT a token-context")),
		).toBe(true);
		expect(terminalErrors(sessionManager)).toHaveLength(1);
		expect(
			sessionManager
				.buildSessionContext()
				.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
	});

	it("persists a blocked dual-flag bare 413 while excluding it from provider context", async () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled Anthropic model");
		const model = { ...bundled, contextWindow: 200_000 };
		const { sessionManager } = createSession(model);
		const message = assistantError(model, "413 status code (no body)");
		expect(AIError.is(message.errorId, AIError.Flag.ContextOverflow)).toBe(true);
		expect(AIError.isPayloadRejection(message)).toBe(true);

		await settle(message);

		expect(terminalErrors(sessionManager)).toHaveLength(1);
		expect(sessionManager.buildSessionContext().messages.map(candidate => candidate.role)).toEqual(["user"]);
		expect(sessionManager.buildSessionContext({ transcript: true }).messages).toHaveLength(2);
	});

	it("blocks a status-only 413 deterministically when the model has no context gauge", async () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled Anthropic model");
		const model = { ...bundled, contextWindow: null } as Model;
		const { sessionManager, notices } = createSession(model);

		await settle(assistantError(model, "Content Too Large", { errorStatus: 413 }));

		expect(notices.some(notice => notice.message.includes("no known context window"))).toBe(true);
		expect(terminalErrors(sessionManager)).toHaveLength(1);
	});

	it("reports usage-backed media overflow as a token problem when no recovery can run", async () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled Anthropic model");
		const model = { ...bundled, contextWindow: 200_000 };
		const { notices } = createSession(model, { "compaction.enabled": false });

		await settle(
			assistantError(model, "request_too_large: image count exceeds the limit of 20", { inputTokens: 250_000 }),
		);

		expect(notices.some(notice => notice.message.includes("IS a token-context problem"))).toBe(true);
		expect(notices.some(notice => notice.message.includes("NOT a token-context problem"))).toBe(false);
	});
});
