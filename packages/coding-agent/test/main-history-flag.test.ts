import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "@oh-my-soup/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-soup/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-soup/pi-coding-agent/session/auth-storage";
import type { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { normalizePathForComparison, TempDir } from "@oh-my-soup/pi-utils";

describe("runRootCommand — --history", () => {
	it("overrides an environment session directory without treating it as an explicit conflict", async () => {
		using tempDir = TempDir.createSync("@oms-history-flag-");
		const environmentDir = path.join(tempDir.path(), "environment-sessions");
		const historyDir = path.join(tempDir.path(), "history");
		await Promise.all([fs.mkdir(environmentDir), fs.mkdir(historyDir)]);
		const previousSessionDir = Bun.env.PI_CODING_AGENT_SESSION_DIR;
		Bun.env.PI_CODING_AGENT_SESSION_DIR = environmentDir;

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const rawArgs = ["--history", historyDir, "--print", "hello"];
		const parsed = parseArgs(rawArgs);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		let sessionManager: SessionManager | undefined;
		let sessionFile: string | undefined;
		const stop = new Error("stop after session options");
		vi.spyOn(process, "exit").mockImplementation(code => {
			throw new Error(`unexpected process.exit(${code})`);
		});

		try {
			expect(parsed.sessionDir).toBe(environmentDir);
			expect(parsed.sessionDirExplicit).toBeUndefined();
			await expect(
				runRootCommand(parsed, rawArgs, {
					discoverAuthStorage: async () => authStorage,
					settings,
					createAgentSession: async options => {
						if (!options) throw new Error("Expected session options");
						sessionManager = options.sessionManager;
						sessionFile = sessionManager?.getSessionFile();
						throw stop;
					},
				}),
			).rejects.toBe(stop);
		} finally {
			vi.restoreAllMocks();
			authStorage.close();
			await sessionManager?.close();
			if (previousSessionDir === undefined) delete Bun.env.PI_CODING_AGENT_SESSION_DIR;
			else Bun.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
		}

		expect(parsed.sessionDir).toBe(historyDir);
		expect(sessionFile).toBeDefined();
		expect(normalizePathForComparison(path.dirname(sessionFile!))).toBe(normalizePathForComparison(historyDir));
	});
});
