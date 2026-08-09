import { type } from "@oh-my-soup/omstype";

const PROTOCOL_VERSION = 4;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const freeformObjectSchema = type({ "[string]": "unknown" });
const wireEnvelopeSchema = type({ v: "number", type: "string", "[string]": "unknown" });
const clientInfoSchema = type({
	"+": "reject",
	client_id: "string > 0",
	role: "'agent' | 'ida'",
	meta: freeformObjectSchema,
	"session_id?": "string > 0 | null",
});
const helloAckSchema = type({
	"+": "reject",
	v: "number",
	type: "'hello_ack'",
	client_id: "string > 0",
	bridge_id: "string > 0",
	meta: freeformObjectSchema,
});
const protocolErrorSchema = type({
	"+": "reject",
	v: "number",
	type: "'error'",
	code: "string > 0",
	message: "string > 0",
	"trace?": freeformObjectSchema.or("null"),
});
const listResponseSchema = type({
	"+": "reject",
	v: "number",
	type: "'list_response'",
	id: "string > 0",
	src: "string > 0",
	dst: "string > 0",
	ok: "boolean",
	"code?": "string > 0 | null",
	"message?": "string > 0 | null",
	"trace?": freeformObjectSchema.or("null"),
	kind: "'ida' | 'all'",
	"clients?": clientInfoSchema.array().or("null"),
});
const execResponseSchema = type({
	"+": "reject",
	v: "number",
	type: "'exec_response'",
	id: "string > 0",
	src: "string > 0",
	dst: "string > 0",
	ok: "boolean",
	"code?": "string > 0 | null",
	"message?": "string > 0 | null",
	"trace?": freeformObjectSchema.or("null"),
	"result?": "unknown",
	"stdout?": "string | null",
	"stderr?": "string | null",
	"traceback?": "string | null",
});
const resetResponseSchema = type({
	"+": "reject",
	v: "number",
	type: "'reset_response'",
	id: "string > 0",
	src: "string > 0",
	dst: "string > 0",
	ok: "boolean",
	"code?": "string > 0 | null",
	"message?": "string > 0 | null",
	"trace?": freeformObjectSchema.or("null"),
});
const quitResponseSchema = type({
	"+": "reject",
	v: "number",
	type: "'quit_response'",
	id: "string > 0",
	src: "string > 0",
	dst: "string > 0",
	ok: "boolean",
	"code?": "string > 0 | null",
	"message?": "string > 0 | null",
	"trace?": freeformObjectSchema.or("null"),
});

type WireEnvelope = typeof wireEnvelopeSchema.infer;
type ClientInfoWire = typeof clientInfoSchema.infer;
type RoutedResponseWire =
	| typeof listResponseSchema.infer
	| typeof execResponseSchema.infer
	| typeof resetResponseSchema.infer
	| typeof quitResponseSchema.infer;

export const DEFAULT_IDA_BRIDGE_URL = `ws://${DEFAULT_HOST}:${DEFAULT_PORT}`;

export type IdaBridgeRole = "agent" | "ida";

export interface IdaBridgeClientInfo {
	clientId: string;
	role: IdaBridgeRole;
	meta: Record<string, unknown>;
	sessionId?: string;
}

export interface IdaBridgeExecResult {
	result?: unknown;
	stdout?: string;
	stderr?: string;
}

export interface IdaBridgeExecOptions {
	persist?: boolean;
	sessionId?: string;
	timeoutSec?: number;
}

export interface IdaBridgeResetOptions {
	sessionId: string;
	takeover?: boolean;
	release?: boolean;
	timeoutSec?: number;
}

interface RoutedResponse {
	v: number;
	type: "list_response" | "exec_response" | "reset_response" | "quit_response";
	id: string;
	src: string;
	dst: string;
	ok: boolean;
	code?: string;
	message?: string;
	trace?: Record<string, unknown>;
}

interface ListResponse extends RoutedResponse {
	type: "list_response";
	kind: "ida" | "all";
	clients?: IdaBridgeClientInfo[];
}

interface ExecResponse extends RoutedResponse {
	type: "exec_response";
	result?: unknown;
	stdout?: string;
	stderr?: string;
	traceback?: string;
}

interface ResetResponse extends RoutedResponse {
	type: "reset_response";
}

interface QuitResponse extends RoutedResponse {
	type: "quit_response";
}

type IdaResponse = ListResponse | ExecResponse | ResetResponse | QuitResponse;

