import { describe, expect, it } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { buildGrpcRequest } from "@oh-my-soup/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-soup/pi-ai/types";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { AgentClientMessageSchema } from "@oh-my-soup/pi-catalog/discovery/cursor-gen/agent_pb";

const model: Model<"cursor-agent"> = buildModel({
	id: "cursor-composer-2.5",
	name: "Cursor Composer 2.5",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://api2.cursor.sh",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

function decodeRunRequest(requestBytes: Uint8Array): { case: string; value: Record<string, any> } {
	const decoded = fromBinary(AgentClientMessageSchema, requestBytes);
	return decoded.message as unknown as { case: string; value: Record<string, any> };
}

async function build(options: Parameters<typeof buildGrpcRequest>[2]) {
	return buildGrpcRequest(model, context, options, { conversationId: "conv-1", blobStore: new Map() });
}

describe("cursor onPayload replacement", () => {
	it("serializes an async replacement", async () => {
		const { requestBytes } = await build({
			onPayload: async payload => ({
				...(payload as Record<string, unknown>),
				customSystemPrompt: "replacement",
			}),
		});

		const message = decodeRunRequest(requestBytes);
		expect(message.case).toBe("runRequest");
		expect(message.value.customSystemPrompt).toBe("replacement");
	});

	it("keeps the original payload when the hook returns undefined", async () => {
		const { requestBytes } = await build({ onPayload: async () => undefined });
		expect(decodeRunRequest(requestBytes).value.customSystemPrompt).toBeUndefined();
	});

	it("applies customSystemPrompt when the hook returns undefined", async () => {
		const { requestBytes } = await build({ customSystemPrompt: "from-options", onPayload: async () => undefined });
		expect(decodeRunRequest(requestBytes).value.customSystemPrompt).toBe("from-options");
	});

	it("lets the replacement drop customSystemPrompt", async () => {
		let hookSawOption = false;
		const { requestBytes } = await build({
			customSystemPrompt: "from-options",
			onPayload: async payload => {
				const { customSystemPrompt, ...rest } = payload as Record<string, unknown>;
				hookSawOption = customSystemPrompt === "from-options";
				return rest;
			},
		});

		expect(hookSawOption).toBe(true);
		expect(decodeRunRequest(requestBytes).value.customSystemPrompt).toBeUndefined();
	});

	it("lets the replacement override customSystemPrompt", async () => {
		const { requestBytes } = await build({
			customSystemPrompt: "from-options",
			onPayload: async payload => ({
				...(payload as Record<string, unknown>),
				customSystemPrompt: "from-hook",
			}),
		});

		expect(decodeRunRequest(requestBytes).value.customSystemPrompt).toBe("from-hook");
	});
});
