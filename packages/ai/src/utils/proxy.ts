import * as net from "node:net";
import * as tls from "node:tls";
import { AbortError } from "../error/abort";
import { StreamTimeoutError, ValidationError } from "../error/validation";
import type { FetchImpl } from "../types";

type BunProxyRequestInit = RequestInit & { proxy: string };

/**
 * Checks if a host is local or cloud metadata, which should always bypass the proxy
 * (e.g. localhost, 127/8, ::1, 169.254.169.254, metadata.google.internal).
 */
export function isLocalOrMetadataHost(host: string): boolean {
	const lowerHost = host.toLowerCase();

	// Hostnames: localhost and the cloud metadata service.
	if (lowerHost === "localhost" || lowerHost.endsWith(".localhost") || lowerHost === "metadata.google.internal") {
		return true;
	}

	// Strip IPv6 brackets before numeric checks.
	const ip = lowerHost.replace(/^\[|\]$/g, "");

	// IPv4 loopback (127/8), unspecified (0/8), RFC1918 private (10/8, 172.16/12,
	// 192.168/16) and link-local (169.254/16 — covers IMDS 169.254.169.254 and
	// ECS credentials 169.254.170.2). None are reachable through a remote egress
	// proxy, and credential/metadata probes must never leak to one.
	const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		if (a === 127 || a === 10 || a === 0) return true;
		if (a === 169 && b === 254) return true;
		if (a === 192 && b === 168) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		return false;
	}

	// IPv6 loopback (::1), unspecified (::), link-local (fe80::/10) and
	// unique-local (fc00::/7 — covers EC2 IPv6 IMDS fd00:ec2::254).
	if (ip === "::1" || ip === "::") return true;
	if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;
	if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;

	return false;
}

/**
 * Check if the url should bypass the proxy due to hard-coded localhost/metadata checks
 * or custom NO_PROXY/no_proxy environment variables rules.
 */
export function shouldBypassProxy(urlObj: URL): boolean {
	if (isLocalOrMetadataHost(urlObj.hostname)) {
		return true;
	}

	const noProxyVal = Bun.env.NO_PROXY || Bun.env.no_proxy;
	if (!noProxyVal) {
		return false;
	}

	const rules = noProxyVal
		.split(/[,\s]+/)
		.map(r => r.trim())
		.filter(Boolean);
	const targetHost = urlObj.hostname.toLowerCase();
	const targetPort = urlObj.port || (urlObj.protocol === "https:" || urlObj.protocol === "wss:" ? "443" : "80");

	for (const rule of rules) {
		if (rule === "*") {
			return true;
		}

		let ruleHost = rule.toLowerCase();
		let rulePort: string | undefined;

		if (ruleHost.includes("]:")) {
			const lastColon = ruleHost.lastIndexOf(":");
			rulePort = ruleHost.slice(lastColon + 1);
			ruleHost = ruleHost.slice(0, lastColon);
		} else if (!ruleHost.includes("]") && ruleHost.includes(":")) {
			const lastColon = ruleHost.lastIndexOf(":");
			rulePort = ruleHost.slice(lastColon + 1);
			ruleHost = ruleHost.slice(0, lastColon);
		}

		// Strip IPv6 brackets
		ruleHost = ruleHost.replace(/^\[|\]$/g, "");

		if (rulePort && rulePort !== targetPort) {
			continue;
		}

		// Match host part
		if (ruleHost.startsWith(".")) {
			const suffix = ruleHost;
			const cleanRule = ruleHost.slice(1);
			if (targetHost === cleanRule || targetHost.endsWith(suffix)) {
				return true;
			}
		} else {
			if (targetHost === ruleHost || targetHost.endsWith(`.${ruleHost}`)) {
				return true;
			}
		}
	}

	return false;
}

const proxyCache = new Map<string, string | undefined>();

/** Test seam: clears the provider proxy cache. */
export function __resetProxyCache(): void {
	proxyCache.clear();
}

