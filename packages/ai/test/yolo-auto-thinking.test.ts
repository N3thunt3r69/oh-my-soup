import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { Effort } from "@oh-my-soup/pi-catalog/effort";
import { YOLO_AUTO_STATIC_MODELS } from "@oh-my-soup/pi-catalog/provider-models/openai-compat";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, FetchImpl, Model } from "../src/types";

const model = buildModel(YOLO_AUTO_STATIC_MODELS[0]) as Model<"openai-completions">;
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

async function outgoingBody(options: {
	reasoning?: Effort;
	disableReasoning?: boolean;
}): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchImpl: FetchImpl = async (_input, init) => {
		if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
		const chunk = JSON.stringify({
			id: "chatcmpl-yolo",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		});
		return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	await streamOpenAICompletions(model, context, { apiKey: "yolo-test-key", fetch: fetchImpl, ...options }).result();
	if (!body) throw new Error("Yolo-Auto request was not captured");
	return body;
}

describe("Yolo-Auto chat-template thinking wire format", () => {
	test("enables generic template thinking and forwards the mapped effort", async () => {
		const body = await outgoingBody({ reasoning: Effort.XHigh });
		expect(body.chat_template_kwargs).toEqual({ thinking: true, reasoning_effort: "max" });
		expect(body).not.toHaveProperty("reasoning_effort");
	});

	test("disables thinking through the schema-safe template kwargs field", async () => {
		const body = await outgoingBody({ disableReasoning: true });
		expect(body.chat_template_kwargs).toEqual({ thinking: false });
		expect(body).not.toHaveProperty("reasoning_effort");
	});
});
