/**
 * Cross-process contract for the broker-owned LSP mux daemon.
 *
 * One mux daemon runs per project scope (launched through the same daemon
 * broker that owns the shared Chromium and `hub start` processes). It assigns
 * each concurrent OMS link its own language-server process, then retains idle
 * processes briefly for reuse by later links. The link speaks plain
 * Content-Length-framed LSP JSON-RPC after a one-request handshake
 * ({@link MUX_CONNECT_METHOD}); everything below is shared by the worker
 * entry (`server.ts`), the client connector (`daemon.ts`), and tests.
 */
import * as path from "node:path";

/** Hidden CLI selector used to re-enter the LSP mux worker. */
export const LSP_MUX_WORKER_ARG = "__oms_worker_lsp_mux";

/** Environment key carrying the socket endpoint the mux must listen on. */
export const LSP_MUX_SOCKET_ENV = "OMS_LSP_MUX_SOCKET";

/** Environment key carrying the canonical project directory the mux serves. */
export const LSP_MUX_PROJECT_DIR_ENV = "OMS_LSP_MUX_PROJECT_DIR";

/** Stable broker daemon name for the shared LSP mux. */
export const LSP_MUX_DAEMON_NAME = "oms.lsp.mux";

/** Broker readiness regex matched against the banner printed by the worker. */
export const LSP_MUX_READY_PATTERN = String.raw`oms lsp mux listening on \S+`;

/** Banner printed on stdout once the mux socket accepts connections. */
export function lspMuxReadyBanner(endpoint: string): string {
	return `oms lsp mux listening on ${endpoint}`;
}

/** Resolve the Unix socket or Windows named pipe for one project scope. */
export function lspMuxEndpoint(_projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		// Same keying scheme as daemonBrokerEndpoint: the runtime dir is
		// profile-scoped and case-folded per project, so the pipe name is too.
		const key = Bun.hash.wyhash(runtimeDir.toLowerCase()).toString(16).padStart(16, "0");
		return `\\\\.\\pipe\\oms-lsp-mux-${key}`;
	}
	return path.join(runtimeDir, "lsp-mux.sock");
}

// =============================================================================
// Mux-private JSON-RPC methods
// =============================================================================

/**
 * First (and only pre-LSP) request on a fresh connection: binds the link to
 * an idle server instance or spawns one. Params: {@link MuxConnectParams},
 * result: {@link MuxConnectResult}. After the response the link carries
 * ordinary LSP traffic for that server.
 */
export const MUX_CONNECT_METHOD = "oms/muxConnect";

/**
 * Liveness probe answered with {@link MUX_PING_RESULT} without binding the
 * link to a server. Used by the smoke probe and the ensure loop.
 */
export const MUX_PING_METHOD = "oms/muxPing";
export const MUX_PING_RESULT = "pong";

/**
 * Notification on a bound link: kill that link's server process. Sent by
 * `lsp reload` when the generic reload path decides the server is wedged —
 * a plain per-session `shutdown`/`exit` is intercepted by the mux so the
 * process can linger for reuse.
 */
export const MUX_RESTART_METHOD = "oms/muxRestartServer";

/** Handshake parameters identifying a reusable server process. */
export interface MuxConnectParams {
	/** Executable to spawn (the client's `resolvedCommand ?? command`). */
	command: string;
	/** Arguments passed verbatim to the executable. */
	args: string[];
	/** Workspace root the server runs in; part of the server identity key. */
	cwd: string;
	/** Extra environment overlaid on the mux daemon's own env for the spawn. */
	env?: Record<string, string>;
	/**
	 * Opaque digest of initialization options, settings, and language identity.
	 * The digest keeps configuration secrets out of the handshake and logs.
	 */
	configurationIdentity: string;
}

/** Handshake result. */
export interface MuxConnectResult {
	/** Hashed server identity key covering spawn inputs and initialization identity. */
	key: string;
	/** True when this handshake spawned the server process. */
	spawned: boolean;
	/** Pid of the server process assigned to this link. */
	pid?: number;
}

/**
 * Server identity key used by the mux registry.
 *
 * The registry may reuse an idle process only when every spawn input matches.
 * Environment entries are sorted so equivalent objects have one canonical
 * identity. The canonical identity is hashed because this key crosses the mux
 * handshake and appears in logs, while environment values may contain secrets.
 */
export function muxServerKey(params: MuxConnectParams): string {
	const envEntries = Object.entries(params.env ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
	const identity = JSON.stringify([params.command, params.args, params.cwd, envEntries, params.configurationIdentity]);
	return `sha256:${Bun.SHA256.hash(identity, "hex")}`;
}
