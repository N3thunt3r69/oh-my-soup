/// <reference path="./camoufox-assets.d.ts" />

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getCamoufoxDir, getPuppeteerDir, logger } from "@oh-my-soup/pi-utils";
import camoufoxTerritoryInfoPath from "camoufox-js/dist/data-files/territoryInfo.xml" with { type: "file" };
import camoufoxWebglDataPath from "camoufox-js/dist/data-files/webgl_data.db" with { type: "file" };
import type { Browser, Page, default as Puppeteer } from "puppeteer-core";
import { ToolError } from "../tool-errors";

export const DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 };

/**
 * Per-protocol-message timeout applied to every puppeteer launch/connect. Set above
 * `TOOL_TIMEOUTS.browser.max` (30s) so the agent-side wall-clock is the canonical
 * limit; this constant only catches genuinely stuck protocol sockets (renderer wedged,
 * connection dropped, etc.).
 */
export const BROWSER_PROTOCOL_TIMEOUT_MS = 60_000;

/**
 * Lazy-import puppeteer from a safe CWD so cosmiconfig doesn't choke
 * on malformed package.json files in the user's project tree.
 *
 * Dynamic import is required because puppeteer-core probes the cwd at module
 * load time; we must `process.chdir` to a safe scratch dir before loading and
 * restore cwd afterwards. A static import would run at module-init time before
 * cwd is safe.
 */
let puppeteerModule: typeof Puppeteer | undefined;
let puppeteerModulePromise: Promise<typeof Puppeteer> | undefined;
export function loadPuppeteer(): Promise<typeof Puppeteer> {
	if (puppeteerModule) return Promise.resolve(puppeteerModule);
	if (puppeteerModulePromise) return puppeteerModulePromise;
	puppeteerModulePromise = (async () => {
		const prev = process.cwd();
		const safeDir = getPuppeteerDir();
		await Bun.write(path.join(safeDir, "package.json"), "{}");
		try {
			process.chdir(safeDir);
			puppeteerModule = (await import("puppeteer-core")).default;
			return puppeteerModule;
		} finally {
			process.chdir(prev);
		}
	})().catch(error => {
		puppeteerModulePromise = undefined;
		throw error;
	});
	return puppeteerModulePromise;
}

let puppeteerModuleWorker: typeof Puppeteer | undefined;
let puppeteerModuleWorkerPromise: Promise<typeof Puppeteer> | undefined;
export function loadPuppeteerInWorker(safeDir: string): Promise<typeof Puppeteer> {
	if (puppeteerModuleWorker) return Promise.resolve(puppeteerModuleWorker);
	if (puppeteerModuleWorkerPromise) return puppeteerModuleWorkerPromise;
	puppeteerModuleWorkerPromise = (async () => {
		const orig = process.cwd;
		Object.defineProperty(process, "cwd", { value: () => safeDir, configurable: true });
		try {
			puppeteerModuleWorker = (await import("puppeteer-core")).default;
			return puppeteerModuleWorker;
		} finally {
			Object.defineProperty(process, "cwd", { value: orig, configurable: true });
		}
	})().catch(error => {
		puppeteerModuleWorkerPromise = undefined;
		throw error;
	});
	return puppeteerModuleWorkerPromise;
}

// =====================================================================
// Camoufox engine
// =====================================================================

// camoufox-js resolves its engine at module load, so pin it to the oms cache
// before the first dynamic import.
process.env.CAMOUFOX_INSTALL_DIR ??= getCamoufoxDir();

interface CamoufoxAsset {
	sourcePath: string;
	cacheFileName: string;
	byteLength: number;
	sha256: string;
}

const CAMOUFOX_TERRITORY_INFO: CamoufoxAsset = {
	sourcePath: camoufoxTerritoryInfoPath,
	cacheFileName: "territoryInfo.8a14f0f5614bd6072ea6a67f267b9a1754c3fde09d05dc34c992adde4cf89f94.xml",
	byteLength: 154_377,
	sha256: "8a14f0f5614bd6072ea6a67f267b9a1754c3fde09d05dc34c992adde4cf89f94",
};

const CAMOUFOX_WEBGL_DATA: CamoufoxAsset = {
	sourcePath: camoufoxWebglDataPath,
	cacheFileName: "webgl_data.d293cabe7b546bf4ac3a2fb6c3cb6aee9891910659299d61fa2c88944d38c45d.db",
	byteLength: 266_240,
	sha256: "d293cabe7b546bf4ac3a2fb6c3cb6aee9891910659299d61fa2c88944d38c45d",
};

