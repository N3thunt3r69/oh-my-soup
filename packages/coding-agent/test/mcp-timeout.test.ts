import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { createMCPTimeout, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "@oh-my-soup/pi-coding-agent/mcp/timeout";
import { logger } from "@oh-my-soup/pi-utils";

const ORIGINAL_TIMEOUT = process.env.OMS_MCP_TIMEOUT_MS;

afterEach(() => {
	vi.useRealTimers();
	if (ORIGINAL_TIMEOUT === undefined) {
		delete process.env.OMS_MCP_TIMEOUT_MS;
	} else {
		process.env.OMS_MCP_TIMEOUT_MS = ORIGINAL_TIMEOUT;
	}
});

describe("MCP timeout configuration", () => {
	test("uses the default timeout when no config or env override is set", () => {
		delete process.env.OMS_MCP_TIMEOUT_MS;

		expect(resolveMCPTimeoutMs()).toBe(30_000);
	});

	test("uses per-server timeout when env override is unset", () => {
		delete process.env.OMS_MCP_TIMEOUT_MS;

		expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
	});

	test("allows the env override to disable MCP client-side timeouts", () => {
		process.env.OMS_MCP_TIMEOUT_MS = "0";

		const timeout = resolveMCPTimeoutMs(30_000);
		expect(timeout).toBe(0);
		expect(isMCPTimeoutEnabled(timeout)).toBe(false);
	});

	test("allows the env override to set one timeout for every server", () => {
		process.env.OMS_MCP_TIMEOUT_MS = "180000";

		expect(resolveMCPTimeoutMs(30_000)).toBe(180_000);
	});

	test("rejects negative env values and warns, falling back to the default", () => {
		process.env.OMS_MCP_TIMEOUT_MS = "-1";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs(120_000)).toBe(120_000);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("OMS_MCP_TIMEOUT_MS");
		} finally {
			warn.mockRestore();
		}
	});

	test("rejects non-numeric env values and falls back to the default", () => {
		process.env.OMS_MCP_TIMEOUT_MS = "not-a-number";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});

		try {
			expect(resolveMCPTimeoutMs()).toBe(30_000);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("createMCPTimeout abort-source ordering", () => {
	test("preserves the timeout when the caller aborts after the timer", () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const operation = createMCPTimeout(10, caller.signal);
		try {
			vi.advanceTimersByTime(10);
			expect(operation.timedOut()).toBe(true);

			caller.abort();

			expect(operation.timedOut()).toBe(true);
			expect(operation.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(true);
			expect(operation.isTimeoutAbort(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
		} finally {
			operation.clear();
		}
	});

	test("cancels the losing timer when the caller aborts first", () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const operation = createMCPTimeout(10, caller.signal);
		try {
			caller.abort();
			vi.advanceTimersByTime(20);

			expect(operation.signal?.aborted).toBe(true);
			expect(operation.timedOut()).toBe(false);
			expect(operation.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(false);
			expect(operation.isTimeoutAbort(new SyntaxError("Unexpected end of JSON input"))).toBe(false);
		} finally {
			operation.clear();
		}
	});

	test("does not start a timeout for an already-aborted caller", () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		caller.abort();
		const operation = createMCPTimeout(10, caller.signal);
		try {
			vi.advanceTimersByTime(20);

			expect(operation.signal?.aborted).toBe(true);
			expect(operation.timedOut()).toBe(false);
			expect(operation.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(false);
		} finally {
			operation.clear();
		}
	});

	test("does not classify malformed JSON as a timeout before its timer fires", () => {
		const operation = createMCPTimeout(10_000);
		try {
			expect(operation.timedOut()).toBe(false);
			expect(operation.isTimeoutAbort(new SyntaxError("Unexpected token"))).toBe(false);
		} finally {
			operation.clear();
		}
	});

	test("disabled timeouts never report timeout ownership", () => {
		const operation = createMCPTimeout(0);
		expect(operation.timedOut()).toBe(false);
		expect(operation.isTimeoutAbort(new DOMException("aborted", "AbortError"))).toBe(false);
	});
});
