import * as path from "node:path";
import { isCompiledBinary, logger, Snowflake, withTimeout, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { Browser } from "puppeteer-core";
import { ToolAbortError, ToolError } from "../tool-errors";
import { findFreeCdpPort, findReusableCdp, gracefulKillTreeOnce, killExistingByPath, waitForCdp } from "./attach";
import type { CmuxKind } from "./cmux/rpc";
import { CmuxSocketClient } from "./cmux/socket-client";
import { BROWSER_PROTOCOL_TIMEOUT_MS, loadPuppeteer } from "./launch";
import { ensureRelayDaemon, isLoopbackRelayUrl } from "./relay/daemon";
import type { RelayKind } from "./relay/kind";

/**
 * Headless tabs run their own Camoufox browser process inside the tab worker
 * (WebDriver BiDi has no shareable server endpoint), so the headless handle is
 * virtual: the registry tracks identity + the engine pid for teardown, while
 * the live `Browser` object never leaves the worker. Attach kinds keep a real
 * host-side CDP connection.
 */
export type HeadlessBrowserKind = { kind: "headless"; headless: boolean };
export type PuppeteerBrowserKind =
	| { kind: "spawned"; path: string }
	| { kind: "connected"; cdpUrl: string }
	| RelayKind;

export type BrowserKind = HeadlessBrowserKind | PuppeteerBrowserKind | CmuxKind;

export type BrowserKindTag = BrowserKind["kind"];

/**
 * Upper bound on process teardown for headless Camoufox. The worker normally
 * closes its own browser; the registry kill is the safety net for a wedged
 * worker, and a wedged engine would otherwise hang cleanup forever (cf. the
 * old Chromium variant, issue #5260).
 */
const HEADLESS_CLOSE_TIMEOUT_MS = 5_000;
/**
 * How long a relay open waits for the extension handshake (503 → 200). A
 * reaped extension service worker is revived by its 30s keepalive alarm, so
 * the wait must cover one full alarm period plus the dial.
 */
const RELAY_EXTENSION_WAIT_MS = 35_000;

interface BrowserHandleCommon {
	key: string;
	kind: BrowserKind;
	refCount: number;
}

export interface HeadlessBrowserHandle extends BrowserHandleCommon {
	kind: HeadlessBrowserKind;
	/** Engine pid, reported by the tab worker once the browser is up. */
	pid?: number;
}

export interface PuppeteerBrowserHandle extends BrowserHandleCommon {
	kind: PuppeteerBrowserKind;
	browser: Browser;
	cdpUrl?: string;
	pid?: number;
	subprocess?: Subprocess;
}

export interface CmuxBrowserHandle extends BrowserHandleCommon {
	kind: CmuxKind;
	client: CmuxSocketClient;
	surface?: string;
}

export type BrowserHandle = HeadlessBrowserHandle | PuppeteerBrowserHandle | CmuxBrowserHandle;

/** Controls bounded browser-handle teardown and identifies the owning resource in timeout diagnostics. */
export interface ReleaseBrowserOptions {
	kill: boolean;
	timeoutMs?: number;
	resource?: string;
}

const browsers = new Map<string, BrowserHandle>();

function browserKey(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			// Headless browsers are per-tab: every acquisition is a fresh engine
			// process (and a fresh Camoufox fingerprint), so the key must never
			// collide with another tab's handle.
			return `headless:${kind.headless ? "1" : "0"}:${Snowflake.next()}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.socketPath}`;
	}
}

export interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	appArgs?: string[];
	signal?: AbortSignal;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	const key = browserKey(kind);
	const existing = browsers.get(key);
	if (existing) {
		if ("client" in existing) return existing;
		if (!("browser" in existing)) {
			// Headless virtual handles are per-tab and never shared; a stale one
			// under a colliding key is dropped, never reused.
			browsers.delete(key);
		} else if (existing.browser.connected) {
			return existing;
		} else {
			browsers.delete(key);
			await disposeBrowserHandle(existing, { kill: false });
		}
	}
	// Short-circuit before launching: the tool wrapper's `untilAborted` only
	// rejects its outer promise on abort; without this check `openBrowserHandle`
	// would still fire and its result would land in `browsers` below.
	if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");

	const handle = await openBrowserHandle(kind, opts, key);
	// The launch may resolve AFTER the caller has already aborted (the outer
	// `untilAborted` rejects immediately on abort but does not cancel the
	// inner promise). Without this branch the completed handle sits in
	// `browsers` at refCount:0 forever — no tab ever takes a hold,
	// `releaseBrowser` never fires, and `releaseAllTabs` walks `tabs`, not
	// `browsers`, so the orphaned app process survives to process exit.
	// (Issue #3963.)
	if (opts.signal?.aborted) {
		await disposeBrowserHandle(handle, { kill: kind.kind === "spawned" }).catch(err => {
			logger.debug("Failed to dispose orphan browser after abort", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
		throw new ToolAbortError("Browser open aborted");
	}
	browsers.set(key, handle);
	return handle;
}

export function normalizeConnectedCdpUrl(rawCdpUrl: string): string {
	const cdpUrl = rawCdpUrl.replace(/\/+$/, "");
	if (/^wss?:\/\//i.test(cdpUrl)) {
		throw new ToolError(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint (for example http://127.0.0.1:9222), not a ws:// browser websocket URL.",
		);
	}
	return cdpUrl;
}

async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions, key: string): Promise<BrowserHandle> {
	if (kind.kind === "cmux") {
		const client = new CmuxSocketClient({ socketPath: kind.socketPath, password: kind.password });
		await client.connect();
		return {
			key,
			kind,
			client,
			surface: kind.surface,
			refCount: 0,
		};
	}
	if (kind.kind === "headless") {
		// The Camoufox engine is launched by the tab worker during init; the
		// registry handle starts pid-less and is stamped from the worker's
		// ready info by the supervisor.
		return {
			key,
			kind,
			refCount: 0,
		};
	}
	if (kind.kind === "connected") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		await waitForCdp(cdpUrl, 5_000, opts.signal);
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key,
			kind,
			browser,
			cdpUrl,
			refCount: 0,
		};
	}
	if (kind.kind === "relay") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		// Loopback relays are owned by a machine-global broker and auto-started
		// on demand (the extension dials in on its own). Hosts without a CLI
		// worker entry (bun test, SDK embedding) never spawn brokers. Remote
		// relay URLs must already be serving.
		let autoStarted = false;
		if (isLoopbackRelayUrl(cdpUrl) && (isCompiledBinary() || workerHostEntry() !== null)) {
			autoStarted = await ensureRelayDaemon({ cdpUrl, signal: opts.signal });
		}
		// The relay answers /json/version with 503 until its extension dials in.
		// A freshly revived extension service worker can take up to ~30s (its
		// keepalive alarm) to reconnect, so give the handshake that long.
		try {
			await waitForCdp(cdpUrl, RELAY_EXTENSION_WAIT_MS, opts.signal);
		} catch (err) {
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(
				autoStarted
					? `omp browser relay is serving at ${cdpUrl} but its extension never connected. Install it with \`omp browser-relay install\` and check the toolbar badge shows "on".`
					: `omp browser relay is not reachable at ${cdpUrl}. Start it with \`omp browser-relay\` (or check the endpoint), and make sure the OMP Browser Relay extension is loaded in Chrome.`,
			);
		}
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
		key,
			kind,
			browser,
			cdpUrl,
			refCount: 0,
		};
	}

	const exe = kind.path;
	if (!path.isAbsolute(exe)) {
		throw new ToolError(
			`app.path must be absolute (got ${JSON.stringify(exe)}). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.`,
		);
	}
	const reused = await findReusableCdp(exe, opts.signal);
	let cdpUrl: string;
	let pid: number;
	let subprocess: Subprocess | undefined;
	if (reused) {
		logger.debug("Reusing existing CDP endpoint for attach", { exe, pid: reused.pid, cdpUrl: reused.cdpUrl });
		cdpUrl = reused.cdpUrl;
		pid = reused.pid;
	} else {
		const killed = await killExistingByPath(exe, opts.signal);
		if (killed > 0) logger.debug("Killed existing instances before attach", { exe, killed });
		const port = await findFreeCdpPort();
		const launchArgs = [...(opts.appArgs ?? []), `--remote-debugging-port=${port}`];
		const child = Bun.spawn([exe, ...launchArgs], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		subprocess = child;
		pid = child.pid;
		cdpUrl = `http://127.0.0.1:${port}`;
		try {
			await waitForCdp(cdpUrl, 30_000, opts.signal);
		} catch (err) {
			await gracefulKillTreeOnce(child.pid).catch(() => undefined);
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(`Failed to attach to ${path.basename(exe)} on ${cdpUrl}: ${(err as Error).message}`);
		}
	}

	const puppeteer = await loadPuppeteer();
	let browser: Browser;
	try {
		browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
	} catch (err) {
		if (subprocess) await gracefulKillTreeOnce(subprocess.pid);
		throw new ToolError(`Connected to ${cdpUrl} but puppeteer.connect failed: ${(err as Error).message}`);
	}
	return {
		key,
		kind,
		browser,
		cdpUrl,
		pid,
		subprocess,
		refCount: 0,
	};
}

export function holdBrowser(handle: BrowserHandle): void {
	handle.refCount++;
}

export async function releaseBrowser(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	handle.refCount = Math.max(0, handle.refCount - 1);
	if (handle.refCount === 0) {
		// Only evict if the registry still points at THIS handle. After a disconnect,
		// `acquireBrowser` may have already replaced the entry with a fresh live handle
		// under the same key; deleting blindly would orphan that new browser.
		if (browsers.get(handle.key) === handle) browsers.delete(handle.key);
		await disposeBrowserHandle(handle, opts);
	}
}

async function disposeBrowserHandle(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	if ("client" in handle) {
		handle.client.close();
		return;
	}
	if (!("browser" in handle)) {
		// Headless (virtual) handle: the worker owns the live browser and closes
		// it on tab close; this kill is the safety net for a wedged or
		// force-killed worker that left the engine running. Headless handles are
		// single-owner, so the kill is unconditional (opts.kill governs spawned
		// apps only).
		if (handle.pid !== undefined) {
			try {
				await withTimeout(
					gracefulKillTreeOnce(handle.pid),
					HEADLESS_CLOSE_TIMEOUT_MS,
					"Timed out killing headless Camoufox engine",
				);
			} catch (err) {
				logger.debug("Failed to kill headless Camoufox engine", { error: (err as Error).message });
			}
		}
		return;
	}
	// Connected and relay browsers belong to the user: drop our CDP link, never kill.
	if (handle.kind.kind === "connected" || handle.kind.kind === "relay") {
		if (handle.browser.connected) {
			try {
				handle.browser.disconnect();
			} catch (err) {
				logger.debug("Failed to disconnect from remote browser", { error: (err as Error).message });
			}
		}
		return;
	}
	if (handle.browser.connected) {
		try {
			handle.browser.disconnect();
		} catch (err) {
			logger.debug("Failed to disconnect from spawned browser", { error: (err as Error).message });
		}
	}
	if (opts.kill && handle.pid !== undefined) await gracefulKillTreeOnce(handle.pid);
}

/** Test-only accessor for the module-global browsers map. */
export function getBrowsersMapForTest(): ReadonlyMap<string, BrowserHandle> {
	return browsers;
}