async function isCachedCamoufoxAsset(filePath: string, byteLength: number): Promise<boolean> {
	try {
		const stats = await fs.stat(filePath);
		return stats.isFile() && stats.size === byteLength;
	} catch {
		return false;
	}
}

async function materializeCamoufoxAsset(asset: CamoufoxAsset): Promise<string> {
	const cacheDir = path.join(process.env.CAMOUFOX_INSTALL_DIR ?? getCamoufoxDir(), "js-assets");
	const targetPath = path.join(cacheDir, asset.cacheFileName);
	if (await isCachedCamoufoxAsset(targetPath, asset.byteLength)) return targetPath;

	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await Bun.file(asset.sourcePath).arrayBuffer());
	} catch (error) {
		throw new ToolError(`Failed to read bundled Camoufox asset ${asset.cacheFileName}: ${(error as Error).message}`);
	}
	if (bytes.byteLength !== asset.byteLength || Bun.SHA256.hash(bytes, "hex") !== asset.sha256) {
		throw new ToolError(`Bundled Camoufox asset ${asset.cacheFileName} failed integrity validation`);
	}

	await fs.mkdir(cacheDir, { recursive: true });
	const stagingPath = `${targetPath}.${process.pid}.tmp`;
	try {
		await Bun.write(stagingPath, bytes);
		try {
			await fs.rename(stagingPath, targetPath);
		} catch {
			if (await isCachedCamoufoxAsset(targetPath, asset.byteLength)) return targetPath;
			await fs.rm(targetPath, { force: true });
			try {
				await fs.rename(stagingPath, targetPath);
			} catch (retryError) {
				if (!(await isCachedCamoufoxAsset(targetPath, asset.byteLength))) throw retryError;
			}
		}
		return targetPath;
	} catch (error) {
		throw new ToolError(`Failed to cache bundled Camoufox asset ${asset.cacheFileName}: ${(error as Error).message}`);
	} finally {
		await fs.rm(stagingPath, { force: true }).catch(() => undefined);
	}
}

let camoufoxAssetsPromise: Promise<void> | undefined;
async function ensureCamoufoxAssets(): Promise<void> {
	if (camoufoxAssetsPromise) return camoufoxAssetsPromise;
	camoufoxAssetsPromise = (async () => {
		const [territoryInfoPath, webglDataPath] = await Promise.all([
			process.env.CAMOUFOX_TERRITORY_INFO_PATH ?? materializeCamoufoxAsset(CAMOUFOX_TERRITORY_INFO),
			process.env.CAMOUFOX_WEBGL_DATA_PATH ?? materializeCamoufoxAsset(CAMOUFOX_WEBGL_DATA),
		]);
		process.env.CAMOUFOX_TERRITORY_INFO_PATH ??= territoryInfoPath;
		process.env.CAMOUFOX_WEBGL_DATA_PATH ??= webglDataPath;
	})().catch(error => {
		camoufoxAssetsPromise = undefined;
		throw error;
	});
	return camoufoxAssetsPromise;
}

/** Verify that bundled Camoufox datasets materialize as real, readable files. */
export async function smokeTestCamoufoxAssets(): Promise<void> {
	await ensureCamoufoxAssets();
	const territoryInfoPath = process.env.CAMOUFOX_TERRITORY_INFO_PATH;
	const webglDataPath = process.env.CAMOUFOX_WEBGL_DATA_PATH;
	if (!territoryInfoPath || !webglDataPath) throw new Error("Camoufox asset paths were not configured");

	const [territoryInfo, webglData] = await Promise.all([fs.readFile(territoryInfoPath), fs.readFile(webglDataPath)]);
	if (Bun.SHA256.hash(territoryInfo, "hex") !== CAMOUFOX_TERRITORY_INFO.sha256) {
		throw new Error("Camoufox territory dataset failed smoke-test integrity validation");
	}
	if (Bun.SHA256.hash(webglData, "hex") !== CAMOUFOX_WEBGL_DATA.sha256) {
		throw new Error("Camoufox WebGL dataset failed smoke-test integrity validation");
	}

	// Lazy because only the distribution smoke probe needs to open the materialized database directly.
	const { Database } = await import("bun:sqlite");
	const db = new Database(webglDataPath, { readonly: true });
	try {
		if (!db.query("SELECT 1 AS ok FROM webgl_fingerprints LIMIT 1").get()) {
			throw new Error("Camoufox WebGL dataset contains no fingerprints");
		}
	} finally {
		db.close();
	}
}

interface CamoufoxPkgman {
	camoufoxPath(downloadIfMissing?: boolean): unknown;
	CamoufoxFetcher: new () => { install(): Promise<void> };
}

