import { describe, expect, it } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	type BlockState,
	handleServerMessage,
	processInteractionUpdate,
	type ToolCallState,
} from "@oh-my-soup/pi-ai/providers/cursor";
import type { AssistantMessage, CursorToolResultHandler, ToolResultMessage } from "@oh-my-soup/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-soup/pi-ai/utils/event-stream";
import type { InteractionQuery, InteractionResponse } from "@oh-my-soup/pi-catalog/discovery/cursor-gen/agent_pb";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	FetchArgsSchema,
	FetchResultSchema,
	FetchSuccessSchema,
	FetchToolCallSchema,
	InteractionQuerySchema,
	ToolCallSchema,
	WebFetchRequestQuerySchema,
} from "@oh-my-soup/pi-catalog/discovery/cursor-gen/agent_pb";

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-grok-4.6-xhigh-fast",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function newBlockState(onToolResult?: CursorToolResultHandler): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		openToolCalls: new Map(),
		resolvedMcpToolCallIds: new Set(),
		firstTokenTime: undefined,
		setTextBlock: block => {
			textBlock = block;
		},
		setThinkingBlock: block => {
			thinkingBlock = block;
		},
		setToolCall: block => {
			toolCall = block;
		},
		setFirstTokenTime: () => {},
		onToolResult,
	};
}

function decodeClientFrame(frame: Buffer): AgentClientMessage {
	const length = frame.readUInt32BE(1);
	return fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + length));
}

function expectInteractionResponse(frames: AgentClientMessage[]): InteractionResponse {
	expect(frames).toHaveLength(1);
	const frame = frames[0];
	if (frame?.message.case !== "interactionResponse") throw new Error("expected an interactionResponse frame");
	return frame.message.value;
}

async function dispatchQuery(query: InteractionQuery): Promise<AgentClientMessage[]> {
	const written: Buffer[] = [];
	const h2Request = {
		write: (chunk: Buffer) => {
			written.push(chunk);
			return true;
		},
	} as unknown as Parameters<typeof handleServerMessage>[5];

	await handleServerMessage(
		create(AgentServerMessageSchema, { message: { case: "interactionQuery", value: query } }),
		cursorAssistantMessage(),
		new AssistantMessageEventStream(),
		newBlockState(),
		new Map(),
		h2Request,
		undefined,
		undefined,
		{ sawTokenDelta: false },
		[],
	);
	return written.map(decodeClientFrame);
}

describe("Cursor hosted WebFetch", () => {
	it("approves the field-9 permission query so the hosted turn can continue", async () => {
		const response = expectInteractionResponse(
			await dispatchQuery(
				create(InteractionQuerySchema, {
					id: 18,
					query: {
						case: "webFetchRequestQuery",
						value: create(WebFetchRequestQuerySchema, {
							args: create(FetchArgsSchema, { url: "https://example.com", toolCallId: "fetch-2" }),
						}),
					},
				}),
			),
		);

		expect(response.id).toBe(18);
		expect(response.result.case).toBe("webFetchRequestResponse");
		if (response.result.case !== "webFetchRequestResponse") return;
		expect(response.result.value.result.case).toBe("approved");
	});

	it("renders and pairs the server-hosted fetch without scheduling a local fetch", () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const results: ToolResultMessage[] = [];
		const state = newBlockState(message => {
			results.push(message);
			return undefined;
		});
		const args = create(FetchArgsSchema, { url: "https://example.com", toolCallId: "fetch-2" });

		processInteractionUpdate(
			{
				message: {
					case: "toolCallStarted",
					value: {
						callId: "fetch-envelope",
						toolCall: create(ToolCallSchema, {
							tool: { case: "webFetchToolCall", value: create(FetchToolCallSchema, { args }) },
						}),
					},
				},
			},
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		expect(output.content).toMatchObject([
			{ type: "toolCall", id: "fetch-2", name: "web_fetch", arguments: { url: "https://example.com" } },
		]);

		processInteractionUpdate(
			{
				message: {
					case: "toolCallCompleted",
					value: {
						callId: "fetch-envelope",
						toolCall: create(ToolCallSchema, {
							tool: {
								case: "webFetchToolCall",
								value: create(FetchToolCallSchema, {
									args,
									result: create(FetchResultSchema, {
										result: {
											case: "success",
											value: create(FetchSuccessSchema, {
												url: "https://example.com",
												content: "Example Domain",
												statusCode: 200,
												contentType: "text/html",
											}),
										},
									}),
								}),
							},
						}),
					},
				},
			},
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			toolCallId: "fetch-2",
			toolName: "web_fetch",
			content: [{ type: "text", text: "Example Domain" }],
			isError: false,
		});
	});
});
