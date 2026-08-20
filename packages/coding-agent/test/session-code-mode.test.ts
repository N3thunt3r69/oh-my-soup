import { afterEach, describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { buildToolNamespacesInfo, resolveCodeMode } from "../src/session/code-mode";
import { SessionManager } from "../src/session/session-manager";

const ENABLED = ["eval", "ask", "todo", "yield", "read", "bash", "edit", "mcp__gmail__search"];

describe("resolveCodeMode", () => {
	test("off: inactive regardless of catalog flag", () => {
		const r = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "off",
			enabledToolNames: ENABLED,
		});
		expect(r.active).toBe(false);
		expect(r.directToolNames).toEqual(new Set(ENABLED));
	});
	test("auto + code_mode_only: active, keep-set only", () => {
		const r = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			enabledToolNames: ENABLED,
		});
		expect(r.active).toBe(true);
		expect([...r.directToolNames].sort()).toEqual(["ask", "eval", "todo", "yield"]);
	});
	test("auto without flag: inactive", () => {
		expect(resolveCodeMode({ provider: "openai-codex", setting: "auto", enabledToolNames: ENABLED }).active).toBe(
			false,
		);
	});
	test("on: active without catalog flag", () => {
		expect(resolveCodeMode({ provider: "openai-codex", setting: "on", enabledToolNames: ENABLED }).active).toBe(true);
	});
	test("non-codex provider: inactive even when on", () => {
		expect(resolveCodeMode({ provider: "anthropic", setting: "on", enabledToolNames: ENABLED }).active).toBe(false);
	});
	test("extra direct tools honored only when enabled", () => {
		const r = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			extraDirectTools: ["read", "nonexistent"],
			enabledToolNames: ENABLED,
		});
		expect(r.directToolNames.has("read")).toBe(true);
		expect(r.directToolNames.has("nonexistent")).toBe(false);
	});
	test("keep-set intersects enabled tools", () => {
		const r = resolveCodeMode({
			provider: "openai-codex",
			toolMode: "code_mode_only",
			setting: "auto",
			enabledToolNames: ["eval", "read"],
		});
		expect([...r.directToolNames]).toEqual(["eval"]);
	});
});

describe("buildToolNamespacesInfo", () => {
	test("shape and flags", () => {
		const info = buildToolNamespacesInfo({
			tools: [
				{ name: "eval", loadMode: "essential" },
				{ name: "read", loadMode: "essential" },
				{ name: "browser", loadMode: "discoverable" },
				{ name: "mcp__gmail__search", mcpServerName: "gmail" },
			],
			directToolNames: new Set(["eval"]),
		});
		expect(info.functions.name).toBe("functions");
		expect(info.functions.functions.eval).toEqual({
			name: "eval",
			direct: true,
			code_mode_name: "eval",
			deferred: false,
			source: { kind: "harness" },
		});
		expect(info.functions.functions.read).toEqual({
			name: "read",
			direct: false,
			code_mode_name: "read",
			deferred: false,
			source: { kind: "harness" },
		});
		expect(info.functions.functions.browser.deferred).toBe(true);
		expect(info.functions.functions.mcp__gmail__search.source).toEqual({ kind: "mcp", server_name: "gmail" });
	});
});

describe("Code Mode session reconciliation", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function model(provider: string, toolMode?: "code_mode_only"): Model {
		return buildModel({
			id: `${provider}-${toolMode ?? "direct"}`,
			name: provider,
			api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
			provider,
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
			toolMode,
		});
	}

	function tool(name: string): AgentTool {
		return {
			name,
			label: name,
			description: name,
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: name }] };
			},
		};
	}

	function createSession(settings: Settings): { session: AgentSession; directModel: Model; codeModel: Model } {
		const codeModel = model("openai-codex", "code_mode_only");
		const directModel = model("openai");
		const tools = [tool("eval"), tool("read")];
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: codeModel, systemPrompt: [], tools } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: {
				getApiKey: async () => "test-key",
				hasConfiguredAuth: () => true,
				refreshSelectedModelMetadata: async (value: Model) => value,
				clearSuppressedSelector: () => undefined,
			} as never,
			toolRegistry: new Map(tools.map(value => [value.name, value])),
			builtInToolNames: tools.map(value => value.name),
			rebuildSystemPrompt: async names => ({ systemPrompt: [`tools:${names.join(",")}`] }),
		});
		sessions.push(session);
		return { session, directModel, codeModel };
	}
	test("model switches reapply the full enabled set across Code Mode boundaries", async () => {
		const { session, directModel, codeModel } = createSession(
			Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
		);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval"]);
		expect(session.getEnabledToolNames()).toEqual(["eval", "read"]);

		await session.setModel(directModel);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval", "read"]);

		await session.setModel(codeModel);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval"]);
	});

	test("runtime setting changes immediately reconcile the Code Mode surface", async () => {
		const settings = Settings.isolated();
		settings.set("providers.openai-codex.codeMode", "auto");
		const { session } = createSession(settings);
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval"]);

		settings.set("providers.openai-codex.codeMode", "off");
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.agent.state.tools.map(value => value.name)).toEqual(["eval", "read"]);
	});
});
