/**
 * Goal quality gates: shell commands that must exit 0 before a goal may
 * complete. Ported from prime-agent's autonomous-mode gate loop (MIT),
 * adapted to oms's goal mode.
 *
 * On goal-continuation boundaries the gates run with bounded per-command
 * retries; a failing gate's tail output feeds the continuation prompt
 * verbatim. A hash of the git worktree (status + diff + untracked content)
 * deduplicates reruns: if nothing changed since the last failed gate run,
 * the gate is not rerun and the model is steered with "workspace unchanged"
 * instead.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";

export interface GoalGateFailure {
	command: string;
	attempt: number;
	exitText: string;
	output: string;
}

export interface GoalGateState {
	attempts: Record<string, number>;
	lastFailure?: GoalGateFailure;
	/** Worktree snapshot hash captured right after the last failed gate run. */
	lastFailureSnapshot?: string;
}

export type GoalGateOutcome = "passed" | "failed" | "retry_exhausted";

export interface GoalGateExecResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: Error;
	timedOut?: boolean;
	outputTruncated?: boolean;
}

export type GoalGateExec = (
	command: string,
	options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<GoalGateExecResult>;

export type GoalGateSnapshot = (cwd: string, signal?: AbortSignal) => Promise<string | undefined>;

export interface GoalGateRunOptions {
	cwd?: string;
	signal?: AbortSignal;
	maxRetries?: number;
	timeoutMs?: number;
	/** Injectable command runner (tests). Defaults to a shell child process. */
	exec?: GoalGateExec;
	/** Injectable worktree snapshotter (tests). Defaults to git status+diff+untracked hashing. */
	captureSnapshot?: GoalGateSnapshot;
}

export const DEFAULT_GOAL_GATE_MAX_RETRIES = 3;
export const DEFAULT_GOAL_GATE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_GATE_OUTPUT_CHARS = 6000;

export const GOAL_GATE_UNCHANGED_EXIT_TEXT = "not rerun: workspace unchanged since previous failed gate";
export const GOAL_GATE_UNCHANGED_OUTPUT =
	"The quality gate was not rerun because the workspace has not changed since this failure. " +
	"Edit source files, tests, or a blocker artifact before attempting to finish again.";

export function createGoalGateState(): GoalGateState {
	return { attempts: {} };
}

export function normalizeGoalGateCommands(gates: readonly string[] | undefined): string[] | undefined {
	const commands = (gates ?? []).map(command => command.trim()).filter(command => command.length > 0);
	return commands.length > 0 ? commands : undefined;
}

/**
 * Runs the gate commands in order, stopping at the first failure. Mutates
 * `state` with per-command attempt counts and the last failure (including a
 * post-run worktree snapshot hash used for the unchanged-workspace dedup).
 */
export async function runGoalGates(
	commands: readonly string[],
	state: GoalGateState,
	options: GoalGateRunOptions = {},
): Promise<GoalGateOutcome> {
	options.signal?.throwIfAborted();
	const cwd = options.cwd;
	if (!cwd) return "failed";
	const maxRetries = normalizeLimit(options.maxRetries, DEFAULT_GOAL_GATE_MAX_RETRIES);
	const timeoutMs = normalizeLimit(options.timeoutMs, DEFAULT_GOAL_GATE_TIMEOUT_MS);
	const exec = options.exec ?? defaultGoalGateExec;
	const captureSnapshot = options.captureSnapshot ?? captureWorktreeSnapshotHash;
	for (const command of commands) {
		const currentSnapshot = await captureSnapshot(cwd, options.signal);
		options.signal?.throwIfAborted();
		if (
			state.lastFailure?.command === command &&
			state.lastFailureSnapshot !== undefined &&
			currentSnapshot !== undefined &&
			currentSnapshot === state.lastFailureSnapshot
		) {
			const attempt = (state.attempts[command] ?? state.lastFailure.attempt) + 1;
			state.attempts[command] = attempt;
			state.lastFailure = {
				...state.lastFailure,
				attempt,
				exitText: GOAL_GATE_UNCHANGED_EXIT_TEXT,
				output: GOAL_GATE_UNCHANGED_OUTPUT,
			};
			return attempt > maxRetries ? "retry_exhausted" : "failed";
		}
		const result = await exec(command, { cwd, timeoutMs, signal: options.signal });
		options.signal?.throwIfAborted();
		const postRunSnapshot = await captureSnapshot(cwd, options.signal);
		options.signal?.throwIfAborted();
		if (result.status === 0 && !result.error && !result.timedOut) {
			state.attempts[command] = 0;
			if (state.lastFailure?.command === command) {
				state.lastFailure = undefined;
				state.lastFailureSnapshot = undefined;
			}
			continue;
		}
		const attempt = (state.attempts[command] ?? 0) + 1;
		state.attempts[command] = attempt;
		state.lastFailure = {
			command,
			attempt,
			exitText: formatGateExit(result),
			output: truncateGateOutput(
				[result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
				result.outputTruncated === true,
			),
		};
		state.lastFailureSnapshot = postRunSnapshot;
		return attempt > maxRetries ? "retry_exhausted" : "failed";
	}
	state.lastFailure = undefined;
	state.lastFailureSnapshot = undefined;
	return "passed";
}

/** Continuation prompt for a failed gate — ported verbatim shape from prime-agent. */
export function buildGoalGateFailureContinuation(
	failure: GoalGateFailure,
	maxRetries: number,
	timestamp = Date.now(),
): string {
	return (
		`Goal quality gate failed (attempt ${failure.attempt}/${maxRetries}): \`${failure.command}\` ${failure.exitText}.\n` +
		(failure.output ? `\nOutput:\n${failure.output}\n` : "\n") +
		`\nContinue working. Fix the failure, then produce terminal evidence. Timestamp: ${new Date(timestamp).toISOString()}.`
	);
}

/**
 * Hashes the git worktree: porcelain status, diff against HEAD, and the
 * content of untracked files. Returns undefined when the state cannot be
 * captured reliably (not a git repo, git errors, output truncated) so the
 * dedup fails open and gates rerun.
 */
export async function captureWorktreeSnapshotHash(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	signal?.throwIfAborted();
	const status = await runChildProcess(
		"git",
		["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall", "--no-renames"],
		{ cwd, timeoutMs: 10_000, signal },
	);
	signal?.throwIfAborted();
	if (status.status !== 0 || status.error || status.timedOut || status.outputTruncated) {
		return undefined;
	}
	const diff = await runChildProcess("git", ["--no-optional-locks", "diff", "--no-ext-diff", "--binary", "HEAD"], {
		cwd,
		timeoutMs: 10_000,
		signal,
	});
	signal?.throwIfAborted();
	if (diff.status !== 0 || diff.error || diff.timedOut || diff.outputTruncated) {
		return undefined;
	}
	const aggregate = createHash("sha256");
	aggregate.update(status.stdout);
	aggregate.update("\0");
	aggregate.update(diff.stdout);
	aggregate.update("\0");
	aggregate.update(await hashUntrackedFiles(cwd, status.stdout, signal));
	return aggregate.digest("hex");
}

async function hashUntrackedFiles(cwd: string, status: string, signal?: AbortSignal): Promise<string> {
	const untrackedPaths = status
		.split("\0")
		.filter(entry => entry.startsWith("?? "))
		.map(entry => entry.slice(3))
		.sort();
	const aggregate = createHash("sha256");
	for (const path of untrackedPaths) {
		signal?.throwIfAborted();
		aggregate.update(path);
		aggregate.update("\0");
		aggregate.update(await hashUntrackedPath(resolve(cwd, path), signal));
		aggregate.update("\0");
	}
	signal?.throwIfAborted();
	return aggregate.digest("hex");
}

async function hashUntrackedPath(path: string, signal?: AbortSignal): Promise<string> {
	try {
		signal?.throwIfAborted();
		const stat = await lstat(path);
		signal?.throwIfAborted();
		if (stat.isSymbolicLink()) {
			const target = await readlink(path);
			return `symlink:${target}`;
		}
		if (!stat.isFile()) {
			return `other:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
		}
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(path, { signal })) {
			hash.update(chunk as Buffer);
		}
		signal?.throwIfAborted();
		return `file:${hash.digest("hex")}`;
	} catch (error) {
		signal?.throwIfAborted();
		return `error:${error instanceof Error ? error.message : String(error)}`;
	}
}

const defaultGoalGateExec: GoalGateExec = (command, options) =>
	runChildProcess(command, [], {
		cwd: options.cwd,
		shell: true,
		timeoutMs: options.timeoutMs,
		maxOutputChars: MAX_GATE_OUTPUT_CHARS,
		signal: options.signal,
	});

const MAX_CHILD_PROCESS_OUTPUT_CHARS = 1024 * 1024;

function killGateProcessTree(child: ChildProcess): void {
	if (child.pid !== undefined && process.platform !== "win32") {
		// The child is spawned detached on POSIX, so the negative pid targets
		// its whole process group.
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// fall through to a direct kill
		}
	}
	child.kill("SIGKILL");
}

function runChildProcess(
	command: string,
	args: string[],
	options: {
		cwd?: string;
		shell?: boolean;
		timeoutMs?: number;
		maxOutputChars?: number;
		signal?: AbortSignal;
	} = {},
): Promise<GoalGateExecResult> {
	options.signal?.throwIfAborted();
	const { promise, resolve: resolveResult } = Promise.withResolvers<GoalGateExecResult>();
	const child = spawn(command, args, {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		shell: options.shell === true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let error: Error | undefined;
	let timedOut = false;
	let outputTruncated = false;
	let settled = false;
	const maxOutputChars = options.maxOutputChars ?? MAX_CHILD_PROCESS_OUTPUT_CHARS;
	const finish = (result: Pick<GoalGateExecResult, "status" | "signal">) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		resolveResult({ ...result, stdout, stderr, error, timedOut, outputTruncated });
	};
	const timer = options.timeoutMs
		? setTimeout(() => {
				timedOut = true;
				killGateProcessTree(child);
			}, options.timeoutMs)
		: undefined;
	const abort = () => {
		killGateProcessTree(child);
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) {
		abort();
	}
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		const remaining = maxOutputChars - stdout.length;
		if (remaining > 0) {
			stdout += chunk.slice(0, remaining);
		}
		outputTruncated ||= chunk.length > remaining;
	});
	child.stderr?.on("data", (chunk: string) => {
		const remaining = maxOutputChars - stderr.length;
		if (remaining > 0) {
			stderr += chunk.slice(0, remaining);
		}
		outputTruncated ||= chunk.length > remaining;
	});
	child.on("error", err => {
		error = err;
		finish({ status: child.exitCode, signal: child.signalCode });
	});
	child.on("close", (status, exitSignal) => {
		finish({ status, signal: exitSignal });
	});
	return promise;
}

function formatGateExit(result: GoalGateExecResult): string {
	if (result.timedOut) return "timed out";
	if (result.error) return result.error.message;
	return result.signal ? `terminated by ${result.signal}` : `exited ${result.status ?? "unknown"}`;
}

function truncateGateOutput(output: string, outputAlreadyTruncated = false, maxChars = MAX_GATE_OUTPUT_CHARS): string {
	if (output.length <= maxChars && !outputAlreadyTruncated) {
		return output;
	}
	return `${output.slice(0, maxChars)}\n... [truncated]`;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return Math.trunc(value);
}
