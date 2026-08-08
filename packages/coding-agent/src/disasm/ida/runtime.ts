import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, type ChildProcess, postmortem, ptree } from "@oh-my-pi/pi-utils";
import type { DisassemblerTarget } from "../types";
import { IdaBridgeClient, type IdaBridgeClientInfo, resolveIdaBridgeUrl } from "./client";

const BRIDGE_PROBE_TIMEOUT_MS = 500;
const BRIDGE_START_TIMEOUT_MS = 15_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const TARGET_POLL_INTERVAL_MS = 100;
const IDB_EXTENSIONS = new Set([".i64", ".idb"]);
// idapro normally prefers its user-global JSON config over IDADIR. Inject only
// the one config symbol its package initializer consumes so an explicit OMP
// setting wins without mutating the user's global IDA configuration.
const IDAPRO_CONFIG_BOOTSTRAP = [
	"import os,runpy,sys,types",
	"config=types.ModuleType('idapro.config')",
	"config.get_ida_install_dir=lambda:os.environ['IDADIR']",
	"sys.modules['idapro.config']=config",
	"runpy.run_module('ida_bridge.idalib_runner',run_name='__main__')",
].join(";");

export interface IdaRuntimeOptions {
	endpoint?: string;
	idaDir?: string;
	python?: string;
	cwd?: string;
}

export interface IdaOpenRequest {
	file: string;
	outputIdb?: string;
	timeoutSec?: number;
}

export interface ManagedIdaTargetInfo {
	databasePath: string;
	inputPath?: string;
	temporaryDatabase: boolean;
}

interface ResolvedIdaRuntime {
	endpoint: string;
	url: URL;
	python: string;
	idaDir?: string;
	cwd: string;
	env: Record<string, string | undefined>;
}

interface ManagedProcess {
	process: ChildProcess;
	exitSettled: Promise<number>;
}

interface BridgeRecord extends ManagedProcess {
	key: string;
}

interface TargetRecord extends ManagedProcess, ManagedIdaTargetInfo {
	targetId: string;
	bridgeKey: string;
	temporaryDir?: string;
}

const bridges = new Map<string, BridgeRecord>();
const bridgeStarts = new Map<string, Promise<void>>();
const targets = new Map<string, TargetRecord>();
const pendingOpens = new Map<string, number>();

export function managedIdaTargetInfo(targetId: string): ManagedIdaTargetInfo | undefined {
	const target = targets.get(targetId);
	if (!target) return undefined;
	return {
		databasePath: target.databasePath,
		inputPath: target.inputPath,
		temporaryDatabase: target.temporaryDatabase,
	};
}

/** Ensure a compatible local bridge is running, starting one when necessary. */
export async function ensureIdaBridge(options: IdaRuntimeOptions, signal?: AbortSignal): Promise<void> {
	const endpoint = resolveIdaBridgeUrl(options.endpoint);
	if (await probeBridge(endpoint, signal)) return;
	const runtime = resolveRuntime(options, endpoint);
	await ensureResolvedBridge(runtime, signal);
}