interface PendingRequest {
	expectedType: IdaResponse["type"];
	target: string;
	resolve: (response: IdaResponse) => void;
	reject: (error: Error) => void;
}

const ERROR_HINTS: Readonly<Record<string, string>> = {
	TARGET_NOT_FOUND: "List connected targets first and use an active IDA client id.",
	TARGET_DISCONNECTED: "Restart IDA or idalib, wait for the plugin to reconnect, then retry.",
	TARGET_PING_TIMEOUT: "IDA may be busy on its main thread. List targets before retrying the operation.",
	TIMEOUT: "Increase the timeout only for a known slow IDA operation; code may still be running after a timeout.",
	QUEUE_FULL: "Wait for the target IDA instance to finish its queued work before retrying.",
	INVALID_TARGET_ROLE: "The target must identify a connected client whose role is ida.",
	SESSION_CONFLICT: "The target is owned by another stateful session. Do not take it over without user approval.",
	TAKEOVER_PENDING: "A stateful-session takeover is already in progress; wait and retry.",
	RELEASE_PENDING: "A stateful-session release is already in progress; wait and retry.",
	SESSION_LOCKED: "The target ownership state is unknown; reconnect the IDA instance to clear the lock.",
};

export class IdaBridgeConnectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IdaBridgeConnectionError";
	}
}

export class IdaBridgeProtocolError extends Error {
	readonly code?: string;
	readonly trace?: Record<string, unknown>;

	constructor(message: string, code?: string, trace?: Record<string, unknown>) {
		super(message);
		this.name = "IdaBridgeProtocolError";
		this.code = code;
		this.trace = trace;
	}
}

export class IdaBridgeRequestError extends Error {
	readonly code: string;
	readonly trace?: Record<string, unknown>;
	readonly traceback?: string;
	readonly stdout?: string;
	readonly stderr?: string;

	constructor(response: IdaResponse) {
		const code = response.code ?? "UNKNOWN";
		const lines = [`IDA bridge ${response.type.replace(/_response$/, "")} failed: ${code}`];
		if (response.message) lines.push(response.message);
		const hint = ERROR_HINTS[code];
		if (hint) lines.push(`Hint: ${hint}`);
		if (response.type === "exec_response") {
			if (response.stdout) lines.push(`stdout:\n${response.stdout}`);
			if (response.stderr) lines.push(`stderr:\n${response.stderr}`);
			if (response.traceback) lines.push(`traceback:\n${response.traceback}`);
		}
		if (response.trace) lines.push(`bridge trace:\n${stringifyUnknown(response.trace)}`);
		super(lines.join("\n"));
		this.name = "IdaBridgeRequestError";
		this.code = code;
		this.trace = response.trace;
		if (response.type === "exec_response") {
			this.traceback = response.traceback;
			this.stdout = response.stdout;
			this.stderr = response.stderr;
		}
	}
}

/** Resolve and validate the ida-bridge WebSocket endpoint. */
export function resolveIdaBridgeUrl(configured?: string): string {
	const explicit = configured?.trim() || process.env.IDA_BRIDGE_URL?.trim();
	let candidate: string;
	if (explicit) {
		candidate = explicit;
	} else {
		const host = process.env.IDA_BRIDGE_HOST?.trim() || DEFAULT_HOST;
		const rawPort = process.env.IDA_BRIDGE_PORT?.trim();
		const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
		if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
			throw new IdaBridgeConnectionError(`Invalid IDA_BRIDGE_PORT: ${rawPort}`);
		}
		const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
		candidate = `ws://${urlHost}:${port}`;
	}

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new IdaBridgeConnectionError(`Invalid IDA bridge URL: ${candidate}`);
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new IdaBridgeConnectionError(`IDA bridge URL must use ws:// or wss://: ${candidate}`);
	}
	if (url.username || url.password) {
		throw new IdaBridgeConnectionError("IDA bridge URL must not contain credentials");
	}
	return url.toString();
}

/** Strict native client for cellebrite-labs/ida-bridge protocol v4. */
export class IdaBridgeClient {
	readonly url: string;
	readonly clientId: string;

	#socket: WebSocket | null = null;
	#bridgeId: string | null = null;
	#connected = false;
	#closing = false;
	#ready: PromiseWithResolvers<void> | null = null;
	#pending = new Map<string, PendingRequest>();

