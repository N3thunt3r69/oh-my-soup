import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-soup/pi-coding-agent/registry/agent-registry";
import { renderIrcPeerRoster } from "@oh-my-soup/pi-coding-agent/task/executor";
import {
	DEFAULT_HUB_LIST_LIMIT,
	executeList,
	MAX_HUB_LIST_LIMIT,
} from "@oh-my-soup/pi-coding-agent/tools/hub/messaging";
import { TempDir } from "@oh-my-soup/pi-utils";

describe("hub list", () => {
	it("restores persisted peers after the process registry is lost", async () => {
		using tempDir = TempDir.createSync("@oms-hub-list-persisted-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});

		const listed = await executeList(registry, MAIN_AGENT_ID);
		if (!listed.details) throw new Error("Expected coordination details");
		expect(listed.details.peers).toEqual([]);
		expect(listed.details.counts).toEqual({
			running: 0,
			idle: 0,
			parked: 1,
			shown: 0,
			truncated: 0,
		});

		const parked = await executeList(registry, MAIN_AGENT_ID, { status: "parked" });
		if (!parked.details) throw new Error("Expected coordination details");
		expect(parked.details.peers).toEqual([
			expect.objectContaining({
				id: "Worker",
				kind: "sub",
				status: "parked",
				parentId: MAIN_AGENT_ID,
			}),
		]);
		const content = parked.content[0];
		if (content?.type !== "text") throw new Error("Expected text result");
		expect(content.text).toContain("Worker");
		expect(registry.get("Worker")?.sessionFile).toBe(workerSessionFile);
	});

	it("bounds live and parked pages", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		for (let index = 0; index < DEFAULT_HUB_LIST_LIMIT + 5 + MAX_HUB_LIST_LIMIT + 5; index++) {
			registry.register({
				id: `Peer${index}`,
				displayName: "task",
				kind: "sub",
				session: null,
				status: index < DEFAULT_HUB_LIST_LIMIT + 5 ? "idle" : "parked",
				lastActivity: index,
			});
		}

		const live = await executeList(registry, MAIN_AGENT_ID);
		expect(live.details?.peers).toHaveLength(DEFAULT_HUB_LIST_LIMIT);
		expect(live.details?.counts?.truncated).toBe(5);

		const parked = await executeList(registry, MAIN_AGENT_ID, { status: "parked", limit: 500 });
		expect(parked.details?.peers).toHaveLength(MAX_HUB_LIST_LIMIT);
		expect(parked.details?.counts?.truncated).toBe(5);
	});

	it("bounds the roster embedded in a subagent system prompt", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		for (let index = 0; index < DEFAULT_HUB_LIST_LIMIT + 5; index++) {
			registry.register({
				id: `Peer${index}`,
				displayName: "task",
				kind: "sub",
				session: null,
				status: "idle",
				lastActivity: index,
			});
		}

		const roster = await renderIrcPeerRoster(MAIN_AGENT_ID, registry);
		expect(roster).toContain(`Peer${DEFAULT_HUB_LIST_LIMIT + 4}`);
		expect(roster).not.toContain("`Peer0`");
		expect(roster).toContain("5 additional live peer(s) omitted");
	});

	it("restores each newly selected session root", async () => {
		using tempDir = TempDir.createSync("@oms-hub-list-session-switch-");
		const firstRoot = path.join(tempDir.path(), "first.jsonl");
		const secondRoot = path.join(tempDir.path(), "second.jsonl");
		await Bun.write(firstRoot, "");
		await Bun.write(secondRoot, "");
		const firstWorker = path.join(tempDir.path(), "first", "Worker.jsonl");
		const secondWorker = path.join(tempDir.path(), "second", "Worker.jsonl");
		await Bun.write(firstWorker, "");
		await Bun.write(secondWorker, "");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile: firstRoot,
			status: "running",
		});

		await executeList(registry, MAIN_AGENT_ID, { status: "parked" }, firstRoot);
		const switched = await executeList(registry, MAIN_AGENT_ID, { status: "parked" }, secondRoot);
		expect(switched.details?.peers?.map(peer => peer.id)).toEqual(["Worker"]);
		expect(switched.details?.counts?.parked).toBe(1);
		expect(registry.get("Worker")?.sessionFile).toBe(secondWorker);
	});
});