/** Start one idalib worker and wait until its target is immediately queryable. */
export async function openIdaTarget(
	options: IdaRuntimeOptions,
	request: IdaOpenRequest,
	signal?: AbortSignal,
): Promise<DisassemblerTarget> {
	const endpoint = resolveIdaBridgeUrl(options.endpoint);
	incrementPendingOpen(endpoint);
	let temporaryDir: string | undefined;
	let worker: ManagedProcess | undefined;
	try {
		const runtime = resolveRuntime(options, endpoint);
		await ensureResolvedBridge(runtime, signal);
		throwIfAborted(signal);

		const inputPath = resolveInputFile(request.file, runtime.cwd);
		const inputIsDatabase = IDB_EXTENSIONS.has(path.extname(inputPath).toLowerCase());
		if (inputIsDatabase && request.outputIdb?.trim()) {
			throw new Error("output_idb is not valid when opening an existing IDA database");
		}

		let databasePath: string;
		if (inputIsDatabase) {
			databasePath = inputPath;
		} else if (request.outputIdb?.trim()) {
			databasePath = resolveOutputDatabase(request.outputIdb, runtime.cwd);
		} else {
			temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-disasm-"));
			databasePath = path.join(temporaryDir, "database.i64");
		}
		const existingTargetIds = await listTargetIds(runtime.endpoint, signal);

		const args = runtime.idaDir
			? [runtime.python, "-c", IDAPRO_CONFIG_BOOTSTRAP]
			: [runtime.python, "-m", "ida_bridge.idalib_runner"];
		if (inputIsDatabase) {
			args.push("--idb", inputPath);
		} else {
			args.push("--input", inputPath, "--out-idb", databasePath);
		}
		args.push("--connect-timeout-s", String(Math.min(30, Math.max(5, request.timeoutSec ?? 10))));

		const process = ptree.spawn(args, {
			cwd: runtime.cwd,
			env: runtime.env,
			detached: true,
		});
		void drain(process.stdout);
		worker = managedProcess(process);
		const clientInfo = await waitForTarget(runtime.endpoint, databasePath, existingTargetIds, worker, signal);
		const targetId = clientInfo.clientId;
		const record: TargetRecord = {
			...worker,
			targetId,
			bridgeKey: endpoint,
			databasePath,
			inputPath: inputIsDatabase ? undefined : inputPath,
			temporaryDatabase: temporaryDir !== undefined,
			temporaryDir,
		};
		targets.set(targetId, record);
		monitorTarget(record);
		return targetFromClient(clientInfo, record);
	} catch (error) {
		if (worker) await terminate(worker);
		if (temporaryDir) removeTemporaryDatabase(temporaryDir);
		throw error;
	} finally {
		decrementPendingOpen(endpoint);
		void stopIdleBridge(endpoint);
	}
}

/** Finish cleanup after the bridge has acknowledged a target-specific quit. */
export async function releaseIdaTarget(targetId: string): Promise<void> {
	const target = targets.get(targetId);
	if (!target) return;
	await waitForExit(target, PROCESS_EXIT_TIMEOUT_MS);
	if (target.process.exitCode === null) await terminate(target);
	forgetTarget(target);
	await stopIdleBridge(target.bridgeKey);
}

/** Dispose an owned bridge once it has no connected targets. */
export function releaseIdaRuntime(endpoint?: string): void {
	let key: string;
	try {
		key = resolveIdaBridgeUrl(endpoint);
	} catch {
		return;
	}
	void stopIdleBridge(key);
}

function resolveRuntime(options: IdaRuntimeOptions, endpoint: string): ResolvedIdaRuntime {
	const cwd = path.resolve(options.cwd?.trim() || process.cwd());
	const python = resolvePython(options.python, cwd);
	const idaDir = resolveIdaDir(options.idaDir, cwd);
	const url = new URL(endpoint);
	assertLocalBridgeUrl(url);
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port || "80";
	const env: Record<string, string | undefined> = {
		...process.env,
		IDA_BRIDGE_HOST: host,
		IDA_BRIDGE_PORT: port,
		IDA_IS_INTERACTIVE: "0",
		PYTHONUNBUFFERED: "1",
	};
	if (idaDir) {
		env.IDADIR = idaDir;
		const bundledPython = path.join(idaDir, "idalib", "python");
		env.PYTHONPATH = [bundledPython, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
	}
	return { endpoint, url, python, idaDir, cwd, env };
}

function resolvePython(configured: string | undefined, cwd: string): string {
	const requested = configured?.trim();
	if (!requested) {
		const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
		for (const candidate of candidates) {
			const resolved = $which(candidate);
			if (resolved) return resolved;
		}
		throw new Error("Python was not found. Configure disasm.ida.python or pass python to disasm open.");
	}

	const looksLikePath =
		path.isAbsolute(requested) || requested.includes("/") || requested.includes("\\") || requested.startsWith("~");
	const resolved = looksLikePath ? resolveConfiguredPath(requested, cwd) : $which(requested);
	if (!resolved) throw new Error(`Configured IDA Python executable was not found: ${requested}`);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		throw new Error(`Configured IDA Python executable was not found: ${resolved}`);
	}
	if (!stat.isFile()) throw new Error(`Configured IDA Python executable is not a file: ${resolved}`);
	return resolved;
}

