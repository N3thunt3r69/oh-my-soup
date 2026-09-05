import { describe, expect, it } from "bun:test";
import { streamOpenAICodexResponses } from "@oh-my-soup/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl } from "@oh-my-soup/pi-ai/types";
import { createCodexModel } from "./helpers";

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

const CONTEXT: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

const COMPLETED_EVENTS: Array<Record<string, unknown>> = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello" }],
		},
	},
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
];

const NAMESPACES_INFO = {
	functions: {
		name: "functions",
		functions: {
			read: { name: "read", direct: false, code_mode_name: "read", deferred: false, source: { kind: "harness" } },
			eval: { name: "eval", direct: true, code_mode_name: "eval", deferred: false, source: { kind: "harness" } },
		},
	},
};

function decodeCodexRequestBody(body: RequestInit["body"]): string {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(Bun.zstdDecompressSync(body));
	throw new Error("expected a string or binary Codex request body");
}

async function captureTurnMetadata(opts: Record<string, unknown>): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	const fetchMock = (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.endsWith("/responses")) {
			const body = JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>;
			const clientMetadata = (body.client_metadata ?? {}) as Record<string, unknown>;
			const encoded = clientMetadata["x-codex-turn-metadata"];
			resolve(typeof encoded === "string" ? (JSON.parse(encoded) as Record<string, unknown>) : {});
		}
		const sse = `${COMPLETED_EVENTS.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as unknown as FetchImpl;
	await streamOpenAICodexResponses(createCodexModel("gpt-5.6-sol"), CONTEXT, {
		apiKey: createCodexTestToken(),
		fetch: fetchMock,
		...opts,
	}).result();
	return promise;
}
describe("codex code mode tool_namespaces_info metadata", () => {
	it("emits tool_namespaces_info in turn metadata when provided", async () => {
		const turnMetadata = await captureTurnMetadata({ toolNamespacesInfo: NAMESPACES_INFO });
		expect(turnMetadata.tool_namespaces_info).toEqual(NAMESPACES_INFO);
	});

	it("omits tool_namespaces_info when the option is absent", async () => {
		const turnMetadata = await captureTurnMetadata({});
		expect("tool_namespaces_info" in turnMetadata).toBe(false);
	});
});
