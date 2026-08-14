import { logger, untilAborted, withTimeout } from "@oh-my-soup/pi-utils";
import type { Browser, Page } from "puppeteer-core";
import { ToolAbortError, throwIfAborted } from "../tool-errors";
import { adoptInitialPage, launchCamoufoxBrowser, loadPuppeteer } from "./launch";

const SEARCH_BROWSER_CLOSE_TIMEOUT_MS = 5_000;

interface SearchBrowserSessionEntry {
	readonly id: string;
	readonly lifetime: AbortController;
	browser?: Browser;
	page?: Page;
	tail: Promise<void>;
	retainers: number;
	operations: number;
	deliveries: number;
	retired: boolean;
	retirePromise?: Promise<void>;
}

export interface SearchBrowserRunContext {
	page: Page;
	/** True only when this operation launched the browser and adopted its initial page. */
	fresh: boolean;
	/** Caller cancellation combined with the shared browser session's lifetime. */
	signal: AbortSignal;
}

const searchBrowserSessions = new Map<string, SearchBrowserSessionEntry>();

function createEntry(id: string): SearchBrowserSessionEntry {
	const entry: SearchBrowserSessionEntry = {
		id,
		lifetime: new AbortController(),
		tail: Promise.resolve(),
		retainers: 0,
		operations: 0,
		deliveries: 0,
		retired: false,
	};
	searchBrowserSessions.set(id, entry);
	return entry;
}

function getOrCreateEntry(id: string): SearchBrowserSessionEntry {
	return searchBrowserSessions.get(id) ?? createEntry(id);
}

async function closeBrowser(browser: Browser, sessionId: string): Promise<void> {
	try {
		await withTimeout(
			browser.close(),
			SEARCH_BROWSER_CLOSE_TIMEOUT_MS,
			`Timed out closing search browser session ${sessionId}`,
		);
	} catch (error) {
		// `browser.close()` can lose its protocol socket during process teardown.
		// A direct child kill is the last-resort reap; the entry is discarded either way.
		try {
			browser.process()?.kill();
		} catch {}
		logger.debug("Failed to close search browser session cleanly", {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function closeEntryBrowser(entry: SearchBrowserSessionEntry): Promise<void> {
	const browser = entry.browser;
	entry.browser = undefined;
	entry.page = undefined;
	if (browser) await closeBrowser(browser, entry.id);
}

function isReusable(entry: SearchBrowserSessionEntry): entry is SearchBrowserSessionEntry & {
	browser: Browser;
	page: Page;
} {
	if (!entry.browser || !entry.page || entry.browser.connected === false) return false;
	try {
		return !entry.page.isClosed();
	} catch {
		return false;
	}
}

async function acquirePage(
	entry: SearchBrowserSessionEntry,
	signal: AbortSignal,
): Promise<{ page: Page; fresh: boolean }> {
	if (isReusable(entry)) return { page: entry.page, fresh: false };
	await closeEntryBrowser(entry);
	throwIfAborted(signal);

	const puppeteer = await untilAborted(signal, () => loadPuppeteer());
	const launch = launchCamoufoxBrowser(puppeteer, { headless: true });
	let browser: Browser | undefined;
	let claimed = false;

	// `untilAborted` cannot cancel Puppeteer's launch. Reap a browser that arrives
	// after cancellation before the normal continuation can claim it.
	void launch.then(
		async lateBrowser => {
			if (!claimed && (signal.aborted || entry.retired)) await closeBrowser(lateBrowser, entry.id);
		},
		() => undefined,
	);

	try {
		browser = await untilAborted(signal, () => launch);
		claimed = true;
		throwIfAborted(signal);
		const page = await untilAborted(signal, () => adoptInitialPage(browser!));
		throwIfAborted(signal);
		entry.browser = browser;
		entry.page = page;
		return { page, fresh: true };
	} catch (error) {
		if (browser) await closeBrowser(browser, entry.id);
		throw error;
	}
}

function retireEntry(entry: SearchBrowserSessionEntry): Promise<void> {
	if (entry.retirePromise) return entry.retirePromise;
	entry.retired = true;
	if (searchBrowserSessions.get(entry.id) === entry) searchBrowserSessions.delete(entry.id);
	entry.lifetime.abort(new ToolAbortError("Search browser session ended"));
	const tail = entry.tail;
	entry.retirePromise = (async () => {
		await tail.catch(() => undefined);
		await closeEntryBrowser(entry);
	})();
	return entry.retirePromise;
}

/**
 * Keep a logical search-browser session alive. Every AgentSession holds one
 * lease; parent and child agents retain the same id, so the browser survives
 * until the last related session is disposed.
 */
export function retainSearchBrowserSession(sessionId: string): () => Promise<void> {
	const entry = getOrCreateEntry(sessionId);
	entry.retainers++;
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		entry.retainers = Math.max(0, entry.retainers - 1);
		if (entry.retainers === 0) await retireEntry(entry);
	};
}

/**
 * Serialize work onto the single Camoufox page owned by `sessionId`.
 * A failed or aborted operation discards that browser; the next operation
 * relaunches it with a fresh Camoufox fingerprint.
 */
export function runInSearchBrowserSession<T>(
	sessionId: string,
	signal: AbortSignal,
	operation: (context: SearchBrowserRunContext) => Promise<T>,
): Promise<T> {
	const entry = getOrCreateEntry(sessionId);
	entry.operations++;
	entry.deliveries++;
	const retireUnretainedIfIdle = (): void => {
		if (entry.retainers === 0 && entry.operations === 0 && entry.deliveries === 0) void retireEntry(entry);
	};
	const runSignal = AbortSignal.any([signal, entry.lifetime.signal]);
	const previous = entry.tail;
	const run = previous.then(async () => {
		throwIfAborted(runSignal);
		const { page, fresh } = await acquirePage(entry, runSignal);
		throwIfAborted(runSignal);
		try {
			return await untilAborted(runSignal, () => operation({ page, fresh, signal: runSignal }));
		} catch (error) {
			await closeEntryBrowser(entry);
			throw error;
		}
	});
	const tracked = run.finally(() => {
		entry.operations = Math.max(0, entry.operations - 1);
		retireUnretainedIfIdle();
	});
	entry.tail = tracked.then(
		() => undefined,
		() => undefined,
	);
	return untilAborted(runSignal, tracked).finally(() => {
		entry.deliveries = Math.max(0, entry.deliveries - 1);
		retireUnretainedIfIdle();
	});
}