/**
 * Normalizes provider id (e.g. github-copilot -> PI_PROXY_GITHUB_COPILOT) and looks it up.
 * If not found, falls back to PI_PROXY. Results are memoized because env values are static
 * for the lifetime of the process and this function is called for every outgoing request.
 */
export function getProxyForProvider(provider: string): string | undefined {
	if (proxyCache.has(provider)) {
		return proxyCache.get(provider);
	}

	const normalized = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	const envKey = `PI_PROXY_${normalized}`;
	const value = Bun.env[envKey] || Bun.env.PI_PROXY;
	proxyCache.set(provider, value);
	return value;
}

/** Resolves provider-specific and standard proxy variables for a target URL, honoring NO_PROXY. */
export function getProxyForUrl(provider: string, url: URL): string | undefined {
	if (shouldBypassProxy(url)) return undefined;
	const protocolProxy =
		url.protocol === "https:" || url.protocol === "wss:"
			? Bun.env.HTTPS_PROXY || Bun.env.https_proxy
			: Bun.env.HTTP_PROXY || Bun.env.http_proxy;
	return getProxyForProvider(provider) || protocolProxy || Bun.env.ALL_PROXY || Bun.env.all_proxy || undefined;
}

/**
 * Wraps `fetchImpl` so non-local requests tunnel through `proxyUrl`.
 * A caller-supplied proxy wins, which makes nested global and provider-specific
 * wrappers idempotent.
 */
function wrapFetchWithProxyUrl(fetchImpl: FetchImpl, proxyUrl: string | undefined): FetchImpl {
	if (!proxyUrl) return fetchImpl;

	const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		if ((init as { proxy?: unknown } | undefined)?.proxy) return fetchImpl(input, init);

		const urlStr = input instanceof Request ? input.url : input.toString();
		let urlObj: URL;
		try {
			urlObj = new URL(urlStr);
		} catch {
			return fetchImpl(input, init);
		}

		if (shouldBypassProxy(urlObj)) return fetchImpl(input, init);
		const proxyInit: BunProxyRequestInit = { ...(init ?? {}), proxy: proxyUrl };
		return fetchImpl(input, proxyInit);
	};

	if (fetchImpl.preconnect) wrapped.preconnect = fetchImpl.preconnect;
	return wrapped;
}

/** Wraps a fetch implementation with the provider's resolved proxy. */
export function wrapFetchForProxy(fetchImpl: FetchImpl, provider: string): FetchImpl {
	return wrapFetchWithProxyUrl(fetchImpl, getProxyForProvider(provider));
}

let globalProxyFetchInstalled = false;

/** Test seam: allows a restored global fetch to be wrapped again. */
export function __resetGlobalProxyFetch(): void {
	globalProxyFetchInstalled = false;
}

/**
 * Applies `PI_PROXY` to bare process-wide fetch calls such as OAuth, usage, and
 * model discovery. Per-request provider proxies retain precedence, while local,
 * private-range, metadata, and NO_PROXY targets remain direct.
 */
export function installGlobalProxyFetch(): void {
	if (globalProxyFetchInstalled) return;
	const proxyUrl = Bun.env.PI_PROXY?.trim();
	if (!proxyUrl) return;
	globalProxyFetchInstalled = true;
	globalThis.fetch = wrapFetchWithProxyUrl(globalThis.fetch, proxyUrl) as typeof globalThis.fetch;
}

export interface ConnectProxiedSocketOptions {
	/** Caller cancellation for the proxy TCP/TLS handshake and CONNECT tunnel. */
	signal?: AbortSignal;
	/** Maximum wall-clock time to establish the final TLS tunnel. Disabled when absent or non-positive. */
	timeoutMs?: number;
	/** Target TLS profile. Cursor defaults to HTTP/2 when this is absent. */
	tls?: tls.ConnectionOptions;
}

/**
 * Tunnel a socket connection through an HTTP CONNECT proxy.
 * This is used specifically to wrap Node's `http2.connect(baseUrl, { createConnection })` for Cursor.
 */
