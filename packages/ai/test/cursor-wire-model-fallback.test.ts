import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { streamCursor } from "@oh-my-soup/pi-ai/providers/cursor";
import type { AssistantMessage, Context, Model } from "@oh-my-soup/pi-ai/types";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import {
	AgentClientMessageSchema,
	type AgentRunRequest,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	HeartbeatUpdateSchema,
	type InteractionUpdate,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-soup/pi-catalog/discovery/cursor-gen/agent_pb";
import type { ModelSpec } from "@oh-my-soup/pi-catalog/types";

const CONNECT_END_STREAM_FLAG = 0b00000010;

type Response =
	| { kind: "error"; code: string; message: string; partialText?: string; heartbeat?: boolean }
	| { kind: "success"; text: string }
	| { kind: "exec-success" };

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let responses: Response[] = [];
let requests: AgentRunRequest[] = [];

function frameConnectMessage(payload: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + payload.length);
	frame[0] = flags;
	frame.writeUInt32BE(payload.length, 1);
	frame.set(payload, 5);
	return frame;
}
function interactionFrame(message: InteractionUpdate["message"]): Buffer {
	const serverMessage = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, { message }),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, serverMessage));
}

function textDeltaFrame(text: string): Buffer {
	return interactionFrame({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) });
}

function turnEndedFrame(): Buffer {
	return interactionFrame({ case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) });
}

function heartbeatFrame(): Buffer {
	return interactionFrame({ case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) });
}

function execReadRequestFrame(): Buffer {
	const serverMessage = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				execId: "exec-fallback",
				message: {
					case: "readArgs",
					value: create(ReadArgsSchema, { path: "/tmp/fallback", toolCallId: "call-fallback" }),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, serverMessage));
}

function connectErrorFrame(code: string, message: string): Buffer {
	return frameConnectMessage(Buffer.from(JSON.stringify({ error: { code, message } })), CONNECT_END_STREAM_FLAG);
}

function decodeRunRequest(frame: Buffer): AgentRunRequest {
	const payloadLength = frame.readUInt32BE(1);
	const clientMessage = fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + payloadLength));
	if (clientMessage.message.case !== "runRequest") {
		throw new Error(`expected runRequest, received ${clientMessage.message.case ?? "empty message"}`);
	}
	return clientMessage.message.value;
}

function isAgentRunRequest(payload: unknown): payload is AgentRunRequest {
	return payload !== null && typeof payload === "object" && "$typeName" in payload;
}

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			if (pending.length < 5) return;
			const payloadLength = pending.readUInt32BE(1);
			if (pending.length < 5 + payloadLength) return;
			stream.off("data", onData);

			requests.push(decodeRunRequest(pending));
			const response = responses[requests.length - 1];
			if (!response) {
				stream.respond({ ":status": 500 });
				stream.end();
				return;
			}

			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			if (response.kind === "success") {
				stream.end(Buffer.concat([textDeltaFrame(response.text), turnEndedFrame()]));
				return;
			}
			if (response.kind === "exec-success") {
				stream.end(Buffer.concat([execReadRequestFrame(), turnEndedFrame()]));
				return;
			}
			const frames: Buffer[] = response.heartbeat ? [heartbeatFrame()] : [];
			if (response.partialText) frames.push(textDeltaFrame(response.partialText));
			frames.push(connectErrorFrame(response.code, response.message));
			stream.end(Buffer.concat(frames));
		};
		stream.on("data", onData);
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected fallback fixture to bind a TCP port");
	return `http://127.0.0.1:${address.port}`;
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "gpt-5.6-sol",
		requestModelId: "gpt-5.6-sol-none",
		name: "GPT-5.6 Sol",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	} satisfies ModelSpec<"cursor-agent">);
}

const context: Context = {
	messages: [{ role: "user", content: "Reply only: OK", timestamp: 1 }],
};

async function runStream(baseUrl: string): Promise<{ events: string[]; result: AssistantMessage }> {
	const stream = streamCursor(makeModel(baseUrl), context, {
		apiKey: "test-token",
		sessionId: crypto.randomUUID(),
		wireModelId: "gpt-5.6-sol-medium",
	});
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	return { events, result: await stream.result() };
}

