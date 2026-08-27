import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, readFile } from "@oh-my-soup/pi-coding-agent/capability/fs";
import type { MCPServerConfig } from "@oh-my-soup/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-soup/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-soup/pi-coding-agent/modes/theme/theme";
import { getMCPConfigPath, getProjectDir, removeWithRetries, setProjectDir } from "@oh-my-soup/pi-utils";

const originalProjectDir = getProjectDir();

async function writeExternalProjectConfig(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
	await Bun.write(getMCPConfigPath("project", projectDir), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

function createController(discoveredCommands: string[]) {
	const refreshMCPTools = vi.fn(async () => {});
	const setMCPPromptCommands = vi.fn();
	const settings = {
		get: vi.fn((key: string) => (key === "mcp.enableProjectConfig" ? true : undefined)),
	};
	const mcpManager = {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async () => {
			const configPath = getMCPConfigPath("project", getProjectDir());
			const content = await readFile(configPath);
			if (content) {
				const parsed = JSON.parse(content) as {
					mcpServers?: Record<string, { command?: string; env?: Record<string, string> }>;
				};
				for (const server of Object.values(parsed.mcpServers ?? {})) {
					if (server.command) discoveredCommands.push(server.command);
					if (server.env) discoveredCommands.push(...Object.values(server.env));
				}
			}
			return { errors: new Map<string, string>() };
		}),
		getTools: vi.fn(() => []),
	};
	const controller = new MCPCommandController({
		chatContainer: { addChild: vi.fn() },
		present: vi.fn(),
		presentCommandOutput: vi.fn(),
		ui: { requestRender: vi.fn() },
		editor: {},
		showError: vi.fn(),
		showStatus: vi.fn(),
		oauthManualInput: {
			hasPending: vi.fn(() => false),
			pendingProviderId: undefined,
			tryClaimInput: vi.fn(),
		},
		session: {
			refreshMCPTools,
			setMCPPromptCommands,
			modelRegistry: { authStorage: undefined },
		},
		settings,
		mcpManager,
	} as never);

	return { controller, mcpManager, refreshMCPTools, setMCPPromptCommands };
}

describe("/mcp reload picks up external mcp.json edits", () => {
	let projectDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-mcp-reload-project-"));
		setProjectDir(projectDir);
		clearCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCache();
		setProjectDir(originalProjectDir);
		await removeWithRetries(projectDir);
	});

	test("reloadServers clears fs cache before rediscovery", async () => {
		const configPath = getMCPConfigPath("project", projectDir);
		await writeExternalProjectConfig(projectDir, {
			test: { type: "stdio", command: "old-cmd", env: { VERSION: "old-value" } },
		});

		const primed = await readFile(configPath);
		expect(primed).toContain("old-cmd");
		expect(primed).toContain("old-value");

		await Bun.write(
			configPath,
			`${JSON.stringify(
				{ mcpServers: { test: { type: "stdio", command: "new-cmd", env: { VERSION: "new-value" } } } },
				null,
				2,
			)}\n`,
		);

		const stale = await readFile(configPath);
		expect(stale).toContain("old-cmd");
		expect(stale).toContain("old-value");
		expect(stale).not.toContain("new-cmd");

		const discoveredCommands: string[] = [];
		const { controller, mcpManager, refreshMCPTools, setMCPPromptCommands } = createController(discoveredCommands);
		await controller.reloadServers();

		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(setMCPPromptCommands).toHaveBeenCalledWith([]);
		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		expect(discoveredCommands).toContain("new-cmd");
		expect(discoveredCommands).toContain("new-value");
		expect(discoveredCommands).not.toContain("old-cmd");
		expect(discoveredCommands).not.toContain("old-value");
	});
});
