import * as fs from "node:fs";
import * as path from "node:path";

import { getProjectDir, logger } from "@oh-my-soup/pi-utils";
import type { ToolSession } from "../../tools";
import {
	buildManagedKernelEnv,
	buildManagedKernelEnvPatch,
	createCancelledKernelResult,
	executeWithKernelBase,
	getExecutionDeadlineMs,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	waitForPromiseWithCancellation,
} from "../executor-base";
import type { JsStatusEvent } from "../js/shared/types";
import {
	createKernelSessionRegistry,
	formatSessionKernelTimeoutAnnotation,
	formatSessionTimeoutAnnotation,
	type KernelSession,
	type KernelSessionRegistryContext,
	normalizeKernelSessionCwd,
	requireRemainingKernelTimeoutMs,
} from "../kernel-session-registry";
import {
	checkPythonKernelAvailability,
	type KernelDisplayOutput,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelShutdownResult,
	PythonKernel,
} from "./kernel";
import { resolveExplicitPythonRuntime } from "./runtime";
import {
	buildRestoreCode,
	buildSnapshotCode,
	formatRestoreNotice,
	manifestPathIn,
	parseMarkerError,
	parseRestoreResult,
	parseSnapshotResult,
	SNAPSHOT_DIR_NAME,
	snapshotPathIn,
} from "./state-snapshot";
import { ensurePyToolBridge } from "./tool-bridge";

export type PythonKernelMode = "session" | "per-call";

export interface PythonExecutorOptions {
	/** Working directory for command execution */
	cwd?: string;
	/** Timeout in milliseconds */
	timeoutMs?: number;
	/** Absolute wall-clock deadline in milliseconds since epoch */
	deadlineMs?: number;
	/**
	 * Runtime-work budget (ms). Used only for timeout-annotation text when the
	 * caller drives cancellation via the eval watchdog `signal` instead of a
	 * wall-clock `deadlineMs`/`timeoutMs`. Does not arm a timer.
	 */
	idleTimeoutMs?: number;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => Promise<void> | void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Session identifier for kernel reuse */
	sessionId?: string;
	/** Logical owner identifier for retained kernel cleanup */
	kernelOwnerId?: string;
	/** Kernel mode (session reuse vs per-call) */
	kernelMode?: PythonKernelMode;
	/**
	 * Explicit interpreter path (`python.interpreter` resolved from the
	 * session's settings). Skips automatic runtime discovery when set.
	 */
	interpreter?: string;
	/** Restart the kernel before executing */
	reset?: boolean;
	/** Session file path for accessing task outputs */
	sessionFile?: string;
	/**
	 * Effective artifacts directory for the current session. Subagents share
	 * the parent's directory, so this can differ from `sessionFile`'s sibling
	 * dir. When present, exported to the kernel as `PI_ARTIFACTS_DIR` and
	 * preferred over `PI_SESSION_FILE`-derived paths.
	 */
	artifactsDir?: string;
	/**
	 * Snapshot the kernel's user namespace to `<artifactsDir>/py-kernel-snapshot/`
	 * on graceful session shutdown and restore it once when a resumed session
	 * boots a fresh kernel. Enabled by default (`python.stateSnapshot` setting);
	 * requires `artifactsDir` and session kernel mode.
	 */
	stateSnapshot?: boolean;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * On-disk roots the prelude helpers (`read`/`write`) substitute for
	 * internal-URL schemes (e.g. `{ local: "/…/artifacts/local" }`). Exported to
	 * the kernel as `PI_EVAL_LOCAL_ROOTS` (JSON) so `write("local://x")` lands
	 * where `read local://x` resolves instead of a literal `local:/` directory.
	 */
	localRoots?: Record<string, string>;
	/**
	 * ToolSession used to resolve host-side `tool.<name>(args)` calls made from
	 * the Python prelude's bridge proxy. When omitted, the bridge env vars are
	 * not injected and any `tool.foo(...)` raises in Python.
	 */
	toolSession?: ToolSession;
	/** Callback for status events emitted by tool bridge invocations. */
	emitStatus?: (event: JsStatusEvent) => void;
	/**
	 * Live status events streamed as they are emitted (both host-side bridge
	 * helpers like `agent()` and kernel-side `display`/`log`/`phase`). Mirrors
	 * what lands in `displayOutputs` so callers can render progress before the
	 * cell finishes.
	 */
	onStatus?: (event: JsStatusEvent) => void;
	/** @internal Bridge session id, set by `executePython` before delegating. */
	bridgeSessionId?: string;
	/** @internal Bridge endpoint info, set by `executePython` before delegating. */
	bridge?: { url: string; token: string };
}

export interface PythonKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