async function stopServer(): Promise<void> {
	for (const session of sessions) session.destroy();
	sessions.clear();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => {
		if (error) closed.reject(error);
		else closed.resolve();
	});
	await closed.promise;
}

afterEach(async () => {
	responses = [];
	requests = [];
	await stopServer();
});

describe("Cursor discovered effort wire fallback", () => {
	it("retries clean not_found once with the exact discovered sibling id", async () => {
		responses = [
			{ kind: "error", code: "not_found", message: "normalized unavailable" },
			{ kind: "success", text: "OK" },
		];
		const { events, result } = await runStream(await startServer());

		expect(events.filter(event => event === "start")).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(requests[0].requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(requests[0].requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "medium" }),
		]);
		expect(requests[1].requestedModel?.modelId).toBe("gpt-5.6-sol-medium");
		expect(requests[1].requestedModel?.parameters).toEqual([]);
		expect(requests[1].modelDetails?.modelId).toBe("gpt-5.6-sol-medium");
	});

	it("still retries when a heartbeat precedes clean not_found", async () => {
		responses = [
			{ kind: "error", code: "not_found", message: "normalized unavailable", heartbeat: true },
			{ kind: "success", text: "OK" },
		];
		const { result } = await runStream(await startServer());

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(requests[1].requestedModel?.modelId).toBe("gpt-5.6-sol-medium");
	});

	it.each([
		["permission_denied", "authentication"],
		["resource_exhausted", "quota"],
		["unavailable", "network"],
	])("does not retry %s %s errors", async code => {
		responses = [{ kind: "error", code, message: "terminal" }];
		const { result } = await runStream(await startServer());

		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(1);
	});

	it("attempts the discovered sibling at most once", async () => {
		responses = [
			{ kind: "error", code: "not_found", message: "normalized unavailable" },
			{ kind: "error", code: "not_found", message: "sibling unavailable" },
		];
		const { result } = await runStream(await startServer());

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("sibling unavailable");
		expect(requests).toHaveLength(2);
	});

	it("does not retry after partial server output", async () => {
		responses = [{ kind: "error", code: "not_found", message: "late failure", partialText: "partial" }];
		const { result } = await runStream(await startServer());

		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "partial" })]);
		expect(requests).toHaveLength(1);
	});

	it("does not retry when onPayload changes the normalized effort model", async () => {
		responses = [{ kind: "error", code: "not_found", message: "hook model unavailable" }];
		const baseUrl = await startServer();
		let hookCalls = 0;
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			sessionId: crypto.randomUUID(),
			wireModelId: "gpt-5.6-sol-medium",
			onPayload: payload => {
				hookCalls++;
				if (!isAgentRunRequest(payload)) throw new Error("expected Cursor AgentRunRequest payload");
				return {
					...payload,
					requestedModel: payload.requestedModel
						? { ...payload.requestedModel, modelId: "hook-selected-model" }
						: undefined,
					modelDetails: payload.modelDetails
						? { ...payload.modelDetails, modelId: "hook-selected-model" }
						: undefined,
				};
			},
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(hookCalls).toBe(1);
		expect(requests).toHaveLength(1);
		expect(requests[0].requestedModel?.modelId).toBe("hook-selected-model");
	});

	it("forwards fallback exec busy state to the watched outer stream", async () => {
		responses = [{ kind: "error", code: "not_found", message: "normalized unavailable" }, { kind: "exec-success" }];
		const baseUrl = await startServer();
		const execStarted = Promise.withResolvers<void>();
		const releaseExec = Promise.withResolvers<void>();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			sessionId: crypto.randomUUID(),
			wireModelId: "gpt-5.6-sol-medium",
			execHandlers: {
				async read() {
					execStarted.resolve();
					await releaseExec.promise;
					return {
						role: "toolResult",
						toolCallId: "call-fallback",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
		});
		const drain = (async () => {
			for await (const _event of stream) {
				// drain
			}
			return stream.result();
		})();

		await execStarted.promise;
		expect(stream.hasPendingLocalWork).toBe(true);
		releaseExec.resolve();
		const result = await drain;

		expect(result.stopReason).toBe("stop");
		expect(stream.hasPendingLocalWork).toBe(false);
		expect(requests).toHaveLength(2);
	});
});
