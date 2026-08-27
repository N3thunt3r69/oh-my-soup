import { describe, expect, it } from "bun:test";
import { retryTransientCompletion } from "@oh-my-soup/pi-ai/oneshot-retry";
import type { AssistantMessage, Usage } from "@oh-my-soup/pi-ai/types";

type AbortEventListener = ((event: Event) => void) | { handleEvent(event: Event): void };

const emptyUsage = (): Usage =>
	({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}) as Usage;

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

const overloaded = (): AssistantMessage =>
	message({ stopReason: "error", errorStatus: 529, errorMessage: "overloaded_error: Overloaded" });
const rateLimited = (): AssistantMessage =>
	message({ stopReason: "error", errorStatus: 429, errorMessage: "rate_limit_error: too many requests" });
const fast = { baseDelayMs: 1, maxAttempts: 3 } as const;

describe("retryTransientCompletion", () => {
	it("retries resolved transient error stops until success", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			return Promise.resolve(calls < 3 ? overloaded() : message());
		}, fast);
		expect(calls).toBe(3);
		expect(final.stopReason).toBe("stop");
	});

	it("retries status-only transient error stops", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			return Promise.resolve(
				calls === 1
					? message({ stopReason: "error", errorStatus: 503, errorMessage: "request failed" })
					: message(),
			);
		}, fast);
		expect(calls).toBe(2);
		expect(final.stopReason).toBe("stop");
	});

	it("returns the final resolved failure unchanged", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			return Promise.resolve(overloaded());
		}, fast);
		expect(calls).toBe(3);
		expect(final.errorMessage).toContain("overloaded_error");
	});

	it("does not retry a non-transient provider error", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			return Promise.resolve(
				message({ stopReason: "error", errorStatus: 400, errorMessage: "invalid_request_error: bad schema" }),
			);
		}, fast);
		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("does not retry deterministic llama.cpp parse failures reported as 500", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			return Promise.resolve(
				message({
					stopReason: "error",
					errorStatus: 500,
					errorMessage: "failed to parse tool call arguments as JSON",
				}),
			);
		}, fast);
		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("retries thrown transient failures and rethrows the last one", async () => {
		let calls = 0;
		const attempt = retryTransientCompletion(() => {
			calls += 1;
			const error = new Error("overloaded_error") as Error & { status: number };
			error.status = 529;
			throw error;
		}, fast);
		await expect(attempt).rejects.toThrow("overloaded_error");
		expect(calls).toBe(3);
	});

	it("retries thrown status-only transient failures", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			if (calls === 1) {
				const error = new Error("request failed") as Error & { status: number };
				error.status = 503;
				throw error;
			}
			return Promise.resolve(message());
		}, fast);
		expect(calls).toBe(2);
		expect(final.stopReason).toBe("stop");
	});

	it("does not retry thrown non-transient failures", async () => {
		let calls = 0;
		const attempt = retryTransientCompletion(() => {
			calls += 1;
			throw new Error("invalid_request_error: bad schema");
		}, fast);
		await expect(attempt).rejects.toThrow("invalid_request_error");
		expect(calls).toBe(1);
	});

	it("does not retry an input the model cannot fit", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(
					message({
						stopReason: "error",
						errorStatus: 400,
						errorMessage:
							"invalid_request_error: prompt is too long: 3059586 tokens > 1000000 maximum (raw-http-request=/logs/1787022540720-3o503gxo48bvb.json)",
					}),
				);
			},
			{ ...fast, maxAttempts: 5 },
		);

		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("stops immediately when already aborted at an attempt boundary", async () => {
		const controller = new AbortController();
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				controller.abort();
				return Promise.resolve(overloaded());
			},
			{ ...fast, signal: controller.signal },
		);
		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("rejects with the abort reason when cancelled during backoff", async () => {
		const reason = new Error("user cancelled");
		let aborted = false;
		const signal = {
			get aborted() {
				return aborted;
			},
			get reason() {
				return aborted ? reason : undefined;
			},
			addEventListener(type: string, listener: AbortEventListener) {
				if (type !== "abort") return;
				aborted = true;
				const event = new Event("abort");
				if (typeof listener === "function") listener(event);
				else listener.handleEvent(event);
			},
			removeEventListener() {},
		} as unknown as AbortSignal;
		let calls = 0;
		const attempt = retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(overloaded());
			},
			{ maxAttempts: 3, baseDelayMs: 200, signal },
		);
		await expect(attempt).rejects.toThrow("user cancelled");
		expect(calls).toBe(1);
	});

	it("reports retries through the instrumentation hook", async () => {
		const attempts: number[] = [];
		let calls = 0;
		await retryTransientCompletion(() => Promise.resolve(++calls === 1 ? overloaded() : message()), {
			...fast,
			onRetry: info => attempts.push(info.attempt),
		});
		expect(attempts).toEqual([1]);
	});

	it("honors response retry-after headers", async () => {
		let calls = 0;
		let delay = -1;
		await retryTransientCompletion(() => Promise.resolve(++calls === 1 ? rateLimited() : message()), {
			maxAttempts: 2,
			baseDelayMs: 1,
			getResponseHeaders: () => ({ "retry-after-ms": "5" }),
			onRetry: info => {
				delay = info.delayMs;
			},
		});
		expect(delay).toBe(5);
	});

	it("honors retry-after headers carried by thrown errors", async () => {
		let calls = 0;
		let delay = -1;
		const attempt = retryTransientCompletion(
			() => {
				calls += 1;
				const error = new Error("overloaded_error") as Error & {
					status: number;
					headers: Record<string, string>;
				};
				error.status = 529;
				error.headers = { "retry-after-ms": "5" };
				throw error;
			},
			{ maxAttempts: 2, baseDelayMs: 1, onRetry: info => (delay = info.delayMs) },
		);
		await expect(attempt).rejects.toThrow("overloaded_error");
		expect(calls).toBe(2);
		expect(delay).toBe(5);
	});

	it("honors the canonical retry-after-ms message suffix", async () => {
		let calls = 0;
		let delay = -1;
		await retryTransientCompletion(
			() =>
				Promise.resolve(
					++calls === 1
						? message({ stopReason: "error", errorStatus: 429, errorMessage: "rate limited retry-after-ms=5" })
						: message(),
				),
			{ maxAttempts: 2, baseDelayMs: 1, onRetry: info => (delay = info.delayMs) },
		);
		expect(delay).toBe(5);
	});

	it("surfaces failures instead of parking beyond maxDelayMs", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(
					message({ stopReason: "error", errorStatus: 429, errorMessage: "rate limited retry-after-ms=12000" }),
				);
			},
			{ ...fast, maxDelayMs: 1000 },
		);
		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("surfaces failures instead of parking on an over-cap text retry hint", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(
					message({
						stopReason: "error",
						errorStatus: 429,
						errorMessage: "rate_limit_error: please retry in 600s",
					}),
				);
			},
			{ ...fast, maxDelayMs: 1_000 },
		);
		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("surfaces failures when a retry-after header exceeds maxDelayMs", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(rateLimited());
			},
			{
				maxAttempts: 3,
				baseDelayMs: 1,
				maxDelayMs: 1_000,
				getResponseHeaders: () => ({ "retry-after": "300" }),
			},
		);
		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});
	it("does not retry a transient-wrapped payload rejection", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(
					message({
						stopReason: "error",
						errorStatus: 413,
						errorMessage: "provider returned error: request_too_large payload too large",
					}),
				);
			},
			{ ...fast, maxAttempts: 5 },
		);
		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("keeps retrying narrowly-classified transient 400s", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			return Promise.resolve(
				calls === 1
					? message({
							stopReason: "error",
							errorStatus: 400,
							errorMessage: "provider returned error: numerical decode fault",
						})
					: message(),
			);
		}, fast);
		expect(calls).toBe(2);
		expect(final.stopReason).toBe("stop");
	});
});
