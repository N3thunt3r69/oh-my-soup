/**
 * Host side of the Frida worker protocol.
 *
 * A single worker process outlives individual tool calls so sessions, injected
 * agents, and buffered messages persist across the conversation — the same
 * reason `dapSessionManager` is a module singleton. Framing is
 * newline-delimited JSON (mirroring the Binary Ninja worker), extended with
 * id-less `event` frames the worker pushes asynchronously when a script calls
 * `send()`, a hook fires, a target detaches, or a spawned child writes output.
 *
 * The worker owns all session state; this class owns only the pipe.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ChildProcess, ptree } from "@oh-my-soup/pi-utils";
import * as postmortem from "@oh-my-soup/pi-utils/postmortem";
import { ensureFridaRuntime, resolveBasePython, resolveFridaRuntime } from "./runtime";
import workerSource from "./worker.py" with { type: "text" };

const MAX_RESPONSE_FRAME_CHARS = 32 * 1024 * 1024;
const START_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export interface FridaWorkerStartOptions {
	/** Explicit interpreter; falls back to discovery. */
	python?: string;
	cwd: string;
}

/** Counters describing asynchronous traffic seen since the worker started. */
export interface FridaWorkerLiveState {
	running: boolean;
	fridaVersion?: string;
	python?: string;
	/** Event frames observed on the pipe (messages, detaches, output). */
	eventsSeen: number;
}

export class FridaWorkerError extends Error {}

class FridaWorker {
	#process?: ChildProcess<"pipe">;
	#stdin?: Bun.FileSink;
	#pending = new Map<string, PendingRequest>();
	#counter = 0;
	#starting?: Promise<void>;
	#fridaVersion?: string;
	#python?: string;
	#eventsSeen = 0;
	#exitReason?: string;

	get live(): FridaWorkerLiveState {
		return {
			running: this.#process !== undefined && this.#process.exitCode === null,
			fridaVersion: this.#fridaVersion,
			python: this.#python,
			eventsSeen: this.#eventsSeen,
		};
	}