	constructor(options: { url?: string; clientId?: string } = {}) {
		this.url = resolveIdaBridgeUrl(options.url);
		this.clientId = options.clientId ?? `oms-${process.pid}-${crypto.randomUUID()}`;
		if (this.clientId.trim().length === 0) {
			throw new IdaBridgeConnectionError("IDA bridge client id must not be empty");
		}
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.#socket) throw new IdaBridgeConnectionError("IDA bridge client is already connected");
		if (signal?.aborted) throw abortReason(signal);

		this.#closing = false;
		const ready = Promise.withResolvers<void>();
		this.#ready = ready;
		let socket: WebSocket;
		try {
			socket = new WebSocket(this.url);
		} catch (error) {
			this.#ready = null;
			throw connectionError(this.url, error);
		}
		this.#socket = socket;

		socket.onopen = () => {
			if (this.#socket !== socket) return;
			try {
				socket.send(
					JSON.stringify({
						v: PROTOCOL_VERSION,
						type: "hello",
						role: "agent",
						client_id: this.clientId,
						meta: { client: "oms", pid: process.pid },
					}),
				);
			} catch (error) {
				this.#fail(connectionError(this.url, error));
			}
		};
		socket.onmessage = event => {
			if (this.#socket !== socket) return;
			this.#handleMessage(event.data);
		};
		socket.onerror = () => {
			if (this.#socket !== socket || this.#connected) return;
			this.#fail(connectionError(this.url));
		};
		socket.onclose = event => {
			if (this.#socket !== socket || this.#closing) return;
			const detail = event.reason ? `: ${event.reason}` : "";
			this.#fail(new IdaBridgeConnectionError(`IDA bridge disconnected (code ${event.code})${detail}`));
		};

		await waitForSignal(ready.promise, signal, () => this.#fail(abortReason(signal), 1000));
	}

	close(): void {
		this.#closing = true;
		const socket = this.#socket;
		this.#socket = null;
		this.#bridgeId = null;
		this.#connected = false;
		this.#ready = null;
		const error = new IdaBridgeConnectionError("IDA bridge client closed");
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		if (!socket) return;
		detachSocket(socket);
		try {
			socket.close(1000);
		} catch {
			// The socket is already closed.
		}
	}

	async list(signal?: AbortSignal): Promise<IdaBridgeClientInfo[]> {
		const response = (await this.#request(
			"bridge",
			"list_response",
			{ v: PROTOCOL_VERSION, type: "list", kind: "ida" },
			signal,
		)) as ListResponse;
		assertOk(response);
		return response.clients ?? [];
	}

	async exec(
		target: string,
		code: string,
		options: IdaBridgeExecOptions = {},
		signal?: AbortSignal,
	): Promise<IdaBridgeExecResult> {
		if (target.trim().length === 0) throw new IdaBridgeConnectionError("IDA target must not be empty");
		if (options.persist && !options.sessionId) {
			throw new IdaBridgeConnectionError("session_id is required for stateful IDA execution");
		}
		if (!options.persist && options.sessionId) {
			throw new IdaBridgeConnectionError("session_id is only valid for stateful IDA execution");
		}
		const response = (await this.#request(
			target,
			"exec_response",
			{
				v: PROTOCOL_VERSION,
				type: "exec",
				code,
				persist: options.persist ?? false,
				...(options.sessionId ? { session_id: options.sessionId } : {}),
				...(options.timeoutSec !== undefined ? { timeout_s: validateTimeout(options.timeoutSec) } : {}),
			},
			signal,
		)) as ExecResponse;
		assertOk(response);
		return { result: response.result, stdout: response.stdout, stderr: response.stderr };
	}

	async reset(target: string, options: IdaBridgeResetOptions, signal?: AbortSignal): Promise<void> {
		if (!options.sessionId) throw new IdaBridgeConnectionError("session_id is required for IDA reset");
		if (options.takeover && options.release) {
			throw new IdaBridgeConnectionError("takeover and release are mutually exclusive");
		}
		const response = (await this.#request(
			target,
			"reset_response",
			{
				v: PROTOCOL_VERSION,
				type: "reset",
				session_id: options.sessionId,
				takeover: options.takeover ?? false,
				release: options.release ?? false,
				...(options.timeoutSec !== undefined ? { timeout_s: validateTimeout(options.timeoutSec) } : {}),
			},
			signal,
		)) as ResetResponse;
		assertOk(response);
	}

	async quit(target: string, timeoutSec?: number, signal?: AbortSignal): Promise<void> {
		const response = (await this.#request(
			target,
			"quit_response",
			{
				v: PROTOCOL_VERSION,
				type: "quit",
				...(timeoutSec !== undefined ? { timeout_s: validateTimeout(timeoutSec) } : {}),
			},
			signal,
		)) as QuitResponse;
		assertOk(response);
	}

	async #request(
		target: string,
		expectedType: IdaResponse["type"],
		body: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<IdaResponse> {
		const socket = this.#socket;
		const bridgeId = this.#bridgeId;
		if (!socket || !this.#connected || !bridgeId) {
			throw new IdaBridgeConnectionError("IDA bridge client is not connected");
		}
		if (signal?.aborted) throw abortReason(signal);

		const id = crypto.randomUUID();
		const deferred = Promise.withResolvers<IdaResponse>();
		this.#pending.set(id, {
			expectedType,
			target: target === "bridge" ? bridgeId : target,
			resolve: deferred.resolve,
			reject: deferred.reject,
		});
		try {
			socket.send(
				JSON.stringify({
					...body,
					id,
					src: this.clientId,
					dst: target === "bridge" ? bridgeId : target,
				}),
			);
		} catch (error) {
			this.#pending.delete(id);
			throw connectionError(this.url, error);
		}