let camoufoxEnginePromise: Promise<string> | undefined;
/**
 * Resolve the Camoufox engine executable, downloading it (~490 MB,
 * sha256-verified) on first use via camoufox-js's pkgman. Cached for the
 * process; a failed download resets the cache so the next attempt retries.
 *
 * Dynamic import is required: pkgman resolves CAMOUFOX_INSTALL_DIR at module
 * load time (pinned above), and a static import would also pull camoufox-js's
 * native dependencies (better-sqlite3, impit) into every CLI startup.
 */
export async function ensureCamoufoxEngine(): Promise<string> {
	if (camoufoxEnginePromise) return camoufoxEnginePromise;
	camoufoxEnginePromise = (async () => {
		const pkgman = (await import("camoufox-js/dist/pkgman.js")) as unknown as CamoufoxPkgman;
		try {
			return String(pkgman.camoufoxPath(false));
		} catch {
			logger.warn("Downloading Camoufox engine (first browser use)", {
				installDir: process.env.CAMOUFOX_INSTALL_DIR,
			});
			try {
				const fetcher = new pkgman.CamoufoxFetcher();
				await fetcher.install();
				return String(pkgman.camoufoxPath(false));
			} catch (err) {
				throw new ToolError(`Failed to install the Camoufox engine: ${(err as Error).message}`);
			}
		}
	})().catch(err => {
		camoufoxEnginePromise = undefined;
		throw err;
	});
	return camoufoxEnginePromise;
}

export interface CamoufoxLaunchSpec {
	executablePath: string;
	env: Record<string, string>;
	firefoxUserPrefs: Record<string, unknown>;
}

interface CamoufoxApi {
	launchOptions(options: { headless: boolean }): Promise<{
		executablePath: string;
		env: Record<string, string>;
		firefoxUserPrefs: Record<string, unknown>;
	}>;
}

let camoufoxApiPromise: Promise<CamoufoxApi> | undefined;
// See ensureCamoufoxEngine for why this is a dynamic import.
function loadCamoufox(): Promise<CamoufoxApi> {
	camoufoxApiPromise ??= import("camoufox-js") as unknown as Promise<CamoufoxApi>;
	return camoufoxApiPromise;
}

/**
 * Build a per-browser Camoufox launch spec: a fresh BrowserForge fingerprint
 * (drawn from the real-world device distribution), the matching Firefox prefs,
 * and the CAMOU_CONFIG_* environment chunks the engine reads at startup.
 */
export async function buildCamoufoxLaunchSpec(opts: { headless: boolean }): Promise<CamoufoxLaunchSpec> {
	await Promise.all([ensureCamoufoxAssets(), ensureCamoufoxEngine()]);
	const { launchOptions } = await loadCamoufox();
	const options = await launchOptions({ headless: opts.headless });
	return {
		executablePath: String(options.executablePath),
		env: options.env,
		firefoxUserPrefs: options.firefoxUserPrefs,
	};
}

/**
 * Launch a Camoufox browser over WebDriver BiDi. BiDi is websocket-based, which
 * works under Bun on every platform — Playwright's Juggler transport needs
 * child-process fd 3/4 pipes that Bun's node:child_process does not implement
 * (oven-sh/bun#4670).
 *
 * Quirk: `browsingContext.create` hangs on Camoufox, so `browser.newPage()` is
 * unusable — callers must adopt the initial tab via `adoptInitialPage()`.
 */
export async function launchCamoufoxBrowser(
	puppeteer: typeof Puppeteer,
	opts: { headless: boolean },
): Promise<Browser> {
	const spec = await buildCamoufoxLaunchSpec(opts);
	return await puppeteer.launch({
		browser: "firefox",
		executablePath: spec.executablePath,
		headless: opts.headless,
		extraPrefsFirefox: spec.firefoxUserPrefs,
		env: spec.env,
		// Never force a viewport: Camoufox pins the window to its spoofed screen
		// size, and a conflicting viewport request is itself a fingerprint tell.
		defaultViewport: null,
		protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
	});
}

/**
 * Adopt the initial tab of a freshly launched Camoufox browser. `newPage()`
 * hangs over BiDi on Camoufox (`browsingContext.create` never resolves), so the
 * initial `about:blank` tab is the only page a tab worker ever gets.
 */
export async function adoptInitialPage(browser: Browser): Promise<Page> {
	const pages = await browser.pages();
	const page = pages[0];
	if (!page) throw new ToolError("Camoufox launched without an initial page");
	return page;
}
