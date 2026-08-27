import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { streamCursor } from "@oh-my-soup/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-soup/pi-ai/types";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	type InteractionUpdate,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-soup/pi-catalog/discovery/cursor-gen/agent_pb";

// A bare resource_exhausted before any token poisons Cursor's server-side
// conversation ID. The next turn must use a fresh wire ID while preserving the
// caller's stable session ID.

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();

function frameConnectMessage(data: Uint8Array): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function interactionFrame(message: InteractionUpdate["message"]): Buffer {
	return frameConnectMessage(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, { message }),
				},
			}),
		),
	);
}

function decodeConversationId(chunk: Buffer): string | undefined {
	const message = fromBinary(AgentClientMessageSchema, chunk.subarray(5));
	return message.message.case === "runRequest" ? message.message.value.conversationId : undefined;
}

type WireRequest = {
	conversationId?: string;
	action?: string;
	pendingToolCalls: number;
};

function decodeRunRequest(chunk: Buffer): WireRequest | undefined {
	const message = fromBinary(AgentClientMessageSchema, chunk.subarray(5));
	if (message.message.case !== "runRequest") return undefined;
	const request = message.message.value;
	return {
		conversationId: request.conversationId,
		action: request.action?.action.case,
		pendingToolCalls: request.conversationState?.pendingToolCalls.length ?? 0,
	};
}

function resumeContext(): Context {
	return {
		messages: [
			{ role: "user", content: "Use the read tool.", timestamp: 1 },
			{
				role: "assistant",
				api: "cursor-agent",
				provider: "cursor",
				model: "cursor-rotation-fixture",
				content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "package.json" } }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				content: [{ type: "text", text: "package contents" }],
				isError: false,
				timestamp: 3,
			},
		],
	};
}

async function startServer(seenConversationIds: string[]): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	let requestCount = 0;
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.on("data", (chunk: Buffer) => {
			const conversationId = decodeConversationId(chunk);
			if (conversationId !== undefined) seenConversationIds.push(conversationId);
			requestCount++;
			if (requestCount === 1) {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
				stream.once("wantTrailers", () => {
					stream.sendTrailers({ "grpc-status": "8", "grpc-message": "resource_exhausted" });
				});
				stream.end();
				return;
			}

			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(
				interactionFrame({
					case: "textDelta",
					value: create(TextDeltaUpdateSchema, { text: "recovered" }),
				}),
			);
			stream.write(interactionFrame({ case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) }));
			stream.end();
		});
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected the fixture server to bind a tcp port");
	return `http://127.0.0.1:${address.port}`;
}

async function startScriptedServer(seen: WireRequest[], script: Array<"reject" | "ok">): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	let requestCount = 0;
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.on("data", (chunk: Buffer) => {
			const decoded = decodeRunRequest(chunk);
			if (decoded) seen.push(decoded);
			const decision = script[Math.min(requestCount, script.length - 1)] ?? "reject";
			requestCount++;
			if (decision === "reject") {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
				stream.once("wantTrailers", () => {
					stream.sendTrailers({ "grpc-status": "8", "grpc-message": "resource_exhausted" });
				});
				stream.end();
				return;
			}
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.end(
				Buffer.concat([
					interactionFrame({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "recovered" }) }),
					interactionFrame({ case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) }),
				]),
			);
		});
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected scripted fixture to bind a TCP port");
	return `http://127.0.0.1:${address.port}`;
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

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-rotation-fixture",
		name: "Cursor rotation fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

async function runToEnd(
	baseUrl: string,
	sessionId: string,
	ctx: Context = context,
): Promise<{ type: "done" | "error"; message?: string }> {
	const stream = streamCursor(makeModel(baseUrl), ctx, { apiKey: "test-token", sessionId });
	let terminal: { type: "done" | "error"; message?: string } = { type: "done" };
	for await (const event of stream) {
		if (event.type === "error") terminal = { type: "error", message: event.error.errorMessage };
	}
	await stream.result().catch(() => undefined);
	return terminal;
}

afterEach(stopServer);

describe("Cursor conversation ID rotation", () => {
	it("rotates a poisoned wire ID and recovers on the next turn", async () => {
		const seenConversationIds: string[] = [];
		const baseUrl = await startServer(seenConversationIds);

		const first = await runToEnd(baseUrl, "sess-poisoned");
		expect(first.type).toBe("error");
		expect(first.message).toMatch(/resource.?exhausted/i);

		const second = await runToEnd(baseUrl, "sess-poisoned");
		expect(second.type).toBe("done");
		expect(seenConversationIds).toHaveLength(2);
		expect(seenConversationIds[0]).toBe("sess-poisoned");
		expect(seenConversationIds[1]).not.toBe(seenConversationIds[0]);
	});

	it("rebuilds a rotated resume turn without stale checkpoint or tool state", async () => {
		const seen: WireRequest[] = [];
		const baseUrl = await startScriptedServer(seen, ["reject", "ok"]);
		const ctx = resumeContext();

		const first = await runToEnd(baseUrl, "sess-resume", ctx);
		expect(first.type).toBe("error");
		expect(first.message).toMatch(/resource.?exhausted/i);
		const second = await runToEnd(baseUrl, "sess-resume", ctx);
		expect(second.type).toBe("done");

		expect(seen).toHaveLength(2);
		expect(seen[0]?.conversationId).toBe("sess-resume");
		expect(seen[0]?.action).toBe("resumeAction");
		expect(seen[1]?.conversationId).not.toBe(seen[0]?.conversationId);
		expect(seen[1]?.action).toBe("userMessageAction");
		expect(seen[1]?.pendingToolCalls).toBe(0);
	});

	it("rotates again after a recovered replacement is poisoned later", async () => {
		const seen: WireRequest[] = [];
		const baseUrl = await startScriptedServer(seen, ["reject", "ok", "reject", "ok"]);

		expect((await runToEnd(baseUrl, "sess-rerotate")).type).toBe("error");
		expect((await runToEnd(baseUrl, "sess-rerotate")).type).toBe("done");
		expect((await runToEnd(baseUrl, "sess-rerotate")).type).toBe("error");
		expect((await runToEnd(baseUrl, "sess-rerotate")).type).toBe("done");

		expect(seen).toHaveLength(4);
		expect(seen[0]?.conversationId).toBe("sess-rerotate");
		expect(seen[1]?.conversationId).not.toBe(seen[0]?.conversationId);
		expect(seen[2]?.conversationId).toBe(seen[1]?.conversationId);
		expect(seen[3]?.conversationId).not.toBe(seen[1]?.conversationId);
		expect(seen[3]?.conversationId).not.toBe(seen[0]?.conversationId);
	});
});
