import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-soup/pi-coding-agent/cli/args";
import { LiveStream, type LiveStreamSession } from "@oh-my-soup/pi-coding-agent/modes/live-stream";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});

class JsonLineReader {
	#buffer = "";
	#frames: unknown[] = [];
	#waiting: (() => void) | undefined;

	constructor(socket: net.Socket) {
		socket.on("data", chunk => {
			this.#buffer += chunk.toString();
			let newline = this.#buffer.indexOf("\n");
			while (newline !== -1) {
				this.#frames.push(JSON.parse(this.#buffer.slice(0, newline)));
				this.#buffer = this.#buffer.slice(newline + 1);
				this.#waiting?.();
				this.#waiting = undefined;
				newline = this.#buffer.indexOf("\n");
			}
		});
	}

	async next(): Promise<unknown> {
		while (this.#frames.length === 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiting = resolve;
			await promise;
		}
		return this.#frames.shift();
	}
}

async function connect(socketPath: string): Promise<{ socket: net.Socket; reader: JsonLineReader }> {
	const socket = net.createConnection(socketPath);
	const reader = new JsonLineReader(socket);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	socket.once("connect", resolve);
	socket.once("error", reject);
	await promise;
	return { socket, reader };
}

describe("--stream", () => {
	it("publishes live events and an append-only session journal to separate local sockets", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "oms-live-stream-"));
		tempDirs.push(root);
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const eventListeners = new Set<Parameters<LiveStreamSession["subscribe"]>[0]>();
		const sessionChangeListeners = new Set<() => void>();
		const session: LiveStreamSession = {
			sessionManager,
			subscribe(listener) {
				eventListeners.add(listener);
				return () => eventListeners.delete(listener);
			},
			registerSessionChangeCallback(listener) {
				sessionChangeListeners.add(listener);
				return () => sessionChangeListeners.delete(listener);
			},
		};

		const liveDirectory = path.join(root, "live");
		await fs.mkdir(liveDirectory);
		await Bun.write(path.join(liveDirectory, "occupied"), "x");
		await expect(LiveStream.create(liveDirectory, session)).rejects.toThrow("Stream directory must be empty");
		await fs.unlink(path.join(liveDirectory, "occupied"));
		const stream = await LiveStream.create(liveDirectory, session);
		const chat = await connect(stream.paths.chat);
		const journal = await connect(stream.paths.session);

		await expect(chat.reader.next()).resolves.toMatchObject({ type: "session", sessionId: sessionManager.getSessionId() });
		await expect(journal.reader.next()).resolves.toMatchObject({
			type: "session",
			sessionId: sessionManager.getSessionId(),
			header: { id: sessionManager.getSessionId() },
			entries: [],
		});

		sessionManager.appendMessage({ role: "user", content: "stream this", timestamp: Date.now() });
		await expect(journal.reader.next()).resolves.toMatchObject({
			type: "entry",
			entry: { type: "message", message: { role: "user", content: "stream this" } },
		});

		for (const listener of eventListeners) listener({ type: "notice", level: "info", message: "ready" });
		await expect(chat.reader.next()).resolves.toEqual({
			type: "event",
			event: { type: "notice", level: "info", message: "ready" },
		});

		chat.socket.destroy();
		journal.socket.destroy();
		await stream.close();
		await expect(fs.stat(stream.paths.chat)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(stream.paths.session)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("parses --stream as a directory-valued launch option", () => {
		const parsed = parseArgs(["--stream", "/tmp/oms-live", "hello"]);
		expect(parsed.stream).toBe("/tmp/oms-live");
		expect(parsed.messages).toEqual(["hello"]);
		expect(parseArgs(["-S", "/tmp/oms-live"]).stream).toBe("/tmp/oms-live");
		expect(parseArgs(["--history", "/tmp/oms-history"]).history).toBe("/tmp/oms-history");
		expect(parseArgs(["-H", "/tmp/oms-history"]).history).toBe("/tmp/oms-history");
		expect(() => parseArgs(["--stream="])).toThrow("--stream requires a non-empty directory");
		expect(() => parseArgs(["--history="])).toThrow("--history requires a non-empty directory");
	});
});