		return waitForSignal(deferred.promise, signal, () => this.#fail(abortReason(signal), 1000));
	}

	#handleMessage(data: unknown): void {
		let message: WireEnvelope;
		try {
			message = parseWireMessage(data);
		} catch (error) {
			this.#fail(error instanceof Error ? error : new IdaBridgeProtocolError(String(error)), 1002);
			return;
		}

		if (!this.#connected) {
			try {
				if (message.type === "error") throw parseBridgeProtocolError(message);
				this.#bridgeId = validateHelloAck(message, this.clientId);
				this.#connected = true;
				this.#ready?.resolve();
			} catch (error) {
				this.#fail(error instanceof Error ? error : new IdaBridgeProtocolError(String(error)), 1002);
			}
			return;
		}

		if (message.type === "error") {
			this.#fail(parseBridgeProtocolError(message), 1008);
			return;
		}

		let response: IdaResponse;
		try {
			response = validateResponse(message);
		} catch (error) {
			this.#fail(error instanceof Error ? error : new IdaBridgeProtocolError(String(error)), 1002);
			return;
		}
		const pending = this.#pending.get(response.id);
		if (!pending) {
			this.#fail(new IdaBridgeProtocolError(`Unexpected IDA bridge response id: ${response.id}`), 1002);
			return;
		}
		if (response.dst !== this.clientId) {
			this.#fail(new IdaBridgeProtocolError(`IDA bridge response destination mismatch: ${response.dst}`), 1002);
			return;
		}
		if (response.type !== pending.expectedType) {
			this.#fail(new IdaBridgeProtocolError(`Expected ${pending.expectedType}, received ${response.type}`), 1002);
			return;
		}
		const fromTarget = response.src === pending.target;
		const bridgeFailure = response.src === this.#bridgeId && !response.ok;
		if (!fromTarget && !bridgeFailure) {
			this.#fail(new IdaBridgeProtocolError(`IDA bridge response source mismatch: ${response.src}`), 1002);
			return;
		}
		this.#pending.delete(response.id);
		pending.resolve(response);
	}

	#fail(error: Error, closeCode?: number): void {
		const socket = this.#socket;
		this.#socket = null;
		this.#bridgeId = null;
		this.#connected = false;
		this.#ready?.reject(error);
		this.#ready = null;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		if (!socket) return;
		detachSocket(socket);
		try {
			socket.close(closeCode ?? 1000);
		} catch {
			// The socket is already closed.
		}
	}
}

function validateTimeout(value: number): number {
	if (!Number.isInteger(value) || value < 0) {
		throw new IdaBridgeConnectionError("IDA bridge timeout must be a non-negative integer");
	}
	return value;
}

function connectionError(url: string, cause?: unknown): IdaBridgeConnectionError {
	const suffix = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
	return new IdaBridgeConnectionError(
		`Unable to connect to IDA bridge at ${url}${suffix}. Start ida-bridge and connect a headless idalib runner; only idalib targets are supported.`,
	);
}

function abortReason(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new IdaBridgeConnectionError("IDA bridge request aborted");
}

