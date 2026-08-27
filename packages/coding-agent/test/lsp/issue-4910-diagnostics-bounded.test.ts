import { describe, expect, test } from "bun:test";
import { getDiagnosticsForFile } from "@oh-my-soup/pi-coding-agent/lsp/diagnostics";
import type { Diagnostic, LinterClient, ServerConfig } from "@oh-my-soup/pi-coding-agent/lsp/types";

function hungLinterConfig(): ServerConfig {
	const client: LinterClient = {
		format: async (_filePath, content) => content,
		lint: () => Promise.withResolvers<Diagnostic[]>().promise,
	};
	return {
		command: "hung-linter-4910",
		fileTypes: [".py"],
		rootMarkers: [],
		createClient: () => client,
	};
}

function healthyLinterConfig(): ServerConfig {
	const client: LinterClient = {
		format: async (_filePath, content) => content,
		lint: async () => [],
	};
	return {
		command: "healthy-linter-4910",
		fileTypes: [".py"],
		rootMarkers: [],
		createClient: () => client,
	};
}

describe("issue #4910: diagnostics pipeline is wall-clock bounded", () => {
	test("a linter that never settles cannot hang getDiagnosticsForFile", async () => {
		const started = Date.now();
		const result = await getDiagnosticsForFile(
			"/tmp/issue-4910/falcon_emu.py",
			"/tmp/issue-4910",
			[["hung-linter-4910", hungLinterConfig()]],
			{ pipelineBudgetMs: 50 },
		);
		const elapsed = Date.now() - started;

		expect(result).toBeUndefined();
		expect(elapsed).toBeLessThan(5_000);
	});

	test("passes the pipeline deadline to cancellable linter work", async () => {
		let aborted = false;
		const pending = Promise.withResolvers<Diagnostic[]>();
		const client: LinterClient = {
			format: async (_filePath, content) => content,
			lint: (_filePath, signal) => {
				signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						pending.reject(signal.reason);
					},
					{ once: true },
				);
				return pending.promise;
			},
		};
		const config: ServerConfig = {
			command: "cancellable-linter-4910",
			fileTypes: [".py"],
			rootMarkers: [],
			createClient: () => client,
		};

		const result = await getDiagnosticsForFile(
			"/tmp/issue-4910/falcon_emu.py",
			"/tmp/issue-4910",
			[["cancellable-linter-4910", config]],
			{ pipelineBudgetMs: 50 },
		);

		expect(result).toBeUndefined();
		expect(aborted).toBe(true);
	});

	test("a healthy linter still reports normally under the same budget", async () => {
		const result = await getDiagnosticsForFile(
			"/tmp/issue-4910/falcon_emu.py",
			"/tmp/issue-4910",
			[["healthy-linter-4910", healthyLinterConfig()]],
			{ pipelineBudgetMs: 5_000 },
		);

		expect(result).toBeDefined();
		expect(result?.server).toBe("healthy-linter-4910");
		expect(result?.summary).toBe("OK");
		expect(result?.errored).toBe(false);
	});
});
