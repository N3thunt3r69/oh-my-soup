/**
 * Contracts: SessionObserverRegistry terminal-row retention.
 *
 * The registry outlives every subagent (rows feed the HUD history, Agent Hub,
 * and transcript stats), so a terminal row must keep only scalar metrics —
 * not the run-sized payloads the last live snapshot carries
 * (`extractedToolData` grows with every nested task/yield of the run;
 * `inflightTaskDetails` holds a whole nested batch tree).
 *
 * 1. A terminal lifecycle event slims the retained progress snapshot.
 * 2. A late progress event landing on an already-terminal row is stored
 *    slimmed too (executor flushes can race the lifecycle event).
 * 3. Active rows keep the full live snapshot.
 */
import { describe, expect, it } from "bun:test";
import { SessionObserverRegistry } from "@oh-my-soup/pi-coding-agent/modes/session-observer-registry";
import type { AgentProgress } from "@oh-my-soup/pi-coding-agent/task";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-soup/pi-coding-agent/task";
import { EventBus } from "@oh-my-soup/pi-coding-agent/utils/event-bus";

function makeProgress(id: string, overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "investigate the thing",
		assignment: "long assignment body",
		description: "Investigating",
		lastIntent: "Reading files",
		recentTools: [{ tool: "read", args: "foo.ts", endMs: 1 }],
		recentOutput: ["line one", "line two"],
		toolCount: 7,
		requests: 3,
		tokens: 1234,
		contextTokens: 456,
		contextWindow: 200_000,
		cost: 0.5,
		durationMs: 999,
		modelRole: "scout",
		resolvedModel: "anthropic/claude-sonnet-4-5",
		extractedToolData: { task: [{ projectAgentsDir: null, results: [], totalDurationMs: 1 }] },
		inflightTaskDetails: { projectAgentsDir: null, results: [], totalDurationMs: 2 },
		...overrides,
	};
}

function setup(): { bus: EventBus; registry: SessionObserverRegistry } {
	const bus = new EventBus();
	const registry = new SessionObserverRegistry();
	registry.subscribeToEventBus(bus);
	return { bus, registry };
}

function emitProgress(bus: EventBus, progress: AgentProgress): void {
	bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
		index: progress.index,
		agent: progress.agent,
		agentSource: progress.agentSource,
		task: progress.task,
		progress,
	});
}

function emitLifecycle(bus: EventBus, id: string, status: "started" | "completed" | "failed" | "aborted"): void {
	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id,
		agent: "task",
		agentSource: "bundled",
		status,
		index: 0,
	});
}

describe("SessionObserverRegistry terminal retention", () => {
	it("slims the retained snapshot when the row goes terminal, keeping scalar metrics", () => {
		const { bus, registry } = setup();
		emitLifecycle(bus, "A1", "started");
		emitProgress(bus, makeProgress("A1"));

		// Live row keeps the full snapshot by reference.
		expect(registry.getSession("A1")?.progress?.extractedToolData).toBeDefined();
		expect(registry.getSession("A1")?.progress?.recentOutput).toHaveLength(2);

		emitLifecycle(bus, "A1", "completed");

		const retained = registry.getSession("A1")?.progress;
		expect(retained).toBeDefined();
		expect(retained?.extractedToolData).toBeUndefined();
		expect(retained?.inflightTaskDetails).toBeUndefined();
		expect(retained?.recentOutput).toEqual([]);
		expect(retained?.recentTools).toEqual([]);
		// The surfaces reading terminal rows (Agent Hub detail line, transcript
		// stats) still see their fields.
		expect(retained?.tokens).toBe(1234);
		expect(retained?.cost).toBe(0.5);
		expect(retained?.toolCount).toBe(7);
		expect(retained?.durationMs).toBe(999);
		expect(retained?.contextTokens).toBe(456);
		expect(retained?.modelRole).toBe("scout");
		expect(retained?.resolvedModel).toBe("anthropic/claude-sonnet-4-5");
		expect(retained?.task).toBe("investigate the thing");
		expect(registry.getSession("A1")?.status).toBe("completed");
	});

	it("caps the retained task-prompt preview on terminal rows", () => {
		const { bus, registry } = setup();
		const longTask = "x".repeat(10_000);
		emitProgress(bus, makeProgress("A2", { task: longTask }));
		emitLifecycle(bus, "A2", "failed");

		const retained = registry.getSession("A2")?.progress;
		expect(retained?.task.length).toBeLessThanOrEqual(2049);
		expect(retained?.task.startsWith("xxx")).toBe(true);
	});

	it("stores a late progress event on a terminal row slimmed", () => {
		const { bus, registry } = setup();
		emitProgress(bus, makeProgress("A3"));
		emitLifecycle(bus, "A3", "completed");

		// Executor flush racing the lifecycle event: lands after terminal.
		emitProgress(bus, makeProgress("A3", { status: "completed", tokens: 5678 }));

		const retained = registry.getSession("A3")?.progress;
		expect(retained?.tokens).toBe(5678);
		expect(retained?.extractedToolData).toBeUndefined();
		expect(retained?.inflightTaskDetails).toBeUndefined();
		expect(retained?.recentOutput).toEqual([]);
	});

	it("keeps the full snapshot on active rows", () => {
		const { bus, registry } = setup();
		const progress = makeProgress("A4");
		emitProgress(bus, progress);

		const retained = registry.getSession("A4")?.progress;
		expect(retained).toBe(progress);
		expect(retained?.extractedToolData).toBeDefined();
		expect(retained?.inflightTaskDetails).toBeDefined();
	});
});
