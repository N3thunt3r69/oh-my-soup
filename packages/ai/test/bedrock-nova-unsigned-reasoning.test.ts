import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@oh-my-soup/pi-ai/providers/amazon-bedrock";
import type { Context, Model } from "@oh-my-soup/pi-ai/types";
import { buildModel } from "@oh-my-soup/pi-catalog/build";

const novaModel: Model<"bedrock-converse-stream"> = buildModel({
	id: "us.amazon.nova-pro-v1:0",
	name: "Nova Pro",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 1 },
	contextWindow: 300_000,
	maxTokens: 5_000,
});

const novaProfileArn = "arn:aws:bedrock:us-east-1:1234567890:application-inference-profile/company-nova-pro";

function contextWithUnsignedThinking(modelId: string): Context {
	return {
		messages: [
			{ role: "user", content: "Plan the change", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Inspect the implementation", thinkingSignature: "" },
					{ type: "text", text: "I found the relevant code." },
				],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: modelId,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
			{ role: "user", content: "Continue", timestamp: 2 },
		],
	};
}

async function captureReplayPayload(model: Model<"bedrock-converse-stream">, context: Context): Promise<unknown> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<unknown>();

	void streamBedrock(model, context, {
		bearerToken: "test-token",
		signal: controller.signal,
		maxTokens: 16,
		onPayload: payload => resolve(payload),
	});

	return promise;
}

describe("Bedrock unsigned reasoning replay", () => {
	test("demotes Nova unsigned thinking to text", async () => {
		const payload = await captureReplayPayload(novaModel, contextWithUnsignedThinking(novaModel.id));
		const messages = (payload as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> })
			.messages;

		expect(messages[0]).toMatchObject({ role: "user" });
		expect(messages[0].content).toContainEqual({ text: "Plan the change" });
		expect(messages[2]).toMatchObject({ role: "user" });
		expect(messages[2].content).toContainEqual({ text: "Continue" });
		expect(messages[1].content[0]).toMatchObject({
			text: "<thinking>\nInspect the implementation\n</thinking>",
		});
		expect(messages[1].content[1]).toMatchObject({ text: "I found the relevant code." });
		for (const block of messages[1].content) expect(block).not.toHaveProperty("reasoningContent");
	});

	test("also demotes unsigned thinking for an opaque application profile ARN", async () => {
		const profileModel: Model<"bedrock-converse-stream"> = buildModel({
			...novaModel,
			id: novaProfileArn,
			name: "Nova Pro (inference profile)",
		});
		const payload = await captureReplayPayload(profileModel, contextWithUnsignedThinking(novaProfileArn));
		const assistant = (payload as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages[1];
		for (const block of assistant.content) expect(block).not.toHaveProperty("reasoningContent");
	});
});