function resolveIdaDir(configured: string | undefined, cwd: string): string | undefined {
	const requested = configured?.trim() || process.env.IDADIR?.trim();
	if (!requested) return undefined;
	let resolved = resolveConfiguredPath(requested, cwd);
	if (process.platform === "darwin" && resolved.toLowerCase().endsWith(".app")) {
		resolved = path.join(resolved, "Contents", "MacOS");
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		throw new Error(`Configured IDA installation directory was not found: ${resolved}`);
	}
	if (!stat.isDirectory()) throw new Error(`Configured IDA installation path is not a directory: ${resolved}`);

	const library =
		process.platform === "win32" ? "idalib.dll" : process.platform === "darwin" ? "libidalib.dylib" : "libidalib.so";
	if (!fs.existsSync(path.join(resolved, library))) {
		throw new Error(`Configured IDA installation does not contain ${library}: ${resolved}`);
	}
	if (!fs.existsSync(path.join(resolved, "idalib", "python", "idapro", "__init__.py"))) {
		throw new Error(`Configured IDA installation does not contain the idapro Python package: ${resolved}`);
	}
	return resolved;
}

function resolveConfiguredPath(value: string, cwd: string): string {
	const expanded =
		value === "~"
			? os.homedir()
			: value.startsWith("~/") || value.startsWith("~\\")
				? path.join(os.homedir(), value.slice(2))
				: value;
	return path.resolve(cwd, expanded);
}

function resolveInputFile(value: string, cwd: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("file is required for disasm open");
	const resolved = resolveConfiguredPath(trimmed, cwd);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		throw new Error(`Disassembler input file was not found: ${resolved}`);
	}
	if (!stat.isFile()) throw new Error(`Disassembler input is not a file: ${resolved}`);
	return resolved;
}

function resolveOutputDatabase(value: string, cwd: string): string {
	const resolved = resolveConfiguredPath(value.trim(), cwd);
	if (!IDB_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
		throw new Error(`output_idb must end in .i64 or .idb: ${resolved}`);
	}
	if (!fs.existsSync(path.dirname(resolved))) {
		throw new Error(`output_idb parent directory does not exist: ${path.dirname(resolved)}`);
	}
	if (fs.existsSync(resolved)) throw new Error(`Refusing to overwrite existing IDA database: ${resolved}`);
	return resolved;
}

async function ensureResolvedBridge(runtime: ResolvedIdaRuntime, signal?: AbortSignal): Promise<void> {
	if (await probeBridge(runtime.endpoint, signal)) return;
	let starting = bridgeStarts.get(runtime.endpoint);
	if (!starting) {
		starting = startBridge(runtime).finally(() => bridgeStarts.delete(runtime.endpoint));
		bridgeStarts.set(runtime.endpoint, starting);
	}
	await awaitWithSignal(starting, signal);
}

