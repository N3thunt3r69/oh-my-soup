import type {
	DisassemblerAdapter,
	DisassemblerAdapterCapabilities,
	DisassemblerAdapterOptions,
	DisassemblerExecutionOptions,
	DisassemblerExecutionResult,
	DisassemblerOpenOptions,
	DisassemblerQueryResult,
	DisassemblerResetOptions,
	DisassemblerTarget,
} from "../types";
import {
	closeBinaryNinjaTarget,
	executeBinaryNinjaTarget,
	listBinaryNinjaTargets,
	openBinaryNinjaTarget,
	queryBinaryNinjaTarget,
	resetBinaryNinjaTarget,
	saveBinaryNinjaTarget,
} from "./runtime";

export class BinaryNinjaDisassemblerAdapter implements DisassemblerAdapter {
	readonly id = "binaryninja";
	readonly label = "Binary Ninja";
	readonly capabilities: DisassemblerAdapterCapabilities = {
		executionLanguage: "Binary Ninja Python",
		statefulExecution: true,
		open: true,
		reset: true,
		save: true,
		close: true,
	};

	constructor(readonly options: DisassemblerAdapterOptions = {}) {}

	async list(): Promise<DisassemblerTarget[]> {
		return listBinaryNinjaTargets();
	}

	async query(
		target: string,
		sql: string,
		options: DisassemblerExecutionOptions = {},
		signal?: AbortSignal,
	): Promise<DisassemblerQueryResult> {
		if (options.stateful || options.sessionId) {
			throw new Error("Binary Ninja stateful Python namespaces are only valid for execute");
		}
		return queryBinaryNinjaTarget(target, sql, options.timeoutSec, signal);
	}

	async execute(
		target: string,
		code: string,
		options: DisassemblerExecutionOptions = {},
		signal?: AbortSignal,
	): Promise<DisassemblerExecutionResult> {
		return executeBinaryNinjaTarget(target, code, options, signal);
	}

	async open(options: DisassemblerOpenOptions, signal?: AbortSignal): Promise<DisassemblerTarget> {
		if (options.program !== undefined) {
			throw new Error("program is only valid for the Ghidra backend");
		}
		return openBinaryNinjaTarget(
			{
				installDir: this.options.binaryNinjaInstallDir,
				python: this.options.binaryNinjaPython,
				cwd: this.options.cwd,
			},
			{ file: options.file, outputDb: options.outputDb, timeoutSec: options.timeoutSec },
			signal,
		);
	}

	async reset(target: string, options: DisassemblerResetOptions, signal?: AbortSignal): Promise<void> {
		if (options.takeover !== undefined || options.release !== undefined) {
			throw new Error("takeover and release are not supported for Binary Ninja Python sessions");
		}
		await resetBinaryNinjaTarget(target, options, signal);
	}

	async save(
		target: string,
		options: DisassemblerExecutionOptions = {},
		signal?: AbortSignal,
	): Promise<DisassemblerExecutionResult> {
		if (options.stateful || options.sessionId) {
			throw new Error("Binary Ninja stateful Python namespaces are only valid for execute");
		}
		return saveBinaryNinjaTarget(target, options.timeoutSec, signal);
	}

	async close(target: string, timeoutSec?: number, signal?: AbortSignal): Promise<void> {
		await closeBinaryNinjaTarget(target, timeoutSec, signal);
	}

	dispose(): void {}
}
