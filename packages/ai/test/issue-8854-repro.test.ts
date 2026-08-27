import { describe, expect, test } from "bun:test";
import type { FetchImpl } from "../src/types";
import { OpenAIHttpError, postOpenAIStream } from "../src/utils/openai-http";
import { mockFetch } from "./helpers/fetch-mock";

describe("OpenAI transport concurrency-admission 429 (#8854)", () => {
	const concurrencyBody = JSON.stringify({
		error: {
			message: "Max parallel request limit reached",
			type: "rate_limit_error",
			rate_limit_type: "max_parallel_requests",
		},
	});

	async function rejectedAttempt(fetch: FetchImpl): Promise<unknown> {
		return postOpenAIStream({
			url: "https://litellm.local/v1/chat/completions",
			headers: {},
			body: { model: "gpt-4o", messages: [] },
			signal: new AbortController().signal,
			fetch,
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
	}

	test("surfaces header- and body-marked limiter responses on the first attempt", async () => {
		for (const marker of ["header", "body"] as const) {
			let attempts = 0;
			const fetch = mockFetch(() => {
				attempts++;
				return new Response(concurrencyBody, {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "60",
						...(marker === "header" ? { rate_limit_type: "max_parallel_requests" } : {}),
					},
				});
			});

			const error = await rejectedAttempt(fetch);
			expect(attempts).toBe(1);
			expect(error).toBeInstanceOf(OpenAIHttpError);
			expect((error as OpenAIHttpError).status).toBe(429);
		}
	});

	test("still retries an ordinary 429 without the concurrency marker", async () => {
		let attempts = 0;
		const fetch = mockFetch(() => {
			attempts++;
			if (attempts === 1) {
				return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
					status: 429,
					headers: { "content-type": "application/json", "retry-after-ms": "5" },
				});
			}
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const handle = await postOpenAIStream({
			url: "https://api.openai.com/v1/chat/completions",
			headers: {},
			body: { model: "gpt-4o", messages: [] },
			signal: new AbortController().signal,
			fetch,
		});

		expect(attempts).toBe(2);
		expect(handle.response.status).toBe(200);
	});
});
