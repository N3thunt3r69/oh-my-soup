import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-soup/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-soup/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-soup/pi-utils";

async function expectContextReload(reset: (session: AgentSession) => Promise<unknown>): Promise<void> {
	using tempDir = TempDir.createSync("@pi-context-reload-");
	const marker = Bun.nanoseconds().toString(36);
	const original = `ORIGINAL_RULES_${marker}`;
	const updated = `UPDATED_RULES_${marker}`;
	const agentsMd = path.join(tempDir.path(), "AGENTS.md");
	await fs.writeFile(agentsMd, original);

	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("openai", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry,
		settings: Settings.isolated({ "compaction.enabled": false }),
		model: buildModel({
			id: `context-reload-${marker}`,
			name: "Context Reload Model",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		}),
		disableExtensionDiscovery: true,
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});

	try {
		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt.join("\n")).toContain(original);

		await fs.writeFile(agentsMd, updated);
		expect(await reset(session)).toBeTruthy();

		const rebuilt = session.systemPrompt.join("\n");
		expect(rebuilt).toContain(updated);
		expect(rebuilt).not.toContain(original);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

describe("AgentSession context-file reload on session reset", () => {
	it("re-reads an edited AGENTS.md after newSession()", async () => {
		await expectContextReload(session => session.newSession());
	});

	it("re-reads an edited AGENTS.md after resetSessionContext()", async () => {
		await expectContextReload(session => session.resetSessionContext());
	});
});
