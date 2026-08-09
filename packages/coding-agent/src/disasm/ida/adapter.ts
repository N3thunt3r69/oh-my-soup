import { type } from "@oh-my-soup/omstype";
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
import { IdaBridgeClient, type IdaBridgeClientInfo, type IdaBridgeExecOptions } from "./client";
import { ensureIdaBridge, managedIdaTargetInfo, openIdaTarget, releaseIdaRuntime, releaseIdaTarget } from "./runtime";

const queryResultSchema = type({
	"+": "reject",
	columns: "string[]",
	rows: type({ "[string]": "unknown" }).array(),
});

export class IdaDisassemblerAdapter implements DisassemblerAdapter {
	readonly id = "ida";
	readonly label = "IDA Pro";
	readonly capabilities: DisassemblerAdapterCapabilities = {
		executionLanguage: "IDAPython",
		statefulExecution: true,
		open: true,
		reset: true,
		save: true,
		close: true,
	};

	readonly #options: DisassemblerAdapterOptions;

	constructor(options: DisassemblerAdapterOptions = {}) {
		this.#options = options;
	}

	async list(signal?: AbortSignal): Promise<DisassemblerTarget[]> {
		return this.#withClient(signal, async client => {
			const clients = await client.list(signal);
			return clients.filter(isHeadlessIdaClient).map(client => {
				const managed = managedIdaTargetInfo(client.clientId);
				const databasePath = managed?.databasePath ?? stringMeta(client.meta, "idb_path");
				const inputPath = managed?.inputPath ?? stringMeta(client.meta, "input_file");
				return {
					id: client.clientId,
					backend: this.id,
					label: databasePath || inputPath || client.clientId,
					databasePath,
					inputPath,
					runtime: stringMeta(client.meta, "runtime"),
					version: stringMeta(client.meta, "ida_version"),
					processor: stringMeta(client.meta, "processor"),
					bits: numberMeta(client.meta, "bits"),
					pid: numberMeta(client.meta, "pid"),
					sessionId: client.sessionId,
					metadata: managed
						? { ...client.meta, managed_by_omp: true, temporary_database: managed.temporaryDatabase }
						: client.meta,
				};
			});
		});
	}

	async query(
		target: string,
		sql: string,
		options: DisassemblerExecutionOptions = {},
		signal?: AbortSignal,
	): Promise<DisassemblerQueryResult> {
		const response = await this.#exec(target, buildIdaSqlCode(sql), options, signal);
		return parseQueryResult(response.result);
	}

	async execute(
		target: string,
		code: string,
		options: DisassemblerExecutionOptions = {},
		signal?: AbortSignal,
	): Promise<DisassemblerExecutionResult> {
		return this.#exec(target, code, options, signal);
	}
	async open(options: DisassemblerOpenOptions, signal?: AbortSignal): Promise<DisassemblerTarget> {
		return openIdaTarget(this.#options, options, signal);
	}

	async reset(target: string, options: DisassemblerResetOptions, signal?: AbortSignal): Promise<void> {
		await this.#withHeadlessTarget(target, signal, async client => {
			await client.reset(
				target,
				{
					sessionId: options.sessionId,
					takeover: options.takeover,
					release: options.release,
					timeoutSec: options.timeoutSec,
				},
				signal,
			);
		});
	}

	async save(
		target: string,
		options: DisassemblerExecutionOptions = {},
		signal?: AbortSignal,
	): Promise<DisassemblerExecutionResult> {
		return this.#exec(target, "_result_ = idb.save()", options, signal);
	}

	async close(target: string, timeoutSec?: number, signal?: AbortSignal): Promise<void> {
		await this.#withHeadlessTarget(target, signal, async client => {
			await client.quit(target, timeoutSec, signal);
		});
		await releaseIdaTarget(target);
	}

	dispose(): void {
		releaseIdaRuntime(this.#options.endpoint);
	}

	async #exec(
		target: string,
		code: string,
		options: DisassemblerExecutionOptions,
		signal?: AbortSignal,
	): Promise<DisassemblerExecutionResult> {
		return this.#withHeadlessTarget(target, signal, async client => {
			const execOptions: IdaBridgeExecOptions = {
				persist: options.stateful,
				sessionId: options.sessionId,
				timeoutSec: options.timeoutSec,
			};
			return client.exec(target, code, execOptions, signal);
		});
	}

	async #withHeadlessTarget<T>(
		target: string,
		signal: AbortSignal | undefined,
		operation: (client: IdaBridgeClient) => Promise<T>,
	): Promise<T> {
		return this.#withClient(signal, async client => {
			const connected = (await client.list(signal)).find(candidate => candidate.clientId === target);
			if (!connected) throw new Error(`IDA target '${target}' is not connected`);
			const runtime = stringMeta(connected.meta, "runtime");
			if (!isHeadlessIdaClient(connected)) {
				throw new Error(
					`IDA target '${target}' uses runtime '${runtime ?? "unknown"}'; only headless idalib targets are allowed`,
				);
			}
			return operation(client);
		});
	}

	async #withClient<T>(
		signal: AbortSignal | undefined,
		operation: (client: IdaBridgeClient) => Promise<T>,
	): Promise<T> {
		await ensureIdaBridge(this.#options, signal);
		const client = new IdaBridgeClient({ url: this.#options.endpoint });
		try {
			await client.connect(signal);
			return await operation(client);
		} finally {
			client.close();
		}
	}
}

/** Build SQL execution without involving shell quoting or a generic MCP layer. */
export function buildIdaSqlCode(sql: string): string {
	const literal = JSON.stringify(sql).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
	return `_result_ = idb.sql(${literal})`;
}

function parseQueryResult(value: unknown): DisassemblerQueryResult {
	return queryResultSchema.assert(value);
}

function isHeadlessIdaClient(client: IdaBridgeClientInfo): boolean {
	return client.role === "ida" && stringMeta(client.meta, "runtime") === "idalib";
}

function stringMeta(meta: Record<string, unknown>, key: string): string | undefined {
	const value = meta[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberMeta(meta: Record<string, unknown>, key: string): number | undefined {
	const value = meta[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