async function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		onAbort();
		throw abortReason(signal);
	}
	const aborted = Promise.withResolvers<never>();
	const handleAbort = () => {
		onAbort();
		aborted.reject(abortReason(signal));
	};
	signal.addEventListener("abort", handleAbort, { once: true });
	try {
		return await Promise.race([promise, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", handleAbort);
	}
}

function parseWireMessage(data: unknown): WireEnvelope {
	if (typeof data !== "string") throw new IdaBridgeProtocolError("IDA bridge sent a non-text WebSocket frame");
	if (Buffer.byteLength(data, "utf8") > DEFAULT_MAX_MESSAGE_BYTES) {
		throw new IdaBridgeProtocolError("IDA bridge message exceeded the 64 MiB protocol limit");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		throw new IdaBridgeProtocolError("IDA bridge sent invalid JSON");
	}
	const message = wireEnvelopeSchema.assert(parsed);
	if (message.v !== PROTOCOL_VERSION) {
		throw new IdaBridgeProtocolError(`Unsupported IDA bridge protocol version: ${message.v}`);
	}
	return message;
}

function validateHelloAck(message: WireEnvelope, clientId: string): string {
	const ack = helloAckSchema.assert(message);
	if (ack.client_id !== clientId) throw new IdaBridgeProtocolError("IDA bridge handshake client id mismatch");
	return ack.bridge_id;
}

function parseBridgeProtocolError(message: WireEnvelope): IdaBridgeProtocolError {
	const error = protocolErrorSchema.assert(message);
	return new IdaBridgeProtocolError(
		`IDA bridge protocol error: ${error.code}: ${error.message}`,
		error.code,
		error.trace ?? undefined,
	);
}

function validateResponse(message: WireEnvelope): IdaResponse {
	if (message.type === "list_response") {
		const response = listResponseSchema.assert(message);
		const base = normalizeResponseBase(response);
		if (response.ok && response.clients == null) {
			throw new IdaBridgeProtocolError("list_response success is missing clients");
		}
		if (!response.ok && response.clients != null) {
			throw new IdaBridgeProtocolError("list_response failure must not contain clients");
		}
		return {
			...base,
			type: "list_response",
			kind: response.kind,
			clients: response.clients?.map(normalizeClientInfo),
		};
	}
	if (message.type === "exec_response") {
		const response = execResponseSchema.assert(message);
		const base = normalizeResponseBase(response);
		if (!response.ok && response.result != null) {
			throw new IdaBridgeProtocolError("exec_response failure must not contain a result");
		}
		if (response.ok && response.traceback != null) {
			throw new IdaBridgeProtocolError("exec_response success must not contain traceback");
		}
		return {
			...base,
			type: "exec_response",
			result: response.result,
			stdout: response.stdout ?? undefined,
			stderr: response.stderr ?? undefined,
			traceback: response.traceback ?? undefined,
		};
	}
	if (message.type === "reset_response") {
		const response = resetResponseSchema.assert(message);
		return { ...normalizeResponseBase(response), type: "reset_response" };
	}
	if (message.type === "quit_response") {
		const response = quitResponseSchema.assert(message);
		return { ...normalizeResponseBase(response), type: "quit_response" };
	}
	throw new IdaBridgeProtocolError(`Unsupported IDA bridge response type: ${message.type}`);
}

function normalizeResponseBase(response: RoutedResponseWire): RoutedResponse {
	requireUuidV4(response.id, `${response.type}.id`);
	if (response.ok && (response.code != null || response.message != null || response.trace != null)) {
		throw new IdaBridgeProtocolError(`${response.type} success response contains error fields`);
	}
	if (!response.ok && response.code == null) {
		throw new IdaBridgeProtocolError(`${response.type} failure response is missing code`);
	}
	return {
		v: response.v,
		type: response.type,
		id: response.id,
		src: response.src,
		dst: response.dst,
		ok: response.ok,
		code: response.code ?? undefined,
		message: response.message ?? undefined,
		trace: response.trace ?? undefined,
	};
}

function normalizeClientInfo(client: ClientInfoWire): IdaBridgeClientInfo {
	return {
		clientId: client.client_id,
		role: client.role,
		meta: client.meta,
		sessionId: client.session_id ?? undefined,
	};
}

function assertOk(response: IdaResponse): void {
	if (!response.ok) throw new IdaBridgeRequestError(response);
}

function requireUuidV4(id: string, label: string): void {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
		throw new IdaBridgeProtocolError(`${label} must be a canonical UUIDv4`);
	}
}

function stringifyUnknown(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function detachSocket(socket: WebSocket): void {
	socket.onopen = null;
	socket.onmessage = null;
	socket.onerror = null;
	socket.onclose = null;
}
