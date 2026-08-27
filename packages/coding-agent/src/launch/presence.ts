import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, isEnoent, logger, postmortem } from "@oh-my-soup/pi-utils";
import { daemonRuntimeDir } from "./paths";

const CLIENTS_DIR = "clients";
const BROKER_PID_FILE = "broker.pid";
/** Container holding per-project daemon scopes (`<state>/run/daemons`). */
const DAEMONS_DIR = "daemons";
/** 16-hex wyhash key produced for each project daemon scope. */
const DAEMON_SCOPE_KEY = /^[0-9a-f]{16}$/;
/**
 * Grace before a dead daemon runtime becomes prune-eligible. This protects a
 * scope whose owning process is still between creating the runtime and
 * registering its broker or client presence.
 */
const DAEMON_RUNTIME_STALE_GRACE_MS = 5 * 60_000;

/** Handle keeping one oms process registered in a project daemon scope. */
export interface DaemonProjectPresence {
	close(): Promise<void>;
}

async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch {
		// Network/DFS/virtual drives throw EPERM/EINVAL/UNKNOWN; the resolved
		// path is always a usable scope identity.
		return resolved;
	}
}

/** Register this oms process so project daemons survive while it remains alive. */
export async function registerDaemonProjectPresence(
	projectDir: string,
	runtimeOverride?: string,
): Promise<DaemonProjectPresence> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeDir = runtimeOverride ?? daemonRuntimeDir(canonical);
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	await fs.mkdir(clientsDir, { recursive: true, mode: 0o700 });
	const id = `${process.pid}-${crypto.randomUUID()}`;
	const presencePath = path.join(clientsDir, `${id}.json`);
	await Bun.write(presencePath, JSON.stringify({ pid: process.pid, id, projectDir: canonical }));
	await fs.chmod(presencePath, 0o600);
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		cancelCleanup();
		await fs.rm(presencePath, { force: true });
	};
	const cancelCleanup = postmortem.register(`daemon-presence:${id}`, () => close());
	return { close };
}

/** Return whether a registered oms process in this runtime directory is still alive. */
export async function hasLiveDaemonProjectPresence(runtimeDir: string): Promise<boolean> {
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	let entries: string[];
	try {
		entries = await fs.readdir(clientsDir);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	let live = false;
	for (const entry of entries) {
		const presencePath = path.join(clientsDir, entry);
		try {
			const decoded: unknown = await Bun.file(presencePath).json();
			if (
				typeof decoded !== "object" ||
				decoded === null ||
				!("pid" in decoded) ||
				typeof decoded.pid !== "number"
			) {
				await fs.rm(presencePath, { force: true });
				continue;
			}
			try {
				process.kill(decoded.pid, 0);
				live = true;
			} catch (error) {
				// EPERM: the process exists but is inaccessible (e.g. an elevated
				// oms on Windows) — it is alive, not stale.
				if (hasFsCode(error, "EPERM")) {
					live = true;
				} else {
					await fs.rm(presencePath, { force: true });
				}
			}
		} catch (error) {
			if (!isEnoent(error)) await fs.rm(presencePath, { force: true });
		}
	}
	return live;
}

/** Whether a runtime directory's recorded broker PID is still alive. */
async function hasLiveDaemonBroker(runtimeDir: string): Promise<boolean> {
	let decoded: unknown;
	try {
		decoded = await Bun.file(path.join(runtimeDir, BROKER_PID_FILE)).json();
	} catch {
		return false;
	}
	if (typeof decoded !== "object" || decoded === null || !("pid" in decoded) || typeof decoded.pid !== "number") {
		return false;
	}
	try {
		process.kill(decoded.pid, 0);
		return true;
	} catch (error) {
		// An inaccessible process still exists, notably for elevated brokers on
		// Windows. Preserve its runtime just as client presence does above.
		return hasFsCode(error, "EPERM");
	}
}

/**
 * Reclaim dead per-project daemon runtime directories.
 *
 * The sweep is deliberately confined to a directory literally named
 * `daemons`, and only 16-hex scope names are candidates. A relocated runtime
 * therefore cannot turn cleanup into recursive deletion of unrelated siblings.
 * The current scope, live brokers, live clients, and fresh scopes are retained.
 */
export async function pruneDeadDaemonRuntimeDirs(currentRuntimeDir: string): Promise<void> {
	const root = path.dirname(currentRuntimeDir);
	if (path.basename(root) !== DAEMONS_DIR) return;
	const current = path.resolve(currentRuntimeDir);
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to scan daemon runtime root for pruning", {
				root,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return;
	}

	const now = Date.now();
	for (const entry of entries) {
		if (!entry.isDirectory() || !DAEMON_SCOPE_KEY.test(entry.name)) continue;
		const runtimeDir = path.join(root, entry.name);
		if (path.resolve(runtimeDir) === current) continue;
		try {
			const stat = await fs.stat(runtimeDir);
			if (now - stat.mtimeMs < DAEMON_RUNTIME_STALE_GRACE_MS) continue;
			if (await hasLiveDaemonBroker(runtimeDir)) continue;
			if (await hasLiveDaemonProjectPresence(runtimeDir)) continue;
			await fs.rm(runtimeDir, { recursive: true, force: true });
		} catch (error) {
			if (isEnoent(error)) continue;
			logger.warn("Failed to prune dead daemon runtime dir", {
				dir: runtimeDir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
