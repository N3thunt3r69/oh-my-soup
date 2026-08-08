import type {
	DisassemblerAdapter,
	DisassemblerAdapterCapabilities,
	DisassemblerAdapterOptions,
	DisassemblerExecutionOptions,
	DisassemblerExecutionResult,
	DisassemblerOpenOptions,
	DisassemblerQueryResult,
	DisassemblerTarget,
} from "../types";
import {
	closeGhidraTarget,
	executeGhidraTarget,
	listGhidraTargets,
	openGhidraTarget,
	queryGhidraTarget,
	saveGhidraTarget,
} from "./runtime";

export class GhidraDisassemblerAdapter implements DisassemblerAdapter {
	readonly id = "ghidra";
	readonly label = "Ghidra";
	readonly capabilities: DisassemblerAdapterCapabilities = {
		executionLanguage: "Ghidra Java",
		statefulExecution: false,
		open: true,
		reset: false,
		save: true,
		close: true,
	};

	readonly #options: DisassemblerAdapterOptions;

	constructor(options: DisassemblerAdapterOptions = {}) {
		this.#options = options;
	}

	async list(): Promise<DisassemblerTarget[]> {
		return listGhidraTargets();
	}

	async query(
		target: string,
		sql: string,
		options: DisassemblerExecutionOptions = {},
		signal?: AbortSignal,
	): Promise<DisassemblerQueryResult> {
		return queryGhidraTarget(target, sql, options.timeoutSec, signal);
	}

	async execute(
		target: string,
		code: string,
		options: DisassemblerExecutionOptions = {},
		signal?: AbortSignal,
	): Promise<DisassemblerExecutionResult> {
		return executeGhidraTarget(target, code, options.timeoutSec, signal);
	}

	async open(options: DisassemblerOpenOptions, signal?: AbortSignal): Promise<DisassemblerTarget> {
		return openGhidraTarget(
			{
				installDir: this.#options.ghidraInstallDir,
				javaHome: this.#options.ghidraJavaHome,
				cwd: this.#options.cwd,
			},
			{ file: options.file, outputDb: options.outputDb, program: options.program, timeoutSec: options.timeoutSec },
			signal,
		);
	}

	async save(
		target: string,
		options: DisassemblerExecutionOptions = {},
		signal?: AbortSignal,
	): Promise<DisassemblerExecutionResult> {
		return saveGhidraTarget(target, options.timeoutSec, signal);
	}

	async close(target: string, timeoutSec?: number, signal?: AbortSignal): Promise<void> {
		await closeGhidraTarget(target, timeoutSec, signal);
	}

	dispose(): void {
		// Managed targets outlive one tool call and are released by close or postmortem.
	}
}
