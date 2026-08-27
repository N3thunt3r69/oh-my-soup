import { describe, expect, it } from "bun:test";
import {
	formatConnectEndStreamError,
	summarizeConnectErrorDetails,
} from "@oh-my-soup/pi-ai/providers/connect-error-detail";

describe("formatConnectEndStreamError", () => {
	it("keeps the legacy prefix for a plain code/message error", () => {
		expect(formatConnectEndStreamError({ code: "unavailable", message: "post-turn connect failure" })).toBe(
			"Connect error unavailable: post-turn connect failure",
		);
	});

	it("falls back for malformed payloads", () => {
		expect(formatConnectEndStreamError({})).toBe("Connect error unknown: Unknown error");
		expect(formatConnectEndStreamError(null)).toBe("Connect error unknown: Unknown error");
		expect(formatConnectEndStreamError({ code: 5, message: 7 })).toBe("Connect error unknown: Unknown error");
	});

	it("appends detail values so the server rejection is visible", () => {
		const formatted = formatConnectEndStreamError({
			code: "invalid_argument",
			message: "Error",
			details: [{ type: "google.rpc.BadRequest", value: { fieldViolations: [{ field: "tools" }] } }],
		});
		expect(formatted).toContain("Connect error invalid_argument: Error");
		expect(formatted).toContain("google.rpc.BadRequest");
		expect(formatted).toContain("fieldViolations");
	});

	it("inlines leftover fields only for a generic detail-free message", () => {
		expect(
			formatConnectEndStreamError({ code: "invalid_argument", message: "Error", requestId: "req-123" }),
		).toContain("req-123");
		expect(
			formatConnectEndStreamError({
				code: "invalid_argument",
				message: "tools[3].parameters is not an object",
				requestId: "req-123",
			}),
		).toBe("Connect error invalid_argument: tools[3].parameters is not an object");
	});

	it("caps oversized detail payloads at the documented bound", () => {
		const detail = summarizeConnectErrorDetails([{ type: "t", debug: "x".repeat(2000) }]);
		expect(detail?.length).toBe(400);
		expect(detail).toEndWith("…");
	});
});

describe("summarizeConnectErrorDetails", () => {
	it("ignores unusable details", () => {
		expect(summarizeConnectErrorDetails(undefined)).toBeUndefined();
		expect(summarizeConnectErrorDetails([42, "junk"])).toBeUndefined();
	});

	it("joins typed entries without quoting string diagnostics", () => {
		expect(summarizeConnectErrorDetails([{ type: "a.b.C", debug: "why" }, { type: "d.e.F" }])).toBe(
			"a.b.C: why; d.e.F",
		);
	});

	it("serializes structured detail values as JSON", () => {
		expect(summarizeConnectErrorDetails([{ type: "a.b.C", value: { reason: "why" } }])).toBe(
			'a.b.C: {"reason":"why"}',
		);
	});
});