export interface PythonResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Execution exit code (0 ok, 1 error, undefined if cancelled) */
	exitCode: number | undefined;
	/** Whether the execution was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Artifact ID if full output was saved to artifact storage */
	artifactId?: string;
	/** Total number of lines in the output stream */
	totalLines: number;
	/** Total number of bytes in the output stream */
	totalBytes: number;
	/** Number of lines included in the output text */
	outputLines: number;
	/** Number of bytes included in the output text */
	outputBytes: number;
	/** Rich display outputs captured from display_data/execute_result */
	displayOutputs: KernelDisplayOutput[];
	/** Whether stdin was requested */
	stdinRequested: boolean;
}

// ---------------------------------------------------------------------------
// Session bookkeeping
//
// One PythonKernel subprocess per (session id, cwd, interpreter) tuple. The
// runner mutates process-global cwd/sys.path during execution, so cross-directory
// work must never share a live kernel. Multiple agent owners can still register against
// the same tuple; the kernel stays alive until the last owner detaches.
// ---------------------------------------------------------------------------

interface SessionKernelReplacement {
	generation: number;
	deadlineMs?: number;
	promise: Promise<PythonKernel>;
}

interface PythonSession extends KernelSession<PythonKernel> {
	generation: number;
	replacement?: SessionKernelReplacement;
	/** Where graceful shutdown persists the namespace snapshot, when enabled. */
	stateSnapshotDir?: string;
}

function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	const resolved = resolveExplicitPythonRuntime(interpreter, cwd, {}).pythonPath;
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

// ---------------------------------------------------------------------------
// Kernel state snapshot/restore (session resume)
//
// On graceful session shutdown (dispose by owner / dispose-all at exit) the
// live namespace is pickled per-variable with dill into the session's
// artifacts dir; when a resumed session boots a fresh kernel the payload is
// revived and a one-line notice is surfaced through the first cell's output.
// Both directions are best-effort: a missing dill, unpicklable values, or a
// corrupt payload degrade to a debug log and never break shutdown or boot.
// ---------------------------------------------------------------------------

const STATE_SNAPSHOT_TIMEOUT_MS = 30_000;

/** Snapshot payloads already restored (or attempted) by this process. */
const restoredSnapshotPaths = new Set<string>();

/** Restore notices awaiting delivery through the kernel's next cell output. */
const pendingRestoreNotices = new WeakMap<PythonKernelExecutor, string>();

function resolveStateSnapshotDir(options: PythonExecutorOptions): string | undefined {
	if (options.stateSnapshot === false) return undefined;
	if (options.kernelMode === "per-call") return undefined;
	if (!options.artifactsDir) return undefined;
	return path.join(options.artifactsDir, SNAPSHOT_DIR_NAME);
}

/** Runs state helper code silently on the kernel and returns collected stdout. */
async function runKernelStateCode(kernel: PythonKernelExecutor, code: string): Promise<string> {
	let stdout = "";
	await kernel.execute(code, {
		silent: true,
		storeHistory: false,
		timeoutMs: STATE_SNAPSHOT_TIMEOUT_MS,
		onChunk: text => {
			stdout += text;
		},
	});
	return stdout;
}