async function startBridge(runtime: ResolvedIdaRuntime): Promise<void> {
	const existing = bridges.get(runtime.endpoint);
	if (existing && existing.process.exitCode === null) return;
	if (existing) bridges.delete(runtime.endpoint);

	const process = ptree.spawn([runtime.python, "-m", "ida_bridge.server"], {
		cwd: runtime.cwd,
		env: runtime.env,
		detached: true,
	});
	void drain(process.stdout);
	const managed = managedProcess(process);
	const deadline = Date.now() + BRIDGE_START_TIMEOUT_MS;
	try {
		while (Date.now() < deadline) {
			if (await probeBridge(runtime.endpoint)) {
				if (process.exitCode === null) {
					const record: BridgeRecord = { ...managed, key: runtime.endpoint };
					bridges.set(runtime.endpoint, record);
					monitorBridge(record);
					setTimeout(() => void stopIdleBridge(runtime.endpoint), 1_000).unref?.();
				}
				return;
			}
			if (process.exitCode !== null) throw await prematureExit("ida-bridge server", managed);
			await delay(TARGET_POLL_INTERVAL_MS);
		}
		throw new Error(`Timed out starting ida-bridge at ${runtime.endpoint}`);
	} catch (error) {
		await terminate(managed);
		throw error;
	}
}

async function listTargetIds(endpoint: string, signal?: AbortSignal): Promise<Set<string>> {
	const client = new IdaBridgeClient({ url: endpoint });
	try {
		await client.connect(signal);
		return new Set((await client.list(signal)).map(candidate => candidate.clientId));
	} finally {
		client.close();
	}
}

async function waitForTarget(
	endpoint: string,
	databasePath: string,
	existingTargetIds: ReadonlySet<string>,
	worker: ManagedProcess,
	signal?: AbortSignal,
): Promise<IdaBridgeClientInfo> {
	const client = new IdaBridgeClient({ url: endpoint });
	try {
		await client.connect(signal);
		while (true) {
			throwIfAborted(signal);
			if (worker.process.exitCode !== null) throw await prematureExit("idalib worker", worker);
			const connected = (await client.list(signal)).find(
				candidate =>
					!existingTargetIds.has(candidate.clientId) &&
					candidate.role === "ida" &&
					candidate.meta.runtime === "idalib" &&
					samePath(candidate.meta.idb_path, databasePath),
			);
			if (connected) return connected;
			await delay(TARGET_POLL_INTERVAL_MS, signal);
		}
	} finally {
		client.close();
	}
}

