import { afterEach, describe, expect, it, vi } from "bun:test";
import { OAuthCallbackFlow } from "@oh-my-soup/pi-ai/registry/oauth/callback-server";
import type { OAuthCredentials } from "@oh-my-soup/pi-ai/registry/oauth/types";

/**
 * Callback flow that records what `login()` advertised, so a test can assert on
 * the redirect URI and drive the callback itself.
 */
class TestCallbackFlow extends OAuthCallbackFlow {
	lastRedirectUri?: string;
	lastState?: string;

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		this.lastRedirectUri = redirectUri;
		this.lastState = state;
		return { url: `${redirectUri}?started=1` };
	}

	async exchangeToken(code: string, _state: string, _redirectUri: string): Promise<OAuthCredentials> {
		return { access: `access-${code}`, refresh: "refresh", expires: Date.now() + 60_000 };
	}
}

/** Whether this host can bind the IPv6 loopback at all. */
const ipv6Loopback = (() => {
	try {
		Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("probe") }).stop(true);
		return true;
	} catch {
		return false;
	}
})();

/**
 * Bind a squatter on `hostname` and return the port it took. `::` reproduces a
 * dev server (`next dev` binds the IPv6 wildcard); `::1` reproduces a process
 * holding that exact loopback address. The squatter answers 500 so a response
 * from it is unmistakable in an assertion.
 */
function occupy(hostname: string): { port: number; release: () => void } {
	const server = Bun.serve({ hostname, port: 0, fetch: () => new Response("squatter", { status: 500 }) });
	const port = server.port;
	if (typeof port !== "number") {
		server.stop(true);
		throw new Error("Bun.serve({ port: 0 }) did not assign a numeric port");
	}
	return { port, release: () => server.stop(true) };
}

/** Claim and immediately release a port, so a test can pin a known-free one. */
function freeLoopbackPort(): number {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
	const port = probe.port;
	probe.stop(true);
	if (typeof port !== "number") {
		throw new Error("Bun.serve({ port: 0 }) did not assign a numeric port");
	}
	return port;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OAuthCallbackFlow loopback address families", () => {
	it.skipIf(!ipv6Loopback || process.platform === "win32")(
		"takes localhost traffic back from a process on the IPv6 wildcard",
		async () => {
			// A dev server on `*:<port>`: the flow's IPv4 bind coexists with it, so
			// nothing looks wrong, yet `localhost` resolves to `::1` and the browser
			// would hand the authorization code to that dev server.
			const devServer = occupy("::");
			const advertised = Promise.withResolvers<void>();
			const cancel = new AbortController();
			const flow = new TestCallbackFlow(
				{ onAuth: () => advertised.resolve(), signal: cancel.signal },
				{ preferredPort: devServer.port },
			);

			const login = flow.login();
			void login.catch(() => undefined);
			try {
				await advertised.promise;
				// A coexisting wildcard bind is not a conflict, so the preferred port is
				// kept rather than abandoned.
				expect(flow.lastRedirectUri).toBe(`http://localhost:${devServer.port}/callback`);

				// The kernel prefers the most specific bind, so our `::1` listener now
				// answers `localhost` traffic. A 500 body of "squatter" here would mean
				// the dev server received the authorization code instead.
				const stray = await fetch(`http://[::1]:${devServer.port}/not-a-callback`);
				expect(stray.status).toBe(404);
				expect(await stray.text()).toBe("Not Found");

				const response = await fetch(`http://[::1]:${devServer.port}/callback?code=v6code&state=${flow.lastState}`);
				expect(response.status).toBe(200);
				await expect(login).resolves.toMatchObject({ access: "access-v6code" });
			} finally {
				cancel.abort("test cleanup");
				devServer.release();
			}
		},
	);

	it.skipIf(!ipv6Loopback)("falls back when the IPv6 loopback address itself is taken", async () => {
		const squatter = occupy("::1");
		const progress: string[] = [];
		// Cancel as soon as the flow publishes its redirect URI: the port it
		// advertised is the whole assertion, and aborting on that signal keeps this
		// test off the wall clock.
		const cancel = new AbortController();
		const flow = new TestCallbackFlow(
			{
				onAuth: () => cancel.abort("advertised"),
				onProgress: msg => progress.push(msg),
				signal: cancel.signal,
			},
			{ preferredPort: squatter.port },
		);

		try {
			await expect(flow.login()).rejects.toThrow();
			// `::1` cannot be shared, so this port cannot serve both families and the
			// flow must move rather than advertise a half-reachable URI.
			expect(flow.lastRedirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
			expect(flow.lastRedirectUri).not.toContain(`:${squatter.port}/`);
			expect(progress.some(msg => msg.startsWith(`Preferred port ${squatter.port} unavailable`))).toBe(true);
		} finally {
			squatter.release();
		}
	});

	it("keeps the preferred port when the host cannot bind ::1", async () => {
		const realServe = Bun.serve.bind(Bun) as typeof Bun.serve;
		vi.spyOn(Bun, "serve").mockImplementation(((options: { hostname?: string }) => {
			if (options.hostname === "::1") {
				throw Object.assign(new Error("address family not supported by protocol"), { code: "EAFNOSUPPORT" });
			}
			return realServe(options as Parameters<typeof Bun.serve>[0]);
		}) as typeof Bun.serve);

		const port = freeLoopbackPort();
		const progress: string[] = [];
		const cancel = new AbortController();
		const flow = new TestCallbackFlow(
			{
				onAuth: () => cancel.abort("advertised"),
				onProgress: msg => progress.push(msg),
				signal: cancel.signal,
			},
			{ preferredPort: port },
		);

		await expect(flow.login()).rejects.toThrow();
		// An unbindable `::1` is not a conflict: the IPv4 listener is the only
		// reachable endpoint on such a host, so the flow must not fall back.
		expect(flow.lastRedirectUri).toBe(`http://localhost:${port}/callback`);
		expect(progress.some(msg => msg.includes("unavailable"))).toBe(false);
	});
});
