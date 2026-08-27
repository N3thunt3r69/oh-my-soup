import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpClient from "@oh-my-soup/pi-coding-agent/mcp/client";
import * as mcpConfigWriter from "@oh-my-soup/pi-coding-agent/mcp/config-writer";
import { MCPCommandController } from "@oh-my-soup/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-soup/pi-coding-agent/modes/theme/theme";
import { getConfigRootDir, getProjectDir, removeWithRetries, setAgentDir, setProjectDir } from "@oh-my-soup/pi-utils";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

type RenderedComponent = {
	render: (width: number) => readonly string[];
};

type RenderableBlock = {
	render: (width: number) => readonly string[];
	isTranscriptBlockFinalized: () => boolean;
};

function isRenderedComponent(value: unknown): value is RenderedComponent {
	return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function";
}

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return (
		isRenderedComponent(value) &&
		"isTranscriptBlockFinalized" in value &&
		typeof value.isTranscriptBlockFinalized === "function"
	);
}

describe("issue #956: interactive /mcp test", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-issue-956-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-issue-956-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);

		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify(
				{
					mcpServers: {
						github: {
							type: "stdio",
							command: "github-mcp-server",
							args: ["serve"],
						},
					},
				},
				null,
				2,
			),
		);
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	it("tests a connected server discovered from standalone .mcp.json", async () => {
		vi.useFakeTimers();
		const transport = {
			connected: true,
			request: vi.fn(),
			notify: vi.fn(),
			close: vi.fn(async () => {}),
		};
		const connection = {
			name: "github",
			config: { type: "stdio" as const, command: "github-mcp-server", args: ["serve"] },
			transport,
			serverInfo: { name: "GitHub MCP", version: "1.0.0" },
			capabilities: {},
		};
		const showError = vi.fn();
		const showStatus = vi.fn();
		const requestRender = vi.fn();
		const addChild = vi.fn();
		const presented: RenderableBlock[] = [];
		const refreshMCPTools = vi.fn();
		const connectToServer = vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		const listTools = vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "search_issues" }] as never);
		const disconnectServer = vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const controller = new MCPCommandController({
			mcpTestEscapeHandlers,
			chatContainer: { addChild },
			present: (content: unknown) => {
				for (const item of Array.isArray(content) ? content : [content]) addChild(item);
				requestRender();
			},
			presentCommandOutput: (content: unknown) => {
				for (const item of Array.isArray(content) ? content : [content]) {
					addChild(item);
					if (isRenderableBlock(item)) {
						presented.push(item);
					}
				}
				requestRender();
			},
			ui: { requestRender },
			editor: {},
			showError,
			showStatus,
			session: { refreshMCPTools },
			mcpManager: {
				prepareConfig: vi.fn(async config => config),
				getConnectionStatus: vi.fn(() => "connected"),
			},
		} as never);

		await controller.handle("/mcp test github");
		const signal = connectToServer.mock.calls[0]?.[2]?.signal;
		expect(signal?.aborted).toBe(false);
		expect(mcpTestEscapeHandlers).toHaveLength(1);
		expect(presented).toHaveLength(1);
		expect(presented[0]?.isTranscriptBlockFinalized()).toBe(true);
		const renderedHint = presented[0]?.render(80).join("\n") ?? "";
		expect(renderedHint).toContain(`Tested connection to "github".`);
		expect(renderedHint).not.toContain("(esc to cancel)");

		for (const handler of [...mcpTestEscapeHandlers]) {
			mcpTestEscapeHandlers.delete(handler);
			handler();
		}
		expect(showStatus).toHaveBeenCalledWith(`MCP test for "github" already finished`);
		expect(signal?.aborted).toBe(false);
		expect(mcpTestEscapeHandlers).toHaveLength(0);

		expect(showError).not.toHaveBeenCalled();
		expect(connectToServer).toHaveBeenCalledWith(
			"github",
			expect.objectContaining({ command: "github-mcp-server", args: ["serve"] }),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(listTools).toHaveBeenCalledWith(connection, expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(disconnectServer).toHaveBeenCalledWith(connection);
		expect(requestRender).toHaveBeenCalled();
	});

	it("cancels a stalled config lookup immediately without showing a stale hint", async () => {
		const { promise: stalledLookup } = Promise.withResolvers<never>();
		vi.spyOn(mcpConfigWriter, "readMCPConfigFile").mockReturnValue(stalledLookup);
		const presentCommandOutput = vi.fn();
		const showStatus = vi.fn();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const controller = new MCPCommandController({
			mcpTestEscapeHandlers,
			chatContainer: { addChild: vi.fn() },
			present: vi.fn(),
			presentCommandOutput,
			ui: { requestRender: vi.fn() },
			editor: {},
			showError: vi.fn(),
			showStatus,
			session: { refreshMCPTools: vi.fn() },
			mcpManager: {
				getServerConfig: vi.fn(() => undefined),
				getSource: vi.fn(() => undefined),
				prepareConfig: vi.fn(async config => config),
				getConnectionStatus: vi.fn(() => "connected"),
			},
		} as never);

		const pending = controller.handle("/mcp test github");
		expect(mcpTestEscapeHandlers).toHaveLength(1);

		for (const handler of [...mcpTestEscapeHandlers]) {
			mcpTestEscapeHandlers.delete(handler);
			handler();
		}
		await pending;

		expect(presentCommandOutput).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(`Cancelled MCP test for "github"`);
		expect(mcpTestEscapeHandlers).toHaveLength(0);
	});

	it("releases unadvertised ownership immediately when config lookup fails", async () => {
		vi.spyOn(mcpConfigWriter, "readMCPConfigFile").mockRejectedValue(new Error("EACCES: config unreadable"));
		const presentCommandOutput = vi.fn();
		const showError = vi.fn();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const controller = new MCPCommandController({
			mcpTestEscapeHandlers,
			chatContainer: { addChild: vi.fn() },
			present: vi.fn(),
			presentCommandOutput,
			ui: { requestRender: vi.fn() },
			editor: {},
			showError,
			showStatus: vi.fn(),
			session: { refreshMCPTools: vi.fn() },
			mcpManager: {
				getServerConfig: vi.fn(() => undefined),
				getSource: vi.fn(() => undefined),
			},
		} as never);

		await controller.handle("/mcp test github");

		expect(presentCommandOutput).not.toHaveBeenCalled();
		expect(mcpTestEscapeHandlers).toHaveLength(0);
		expect(showError).toHaveBeenCalled();
	});

	it("seals a failed test hint without retaining a stale cancellation prompt", async () => {
		vi.useFakeTimers();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(new Error("ECONNREFUSED"));
		const presented: RenderableBlock[] = [];
		const showError = vi.fn();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const controller = new MCPCommandController({
			mcpTestEscapeHandlers,
			chatContainer: { addChild: vi.fn() },
			present: vi.fn(),
			presentCommandOutput: (content: unknown) => {
				if (isRenderableBlock(content)) presented.push(content);
			},
			ui: { requestRender: vi.fn() },
			editor: {},
			showError,
			showStatus: vi.fn(),
			session: { refreshMCPTools: vi.fn() },
			mcpManager: {
				prepareConfig: vi.fn(async config => config),
				getConnectionStatus: vi.fn(() => "connected"),
			},
		} as never);

		await controller.handle("/mcp test github");

		const renderedHint = presented[0]?.render(80).join("\n") ?? "";
		expect(renderedHint).toContain(`Connection test for "github" failed.`);
		expect(renderedHint).not.toContain("(esc to cancel)");
		expect(presented[0]?.isTranscriptBlockFinalized()).toBe(true);
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
		expect(mcpTestEscapeHandlers).toHaveLength(1);
	});

	it("retires the advertised hint when cancellation interrupts a pending connection", async () => {
		const connectStarted = Promise.withResolvers<void>();
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((_name, _config, options) => {
			const pendingConnection = Promise.withResolvers<never>();
			const rejectAsAborted = (): void => {
				const error = new Error("aborted");
				error.name = "AbortError";
				pendingConnection.reject(error);
			};
			const signal = options?.signal;
			if (signal?.aborted) {
				rejectAsAborted();
			} else {
				signal?.addEventListener("abort", rejectAsAborted, { once: true });
			}
			connectStarted.resolve();
			return pendingConnection.promise;
		});
		const showStatus = vi.fn();
		const presented: RenderableBlock[] = [];
		const mcpTestEscapeHandlers = new Set<() => void>();
		const controller = new MCPCommandController({
			mcpTestEscapeHandlers,
			chatContainer: { addChild: vi.fn() },
			present: vi.fn(),
			presentCommandOutput: (content: unknown) => {
				if (isRenderableBlock(content)) presented.push(content);
			},
			ui: { requestRender: vi.fn() },
			editor: {},
			showError: vi.fn(),
			showStatus,
			session: { refreshMCPTools: vi.fn() },
			mcpManager: {
				prepareConfig: vi.fn(async config => config),
				getConnectionStatus: vi.fn(() => "connected"),
			},
		} as never);

		const pending = controller.handle("/mcp test github");
		await connectStarted.promise;
		expect(presented).toHaveLength(1);
		expect(presented[0]?.isTranscriptBlockFinalized()).toBe(false);

		for (const handler of [...mcpTestEscapeHandlers]) {
			mcpTestEscapeHandlers.delete(handler);
			handler();
		}
		await pending;

		const renderedHint = presented[0]?.render(80).join("\n") ?? "";
		expect(renderedHint).toContain(`Cancelled connection test for "github".`);
		expect(renderedHint).not.toContain("(esc to cancel)");
		expect(presented[0]?.isTranscriptBlockFinalized()).toBe(true);
		expect(showStatus).toHaveBeenCalledWith(`Cancelled MCP test for "github"`);
		expect(mcpTestEscapeHandlers).toHaveLength(0);
	});

	it("keeps a completed outcome when Esc lands during manager synchronization", async () => {
		const connection = {
			name: "github",
			config: { type: "stdio" as const, command: "github-mcp-server", args: ["serve"] },
			transport: { connected: true, request: vi.fn(), notify: vi.fn(), close: vi.fn(async () => {}) },
			serverInfo: { name: "GitHub MCP", version: "1.0.0" },
			capabilities: {},
		};
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();
		const syncStarted = Promise.withResolvers<void>();
		const syncGate = Promise.withResolvers<void>();
		const showStatus = vi.fn();
		const presented: RenderableBlock[] = [];
		const output: string[] = [];
		const mcpTestEscapeHandlers = new Set<() => void>();
		const controller = new MCPCommandController({
			mcpTestEscapeHandlers,
			chatContainer: { addChild: vi.fn() },
			present: vi.fn(),
			presentCommandOutput: (content: unknown) => {
				if (!isRenderedComponent(content)) return;
				if (isRenderableBlock(content)) {
					presented.push(content);
				} else {
					output.push(content.render(80).join("\n"));
				}
			},
			ui: { requestRender: vi.fn() },
			editor: {},
			showError: vi.fn(),
			showStatus,
			session: { refreshMCPTools: vi.fn() },
			mcpManager: {
				prepareConfig: vi.fn(async config => config),
				getConnectionStatus: vi.fn(() => "disconnected"),
				connectServers: vi.fn(async () => {
					syncStarted.resolve();
					await syncGate.promise;
					return {};
				}),
			},
		} as never);

		const pending = controller.handle("/mcp test github");
		await syncStarted.promise;
		for (const handler of [...mcpTestEscapeHandlers]) {
			mcpTestEscapeHandlers.delete(handler);
			handler();
		}
		syncGate.resolve();
		await pending;

		const renderedHint = presented[0]?.render(80).join("\n") ?? "";
		expect(renderedHint).toContain(`Tested connection to "github".`);
		expect(renderedHint).not.toContain("Cancelled connection test");
		expect(output.join("\n")).toContain(`Successfully connected to "github"`);
		expect(showStatus).not.toHaveBeenCalledWith(`Cancelled MCP test for "github"`);
	});
});