export async function connectProxiedSocket(
	proxyUrlStr: string,
	targetUrlStr: string,
	options?: ConnectProxiedSocketOptions,
): Promise<tls.TLSSocket> {
	if (options?.signal?.aborted) {
		throw new AbortError("Proxy tunnel aborted");
	}

	const proxyUrl = new URL(proxyUrlStr);
	const targetUrl = new URL(targetUrlStr);

	const useProxySsl = proxyUrl.protocol === "https:";
	const proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : useProxySsl ? 443 : 80;
	const proxyHost = proxyUrl.hostname;

	const targetPort = targetUrl.port ? parseInt(targetUrl.port, 10) : 443;
	const targetHost = targetUrl.hostname;

	const { promise, resolve, reject } = Promise.withResolvers<tls.TLSSocket>();

	const readyEvent = useProxySsl ? "secureConnect" : "connect";
	let rawSocket: net.Socket | undefined;
	let tunnelSocket: tls.TLSSocket | undefined;
	let timeout: NodeJS.Timeout | undefined;
	let responseData = "";
	let settled = false;

	const cleanup = (): void => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		options?.signal?.removeEventListener("abort", onAbort);
		rawSocket?.off("error", onRawError);
		rawSocket?.off(readyEvent, onProxyReady);
		rawSocket?.off("data", onProxyData);
		tunnelSocket?.off("secureConnect", onTunnelReady);
		tunnelSocket?.off("error", onTunnelError);
	};
	const destroyInProgress = (): void => {
		tunnelSocket?.destroy();
		rawSocket?.destroy();
	};
	const rejectOnce = (error: Error): void => {
		if (settled) return;
		settled = true;
		cleanup();
		destroyInProgress();
		reject(error);
	};
	const resolveOnce = (socket: tls.TLSSocket): void => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(socket);
	};
	const onAbort = (): void => rejectOnce(new AbortError("Proxy tunnel aborted"));
	const onRawError = (error: Error): void => rejectOnce(error);
	const onTunnelError = (error: Error): void => rejectOnce(error);
	const onTunnelReady = (): void => {
		if (!tunnelSocket) return;
		resolveOnce(tunnelSocket);
	};
	const onProxyData = (chunk: Buffer): void => {
		if (!rawSocket) return;
		responseData += chunk.toString("binary");
		if (!responseData.includes("\r\n\r\n")) return;

		rawSocket.off("data", onProxyData);
		rawSocket.off("error", onRawError);

		const firstLine = responseData.split("\r\n")[0];
		if (!firstLine.includes(" 200 ")) {
			rejectOnce(new ValidationError(`Proxy tunnel failed: ${firstLine}`));
			return;
		}

		const tlsOptions = options?.tls;
		tunnelSocket = tls.connect({
			...tlsOptions,
			socket: rawSocket,
			servername: tlsOptions?.servername ?? targetHost,
			ALPNProtocols: tlsOptions?.ALPNProtocols ?? ["h2"],
		});
		tunnelSocket.once("secureConnect", onTunnelReady);
		tunnelSocket.once("error", onTunnelError);
	};
	const onProxyReady = (): void => {
		if (!rawSocket) return;
		let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` + `Host: ${targetHost}:${targetPort}\r\n`;

		if (proxyUrl.username || proxyUrl.password) {
			const creds = Buffer.from(
				`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
			).toString("base64");
			connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
		}
		connectReq += "\r\n";

		rawSocket.write(connectReq);
		rawSocket.on("data", onProxyData);
	};

	options?.signal?.addEventListener("abort", onAbort, { once: true });
	if (options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
		const timeoutMs = Math.trunc(options.timeoutMs);
		timeout = setTimeout(() => {
			rejectOnce(new StreamTimeoutError(`Proxy tunnel timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timeout.unref?.();
	}

	rawSocket = useProxySsl
		? tls.connect({
				host: proxyHost,
				port: proxyPort,
			})
		: net.connect({
				host: proxyHost,
				port: proxyPort,
			});
	rawSocket.once("error", onRawError);
	rawSocket.once(readyEvent, onProxyReady);

	return promise;
}
