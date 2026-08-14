/**
 * Backend-neutral contract for the `frida` dynamic-instrumentation tool.
 *
 * The TypeScript side owns process/session bookkeeping and the model-facing
 * surface; a managed Python worker owns the live Frida runtime (device
 * enumeration, spawn/attach, script injection) and a resident JS agent owns
 * in-process instrumentation (memory, modules, interceptors). See
 * `src/frida/worker.py`.
 */

/** A Frida device: the local system, a USB-attached handset, or a remote frida-server. */
export interface FridaDeviceInfo {
	id: string;
	name: string;
	/** `local` | `usb` | `remote` | `barebone`. */
	type: string;
}

/** One process visible to a device. */
export interface FridaProcessInfo {
	pid: number;
	name: string;
}

/** One installed application (mobile devices report these; desktop usually does not). */
export interface FridaApplicationInfo {
	identifier: string;
	name: string;
	/** Present only when the application is currently running. */
	pid?: number;
}

/** A live attachment to one process. */
export interface FridaSessionInfo {
	id: string;
	pid: number;
	name?: string;
	device: string;
	/** Script ids currently loaded into this session. */
	scripts: string[];
	/** Set once the target died or detached; the session is then read-only. */
	detached?: string;
	/** True when the process was spawned suspended and has not been resumed. */
	pendingResume?: boolean;
}

/** A loaded agent script. */
export interface FridaScriptInfo {
	id: string;
	session: string;
	name: string;
}

/** Kinds of asynchronous traffic buffered from the target. */
export type FridaMessageKind = "send" | "error" | "hook" | "detached" | "output";

/**
 * One buffered asynchronous message. Scripts emit these via `send()`, hooks
 * emit them on enter/leave, and the worker synthesizes `detached`/`output`
 * records for lifecycle and spawned-process stdio.
 */
export interface FridaMessageRecord {
	/** Monotonic per-worker sequence; the drain cursor. */
	seq: number;
	kind: FridaMessageKind;
	session: string;
	script?: string;
	payload: unknown;
	/** Base64 of the binary payload frida delivers alongside `send()`, when present. */
	data?: string;
	/** Unix milliseconds. */
	timestamp: number;
}

export interface FridaModuleInfo {
	name: string;
	base: string;
	size: number;
	path: string;
}

export interface FridaExportInfo {
	type: string;
	name: string;
	address: string;
}

export interface FridaRangeInfo {
	base: string;
	size: number;
	protection: string;
	path?: string;
}

export interface FridaHookInfo {
	id: string;
	session: string;
	spec: string;
	address: string;
	/** Symbol the address resolved to, when frida could name it. */
	symbol?: string;
}

export interface FridaScanMatch {
	address: string;
	size: number;
}

/** Result of `read`: hex-encoded bytes plus the address actually read. */
export interface FridaMemoryRead {
	address: string;
	size: number;
	hex: string;
}

/** Everything the worker knows, returned by the `sessions` action. */
export interface FridaRuntimeSnapshot {
	fridaVersion: string;
	python: string;
	sessions: FridaSessionInfo[];
	scripts: FridaScriptInfo[];
	hooks: FridaHookInfo[];
	/** Buffered messages not yet drained, per session. */
	pendingMessages: number;
}