function samePath(candidate: unknown, expected: string): boolean {
	if (typeof candidate !== "string" || candidate.length === 0) return false;
	const left = path.normalize(path.resolve(candidate));
	const right = path.normalize(path.resolve(expected));
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function probeBridge(endpoint: string, signal?: AbortSignal): Promise<boolean> {
	throwIfAborted(signal);
	const probeTimeout = AbortSignal.timeout(BRIDGE_PROBE_TIMEOUT_MS);
	const probeSignal = signal ? AbortSignal.any([signal, probeTimeout]) : probeTimeout;
	const client = new IdaBridgeClient({ url: endpoint });
	try {
		await client.connect(probeSignal);
		return true;
	} catch {
		if (signal?.aborted) throw abortError(signal);
		return false;
	} finally {
		client.close();
	}
}

async function stopIdleBridge(key: string): Promise<void> {
	const bridge = bridges.get(key);
	if (!bridge || bridge.process.exitCode !== null) return;
	if ((pendingOpens.get(key) ?? 0) > 0) return;
	if ([...targets.values()].some(target => target.bridgeKey === key)) return;

	const client = new IdaBridgeClient({ url: key });
	try {
		const signal = AbortSignal.timeout(BRIDGE_PROBE_TIMEOUT_MS);
		await client.connect(signal);
		const connected = await client.list(signal);
		if (connected.some(candidate => candidate.role === "ida")) return;
	} catch {
		// An unreachable owned bridge is safe to terminate.
	} finally {
		client.close();
	}
	if (bridges.get(key) !== bridge) return;
	bridges.delete(key);
	await terminate(bridge);
}

function targetFromClient(client: IdaBridgeClientInfo, record: TargetRecord): DisassemblerTarget {
	return {
		id: client.clientId,
		backend: "ida",
		label: record.databasePath,
		databasePath: record.databasePath,
		inputPath: record.inputPath,
		runtime: stringMeta(client.meta, "runtime"),
		version: stringMeta(client.meta, "ida_version"),
		processor: stringMeta(client.meta, "processor"),
		bits: numberMeta(client.meta, "bits"),
		pid: numberMeta(client.meta, "pid") ?? record.process.pid,
		sessionId: client.sessionId,
		metadata: {
			...client.meta,
			managed_by_omp: true,
			temporary_database: record.temporaryDatabase,
		},
	};
}

function managedProcess(process: ChildProcess): ManagedProcess {
	return {
		process,
		exitSettled: process.exited.catch(() => process.exitCode ?? -1),
	};
}

function monitorBridge(record: BridgeRecord): void {
	void record.exitSettled.finally(() => {
		if (bridges.get(record.key) === record) bridges.delete(record.key);
	});
}

function monitorTarget(record: TargetRecord): void {
	void record.exitSettled.finally(() => {
		if (targets.get(record.targetId) !== record) return;
		forgetTarget(record);
		void stopIdleBridge(record.bridgeKey);
	});
}

function forgetTarget(record: TargetRecord): void {
	if (targets.get(record.targetId) === record) targets.delete(record.targetId);
	if (record.temporaryDir) removeTemporaryDatabase(record.temporaryDir);
}

function removeTemporaryDatabase(directory: string): void {
	try {
		fs.rmSync(directory, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; postmortem will retry records that are still tracked.
	}
}

async function terminate(managed: ManagedProcess): Promise<void> {
	if (managed.process.exitCode === null) managed.process.kill();
	await waitForExit(managed, PROCESS_EXIT_TIMEOUT_MS);
}

async function waitForExit(managed: ManagedProcess, timeoutMs: number): Promise<void> {
	await Promise.race([managed.exitSettled.then(() => undefined), delay(timeoutMs)]);
}

async function prematureExit(label: string, managed: ManagedProcess): Promise<Error> {
	await managed.exitSettled;
	const stderr = managed.process.peekStderr().trim();
	const suffix = stderr ? `\n${stderr}` : "";
	return new Error(`${label} exited before becoming ready (code ${managed.process.exitCode ?? "unknown"})${suffix}`);
}

function assertLocalBridgeUrl(url: URL): void {
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const local = host === "localhost" || host === "127.0.0.1";
	if (url.protocol !== "ws:" || !local || (url.pathname !== "/" && url.pathname !== "")) {
		throw new Error(
			`Cannot auto-start ida-bridge at ${url.toString()}; configure a local ws://127.0.0.1:<port> endpoint`,
		);
	}
}

function incrementPendingOpen(key: string): void {
	pendingOpens.set(key, (pendingOpens.get(key) ?? 0) + 1);
}

function decrementPendingOpen(key: string): void {
	const next = (pendingOpens.get(key) ?? 1) - 1;
	if (next > 0) pendingOpens.set(key, next);
	else pendingOpens.delete(key);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
	try {
		for await (const _chunk of stream) {
			// Drain without retaining unbounded process output.
		}
	} catch {
		// Process teardown closes streams abruptly on some platforms.
	}
}

function stringMeta(meta: Record<string, unknown>, key: string): string | undefined {
	const value = meta[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberMeta(meta: Record<string, unknown>, key: string): number | undefined {
	const value = meta[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Operation aborted"));
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	throwIfAborted(signal);
	return await new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await Bun.sleep(ms);
		return;
	}
	throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			cleanup();
			reject(abortError(signal));
		};
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

postmortem.register("ida-headless-runtime", async () => {
	const ownedTargets = [...targets.values()];
	const ownedBridges = [...bridges.values()];
	targets.clear();
	bridges.clear();
	await Promise.all([...ownedTargets, ...ownedBridges].map(process => terminate(process)));
	for (const target of ownedTargets) {
		if (target.temporaryDir) removeTemporaryDatabase(target.temporaryDir);
	}
});
