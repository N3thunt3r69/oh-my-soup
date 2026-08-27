import { truncate } from "@oh-my-soup/pi-utils";

/** Messages that carry no diagnostic content on their own. */
const GENERIC_CONNECT_ERROR_MESSAGES = ["", "error", "unknown", "unknown error", "internal", "internal error"];
/** Upper bound for appended trailer context so errors stay log-line sized. */
const MAX_EXTRA_DETAIL_CHARS = 400;

function safeJson(value: unknown): string | undefined {
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return text || undefined;
	} catch {
		return undefined;
	}
}

/** Summarizes typed Connect error detail entries when diagnostic content is present. */
export function summarizeConnectErrorDetails(details: unknown): string | undefined {
	if (!Array.isArray(details) || details.length === 0) return undefined;
	const parts: string[] = [];
	for (const entry of details) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const record = entry as { type?: unknown; debug?: unknown; value?: unknown };
		const type = typeof record.type === "string" && record.type ? record.type : undefined;
		const debug = record.debug !== undefined ? safeJson(record.debug) : undefined;
		const value = record.value !== undefined ? safeJson(record.value) : undefined;
		const diagnostic = debug ?? value;
		if (type && diagnostic) parts.push(`${type}: ${diagnostic}`);
		else if (type) parts.push(type);
		else if (diagnostic) parts.push(diagnostic);
	}
	if (parts.length === 0) return undefined;
	return truncate(parts.join("; "), MAX_EXTRA_DETAIL_CHARS);
}

/** Formats a Connect end-stream error while preserving its legacy prefix. */
export function formatConnectEndStreamError(error: unknown): string {
	const record =
		typeof error === "object" && error !== null && !Array.isArray(error) ? (error as Record<string, unknown>) : {};
	const code = typeof record.code === "string" && record.code ? record.code : "unknown";
	const message = typeof record.message === "string" ? record.message : "";
	const detail = summarizeConnectErrorDetails(record.details);
	const parts: string[] = [`Connect error ${code}: ${message || "Unknown error"}`];
	if (detail) parts.push(`[details: ${detail}]`);
	else if (GENERIC_CONNECT_ERROR_MESSAGES.includes(message.trim().toLowerCase())) {
		const extras: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(record)) {
			if (key === "code" || key === "message") continue;
			extras[key] = value;
		}
		const raw = Object.keys(extras).length > 0 ? safeJson(extras) : undefined;
		if (raw && raw !== "{}") parts.push(`[trailer: ${truncate(raw, MAX_EXTRA_DETAIL_CHARS)}]`);
	}
	return parts.join(" ");
}