/** Best-effort namespace snapshot before a graceful session shutdown. Never throws. */
async function snapshotKernelState(session: PythonSession): Promise<void> {
	const dir = session.stateSnapshotDir;
	if (!dir || !session.kernel.isAlive()) return;
	const outPath = snapshotPathIn(dir);
	try {
		const stdout = await runKernelStateCode(session.kernel, buildSnapshotCode(outPath, manifestPathIn(dir)));
		const result = parseSnapshotResult(stdout, outPath);
		if (!result) {
			logger.debug("Python kernel state snapshot skipped", {
				path: outPath,
				reason: parseMarkerError(stdout) ?? "no result marker",
			});
			return;
		}
		logger.debug("Python kernel state snapshot written", {
			path: outPath,
			saved: result.saved.length,
			skipped: result.skipped.length,
			bytes: result.bytes,
		});
	} catch (err) {
		logger.debug("Python kernel state snapshot failed", {
			path: outPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Restore a persisted namespace into a freshly booted session kernel. Runs at
 * most once per snapshot path per process so a mid-session kernel replacement
 * cannot resurrect state that is staler than the work done since resume.
 * Never throws.
 */
async function restoreKernelStateIfPresent(kernel: PythonKernel, options: PythonExecutorOptions): Promise<void> {
	const dir = resolveStateSnapshotDir(options);
	if (!dir) return;
	const snapshotPath = snapshotPathIn(dir);
	if (restoredSnapshotPaths.has(snapshotPath)) return;
	restoredSnapshotPaths.add(snapshotPath);
	try {
		if (!fs.existsSync(snapshotPath)) return;
		const stdout = await runKernelStateCode(kernel, buildRestoreCode(snapshotPath));
		const result = parseRestoreResult(stdout, snapshotPath);
		if (!result) {
			logger.debug("Python kernel state restore skipped", {
				path: snapshotPath,
				reason: parseMarkerError(stdout) ?? "no result marker",
			});
			return;
		}
		if (result.restored.length === 0 && result.failed.length === 0) return;
		pendingRestoreNotices.set(kernel, formatRestoreNotice(result));
		logger.debug("Python kernel state restored", {
			path: snapshotPath,
			restored: result.restored.length,
			failed: result.failed.length,
		});
	} catch (err) {
		logger.debug("Python kernel state restore failed", {
			path: snapshotPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ---------------------------------------------------------------------------
// Cancellation plumbing
// ---------------------------------------------------------------------------

class PythonExecutionCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "Command timed out" : "Command aborted");
		this.name = "PythonExecutionCancelledError";
		this.timedOut = timedOut;
	}
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	return requireRemainingKernelTimeoutMs(deadlineMs, PythonExecutionCancelledError);
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

const formatTimeoutAnnotation = formatSessionTimeoutAnnotation;

const formatKernelTimeoutAnnotation = formatSessionKernelTimeoutAnnotation;

function createCancelledPythonResult(timedOut: boolean, timeoutMs?: number): PythonResult {
	const output = timedOut ? (formatTimeoutAnnotation(timeoutMs) ?? "Command timed out") : "";
	return createCancelledKernelResult(output);
}

// ---------------------------------------------------------------------------
// Kernel start helpers
// ---------------------------------------------------------------------------

async function startKernel(cwd: string, options: PythonExecutorOptions): Promise<PythonKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	const kernel = await PythonKernel.start({
		cwd,
		env: buildManagedKernelEnv(options),
		signal: options.signal,
		deadlineMs: options.deadlineMs,
		interpreter: options.interpreter,
	});
	await restoreKernelStateIfPresent(kernel, options);
	return kernel;
}

async function replaceSessionKernel(
	session: PythonSession,
	cwd: string,
	options: PythonExecutorOptions,
	context: KernelSessionRegistryContext<PythonKernel, PythonExecutorOptions, PythonSession>,
): Promise<PythonKernel> {
	const kernel = session.kernel;
	const generation = session.generation;
	const inFlight = session.replacement;
	if (inFlight?.generation === generation) {
		if (
			inFlight.deadlineMs !== undefined &&
			(options.deadlineMs === undefined || options.deadlineMs > inFlight.deadlineMs)
		) {
			inFlight.deadlineMs = options.deadlineMs;
		}
		return await waitForPromiseWithCancellation(inFlight.promise, options, PythonExecutionCancelledError);
	}
	if (
		context.sessions.get(session.sessionKey) !== session ||
		session.generation !== generation ||
		session.kernel !== kernel
	) {
		throw new PythonExecutionCancelledError(false);
	}

	const deferred = Promise.withResolvers<PythonKernel>();
	const replacement: SessionKernelReplacement = {
		generation,
		deadlineMs: options.deadlineMs,
		promise: deferred.promise,
	};
	session.replacement = replacement;
	void (async () => {
		try {
			const remaining = getRemainingTimeoutMs(options.deadlineMs);
			await kernel
				.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined)
				.catch(() => undefined);
			if (replacement.deadlineMs !== undefined && replacement.deadlineMs <= Date.now()) {
				throw new PythonExecutionCancelledError(true);
			}
			if (
				context.sessions.get(session.sessionKey) !== session ||
				session.generation !== generation ||
				session.kernel !== kernel
			) {
				throw new PythonExecutionCancelledError(false);
			}
			const next = await startKernel(cwd, {
				...options,
				signal: undefined,
				deadlineMs: undefined,
			});
			if (
				context.sessions.get(session.sessionKey) !== session ||
				session.generation !== generation ||
				session.kernel !== kernel
			) {
				await next.shutdown().catch(() => undefined);
				throw new PythonExecutionCancelledError(false);
			}
			session.kernel = next;
			session.generation += 1;
			deferred.resolve(next);
		} catch (err) {
			deferred.reject(err);
		} finally {
			if (session.replacement === replacement) session.replacement = undefined;
		}
	})();
	return await waitForPromiseWithCancellation(deferred.promise, options, PythonExecutionCancelledError);
}

async function shutdownInvalidatedSession(session: PythonSession, resetting: boolean): Promise<KernelShutdownResult> {
	const replacement = session.replacement;
	if (replacement) await replacement.promise.catch(() => undefined);
	if (!resetting) await snapshotKernelState(session);
	return await session.kernel.shutdown();
}

async function acquireLiveSessionKernel(
	session: PythonSession,
	cwd: string,
	options: PythonExecutorOptions,
	context: KernelSessionRegistryContext<PythonKernel, PythonExecutorOptions, PythonSession>,
): Promise<PythonKernel> {
	session.stateSnapshotDir = resolveStateSnapshotDir(options);
	while (context.sessions.get(session.sessionKey) === session) {
		const kernel = session.kernel;
		if (kernel.isAlive()) return kernel;
		await context.replaceSessionKernel(session, cwd, options);
	}
	throw new PythonExecutionCancelledError(false);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function executeWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options: PythonExecutorOptions | undefined,
): Promise<PythonResult> {
	const notice = pendingRestoreNotices.get(kernel);
	if (notice !== undefined) {
		pendingRestoreNotices.delete(kernel);
		await options?.onChunk?.(notice);
	}
	const result = await executeWithKernelBase<PythonExecutorOptions>({
		kernel,
		code,
		options,
		runIdPrefix: "py",
		errorLogLabel: "Python",
		cancelledErrorClass: PythonExecutionCancelledError,
		buildKernelEnvPatch: buildManagedKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
	});
	if (notice !== undefined) result.output = notice + result.output;
	return result;
}

async function ensureKernelAvailable(cwd: string, options: PythonExecutorOptions): Promise<void> {
	const availability = await waitForPromiseWithCancellation(
		checkPythonKernelAvailability(cwd, options.interpreter),
		options,
		PythonExecutionCancelledError,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Python kernel unavailable");
	}
}

async function ensureToolBridge(options: PythonExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensurePyToolBridge();
	} catch (err) {
		logger.warn("Failed to start Python tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function executePerCall(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = `py-bridge:${crypto.randomUUID()}`;
	}
	const kernel = await startKernel(cwd, options);
	try {
		return await executeWithKernel(kernel, code, { ...options, cwd });
	} finally {
		await kernel.shutdown().catch(() => undefined);
	}
}

const sessionRegistry = createKernelSessionRegistry<PythonKernel, PythonExecutorOptions, PythonResult, PythonSession>({
	languageLabel: "Python",
	cancelledErrorClass: PythonExecutionCancelledError,
	buildSessionKey: (sessionId, cwd, interpreter) => {
		const normalizedCwd = normalizeKernelSessionCwd(cwd);
		return `${sessionId}\0${normalizedCwd}\0${normalizeExplicitInterpreter(normalizedCwd, interpreter)}`;
	},
	createSession: session => ({ ...session, generation: 0 }),
	startKernel,
	executeWithKernel,
	replaceSessionKernel,
	acquireLiveSessionKernel,
	invalidateSession: session => {
		session.generation += 1;
	},
	shutdownSession: (session, resetting) => shutdownInvalidatedSession(session, resetting),
	validateKernel: (session, kernel) => session.kernel === kernel,
});

/**
 * Live-kernel peek for the post-compaction kernel-state notice. Returns the
 * session's kernel only when it is already running; never spawns one.
 */
export function peekLivePythonKernel(sessionId: string): PythonKernelExecutor | undefined {
	const session = sessionRegistry.peekSessionById(sessionId);
	return session?.kernel.isAlive() ? session.kernel : undefined;
}

export async function disposeAllKernelSessions(): Promise<void> {
	await sessionRegistry.disposeAll();
}

export async function disposeKernelSessionsByOwner(ownerId: string): Promise<void> {
	await sessionRegistry.disposeByOwner(ownerId);
}

export async function executePythonWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options?: PythonExecutorOptions,
): Promise<PythonResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executePython(code: string, options?: PythonExecutorOptions): Promise<PythonResult> {
	const cwd = normalizeKernelSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs = getExecutionDeadlineMs(options);
	const executionOptions: PythonExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new PythonExecutionCancelledError(
				isTimedOutCancellation(
					executionOptions.signal.reason,
					PythonExecutionCancelledError,
					executionOptions.signal,
				),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		await ensureToolBridge(executionOptions);

		const kernelMode = executionOptions.kernelMode ?? "session";
		if (kernelMode === "per-call") {
			return await executePerCall(code, cwd, executionOptions);
		}
		return await sessionRegistry.executeOnSession(code, cwd, executionOptions);
	} catch (err) {
		if (isCancellationError(err, PythonExecutionCancelledError) || executionOptions.signal?.aborted) {
			return createCancelledPythonResult(
				isTimedOutCancellation(err, PythonExecutionCancelledError, executionOptions.signal),
			);
		}
		throw err;
	}
}
