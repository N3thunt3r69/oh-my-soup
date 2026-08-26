import { describe, expect, test } from "bun:test";
import {
	findFreeCdpPort,
	pickElectronTarget,
	probeCdpStatus,
	shouldPreserveConnectedBrowserFocus,
} from "@oh-my-soup/pi-coding-agent/tools/browser/attach";
import { normalizeConnectedCdpUrl } from "@oh-my-soup/pi-coding-agent/tools/browser/registry";
import type { Browser, Page, Target } from "puppeteer-core";

interface FakePageOptions {
	url: string;
	title: string;
	visible?: boolean;
}

function fakePage(options: FakePageOptions): Page {
	return {
		url: () => options.url,
		title: async () => options.title,
		evaluate: async () => options.visible === true,
	} as unknown as Page;
}

function fakeTarget(type: string, page: Page | null): Target {
	return {
		type: () => type,
		page: async () => page,
	} as unknown as Target;
}

describe("pickElectronTarget", () => {
	test("uses discovered CDP page targets when browser.pages is empty", async () => {
		const page = fakePage({ url: "https://www.google.com/", title: "Google" });
		let pagesCalled = false;
		const browser = {
			targets: () => [fakeTarget("browser", null), fakeTarget("page", page)],
			pages: async () => {
				pagesCalled = true;
				return [];
			},
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { matcher: "google" })).resolves.toBe(page);
		expect(pagesCalled).toBe(false);
	});

	test("falls back to browser.pages when discovered targets have no usable page", async () => {
		const page = fakePage({ url: "https://example.com/", title: "Example" });
		const browser = {
			targets: () => [fakeTarget("browser", null), fakeTarget("service_worker", null)],
			pages: async () => [page],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser)).resolves.toBe(page);
	});

	test("reports available pages when the matcher misses", async () => {
		const page = fakePage({ url: "https://example.com/", title: "Example" });
		const browser = {
			targets: () => [fakeTarget("page", page)],
			pages: async () => [],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { matcher: "missing" })).rejects.toThrow(
			'No page target matched "missing". Available pages:\n- Example  https://example.com/',
		);
	});

	test("prefers the foreground tab when asked to, without disturbing default order", async () => {
		const background = fakePage({ url: "https://example.com/", title: "Example" });
		const foreground = fakePage({ url: "https://example.org/", title: "Example Org", visible: true });
		const browser = {
			targets: () => [fakeTarget("page", background), fakeTarget("page", foreground)],
			pages: async () => [],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { preferVisible: true })).resolves.toBe(foreground);
		await expect(pickElectronTarget(browser)).resolves.toBe(background);
	});

	test("falls back to the first usable tab when no tab reports itself visible", async () => {
		const first = fakePage({ url: "https://example.com/", title: "Example" });
		const second = fakePage({ url: "https://example.org/", title: "Example Org" });
		const browser = {
			targets: () => [fakeTarget("page", first), fakeTarget("page", second)],
			pages: async () => [],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { preferVisible: true })).resolves.toBe(first);
	});

	test("preserves connected-browser focus only for automatic target selection", () => {
		expect(shouldPreserveConnectedBrowserFocus()).toBe(true);
		expect(shouldPreserveConnectedBrowserFocus("example.com")).toBe(false);
	});

	test("rejects websocket cdp_url values with an actionable diagnostic", () => {
		expect(() => normalizeConnectedCdpUrl("ws://127.0.0.1:9222/devtools/browser/id")).toThrow(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint",
		);
		expect(normalizeConnectedCdpUrl("http://127.0.0.1:9222/")).toBe("http://127.0.0.1:9222");
	});
});

// NOTE: upstream's two real-Chromium attach tests were dropped in the Camoufox
// port — they used a headless Chromium as the CDP endpoint under test, and the
// fork no longer ships or resolves one.

describe("probeCdpStatus", () => {
	// Regression for #8567: a local proxy (Clash, corporate) 502s internal
	// loopback addresses, so a bare fetch()/node:http probe misreports a healthy
	// CDP daemon as dead. The raw-TCP probe must ignore HTTP_PROXY entirely.
	test("returns the loopback status even when HTTP_PROXY 502s the request", async () => {
		const cdp = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
		const proxy = Bun.serve({ port: 0, fetch: () => new Response("Bad Gateway", { status: 502 }) });
		const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy };
		process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
		process.env.http_proxy = `http://127.0.0.1:${proxy.port}`;
		try {
			const status = await probeCdpStatus(`http://127.0.0.1:${cdp.port}/json/version`, { timeoutMs: 1500 });
			expect(status).toBe(200);
		} finally {
			// Bun's fetch never unlearns a deleted proxy var: `delete process.env.X`
			// (or assigning undefined) leaves the proxy active process-wide, silently
			// routing every later fetch in the suite to the stopped proxy port. Only
			// assignment flushes it, so write "" first, then restore the JS view.
			process.env.HTTP_PROXY = saved.HTTP_PROXY ?? "";
			process.env.http_proxy = saved.http_proxy ?? "";
			if (saved.HTTP_PROXY === undefined) delete process.env.HTTP_PROXY;
			if (saved.http_proxy === undefined) delete process.env.http_proxy;
			await cdp.stop(true);
			await proxy.stop(true);
		}
	});

	test("surfaces a non-2xx status from a live endpoint", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 503 }) });
		try {
			const status = await probeCdpStatus(`http://127.0.0.1:${server.port}/json/version`, { timeoutMs: 1500 });
			expect(status).toBe(503);
		} finally {
			await server.stop(true);
		}
	});

	test("returns null when the endpoint is unreachable", async () => {
		const port = await findFreeCdpPort();
		const status = await probeCdpStatus(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 500 });
		expect(status).toBeNull();
	});

	test("returns null when the request is already aborted", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
		try {
			const status = await probeCdpStatus(`http://127.0.0.1:${server.port}/json/version`, {
				timeoutMs: 1500,
				signal: AbortSignal.abort(),
			});
			expect(status).toBeNull();
		} finally {
			await server.stop(true);
		}
	});
});