	/** Start the worker if it is not already running. Concurrent calls share one boot. */
	async ensureStarted(options: FridaWorkerStartOptions, signal?: AbortSignal): Promise<void> {
		if (this.#process && this.#process.exitCode === null) return;
		if (signal?.aborted) throw new FridaWorkerError("Frida worker start aborted");
		if (!this.#starting) {
			this.#starting = this.#start(options).finally(() => {
				this.#starting = undefined;
			});
		}
		const boot = this.#starting;
		if (!signal) return boot;
		let abortListener: (() => void) | undefined;
		try {
			await Promise.race([
				boot,
				new Promise<never>((_resolve, reject) => {
					abortListener = () => reject(new FridaWorkerError("Frida worker start aborted"));
					signal.addEventListener("abort", abortListener, { once: true });
				}),
			]);
		} finally {
			if (abortListener) signal.removeEventListener("abort", abortListener);
		}
	}

	async #start(options: FridaWorkerStartOptions): Promise<void> {
		const basePython = await resolveBasePython(options.python);
		const runtime = resolveFridaRuntime(basePython);
		await ensureFridaRuntime(runtime, process.env, options.cwd);

		const workerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oms-frida-worker-"));
		const workerPath = path.join(workerDirectory, "worker.py");
		await Bun.write(workerPath, workerSource);

		const child = ptree.spawn([runtime.python, "-u", workerPath], {
			cwd: options.cwd,
			stdin: "pipe",
			env: process.env,
			detached: true,
		});
		const stdin = child.stdin;
		if (!stdin || typeof stdin === "number") {
			child.kill();
			await fs.rm(workerDirectory, { recursive: true, force: true }).catch(() => {});
			throw new FridaWorkerError("Frida worker stdin is unavailable");
		}
		this.#process = child;
		this.#stdin = stdin;
		this.#exitReason = undefined;
		void this.#readLoop(child);
		void this.#monitorExit(child, workerDirectory);

		try {
			const ready =
				(await this.#request<{ fridaVersion?: string; executable?: string }>("ping", {}, START_TIMEOUT_MS)) ?? {};
			this.#fridaVersion = ready.fridaVersion;
			this.#python = ready.executable ?? runtime.python;
		} catch (error) {
			this.#retire(child, "Frida worker failed during startup");
			await child.exited.catch(() => undefined);
			throw error;
		}
	}

	async #monitorExit(child: ChildProcess<"pipe">, workerDirectory: string): Promise<void> {
		const code = await child.exited.catch(() => child.exitCode ?? -1);
		const stderr = child.peekStderr().trim();
		if (this.#process === child) {
			const reason = `Frida worker exited (code ${code})${stderr ? `\n${stderr}` : ""}`;
			this.#exitReason = reason;
			this.#process = undefined;
			this.#stdin = undefined;
			this.#failAll(reason);
		}
		await fs.rm(workerDirectory, { recursive: true, force: true }).catch(() => {});
	}

	async #readLoop(child: ChildProcess<"pipe">): Promise<void> {
		const decoder = new TextDecoder();
		let readBuffer = "";
		try {
			for await (const chunk of child.stdout) {
				readBuffer += decoder.decode(chunk, { stream: true });
				while (true) {
					const newline = readBuffer.indexOf("\n");
					if (newline < 0) {
						if (readBuffer.length > MAX_RESPONSE_FRAME_CHARS) {
							this.#retire(child, "Frida worker response exceeded the framing limit");
							readBuffer = "";
						}
						break;
					}
					const line = readBuffer.slice(0, newline).trim();
					readBuffer = readBuffer.slice(newline + 1);
					if (line) this.#handleFrame(line);
				}
			}
		} catch (error) {
			this.#retire(child, `Frida worker stream failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#handleFrame(line: string): void {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return; // A non-JSON line is worker noise; the protocol is line-oriented.
		}
		if (typeof frame.event === "string") {
			this.#eventsSeen++;
			return;
		}
		const id = typeof frame.id === "string" ? frame.id : undefined;
		if (!id) return;
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		if (frame.ok === true) {
			pending.resolve(frame.result);
			return;
		}
		const message = typeof frame.error === "string" ? frame.error : "Unknown Frida worker error";
		const traceback = typeof frame.traceback === "string" ? `\n${frame.traceback}` : "";
		pending.reject(new FridaWorkerError(`${message}${traceback}`));
	}

	#failAll(message: string): void {
		const error = new FridaWorkerError(message);
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	#retire(child: ChildProcess<"pipe">, reason: string): void {
		if (this.#process === child) {
			this.#process = undefined;
			this.#stdin = undefined;
			this.#exitReason = reason;
			this.#failAll(reason);
		}
		if (child.exitCode === null) child.kill();
	}

	/** Issue one request. The worker must already be started. */
	async request<T>(op: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
		if (!this.#process || this.#process.exitCode !== null) {
			throw new FridaWorkerError(this.#exitReason ?? "Frida worker is not running");
		}
		if (signal?.aborted) throw new FridaWorkerError("Frida request aborted");
		return (await this.#request<T>(op, args, timeoutMs, signal)) as T;
	}

	async #request<T>(op: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
		const child = this.#process;
		const stdin = this.#stdin;
		if (!child || !stdin) throw new FridaWorkerError(this.#exitReason ?? "Frida worker is not running");
		this.#counter += 1;
		const id = `req-${this.#counter}`;
		const result = new Promise<unknown>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
		});
		try {
			stdin.write(`${JSON.stringify({ ...args, id, op })}\n`);
			stdin.flush();
		} catch (error) {
			this.#pending.delete(id);
			this.#retire(child, "Could not write to the Frida worker");
			throw new FridaWorkerError(`Could not write to the Frida worker: ${String(error)}`);
		}

		let timer: NodeJS.Timeout | undefined;
		let abortListener: (() => void) | undefined;
		const races: Promise<never>[] = [
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					const message = `Frida ${op} timed out after ${Math.round(timeoutMs / 1000)}s; the worker was retired`;
					this.#pending.delete(id);
					this.#retire(child, message);
					reject(new FridaWorkerError(message));
				}, timeoutMs);
			}),
		];
		if (signal) {
			races.push(
				new Promise<never>((_resolve, reject) => {
					abortListener = () => {
						const message = `Frida ${op} aborted; the worker was retired`;
						this.#pending.delete(id);
						this.#retire(child, message);
						reject(new FridaWorkerError(message));
					};
					signal.addEventListener("abort", abortListener, { once: true });
				}),
			);
		}
		try {
			return (await Promise.race([result, ...races])) as T;
		} finally {
			clearTimeout(timer);
			if (signal && abortListener) signal.removeEventListener("abort", abortListener);
		}
	}

	/** Detach every session and stop the worker. Safe to call when not running. */
	async shutdown(): Promise<void> {
		const child = this.#process;
		if (!child || child.exitCode !== null) return;
		try {
			await this.#request("shutdown", {}, SHUTDOWN_TIMEOUT_MS);
		} catch {
			// The worker may already be gone; fall through to the hard kill.
		}
		try {
			this.#stdin?.end();
		} catch {
			// Closing a dead pipe is not an error worth surfacing.
		}
		const exited = child.exited.catch(() => child.exitCode ?? -1);
		const timer = setTimeout(() => child.kill(), SHUTDOWN_TIMEOUT_MS);
		try {
			await exited;
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * Process-wide worker. Frida sessions must outlive a single tool call, so the
 * instance is module-scoped exactly like `dapSessionManager`.
 */
export const fridaWorker = new FridaWorker();

postmortem.register("frida-worker", () => fridaWorker.shutdown());
