import { describe, expect, it } from "bun:test";
import {
	buildGoalGateFailureContinuation,
	createGoalGateState,
	GOAL_GATE_UNCHANGED_EXIT_TEXT,
	type GoalGateExec,
	type GoalGateExecResult,
	runGoalGates,
} from "@oh-my-pi/pi-coding-agent/goals/gates";
import { GoalRuntime, type GoalRuntimeHost } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { GoalModeState, GoalTokenUsage } from "@oh-my-pi/pi-coding-agent/goals/state";

function execResult(overrides: Partial<GoalGateExecResult> = {}): GoalGateExecResult {
	return { status: 0, signal: null, stdout: "", stderr: "", ...overrides };
}

interface FakeExec {
	exec: GoalGateExec;
	calls: string[];
}

function createFakeExec(results: Record<string, GoalGateExecResult[]>): FakeExec {
	const calls: string[] = [];
	return {
		calls,
		exec: async command => {
			calls.push(command);
			const queue = results[command];
			const next = queue?.length ? queue.shift() : undefined;
			return next ?? execResult();
		},
	};
}

function snapshotSequence(...hashes: (string | undefined)[]) {
	let index = 0;
	return async () => (index < hashes.length ? hashes[index++] : hashes[hashes.length - 1]);
}

describe("runGoalGates", () => {
	it("passes when every command exits 0 and clears failure state", async () => {
		const state = createGoalGateState();
		state.lastFailure = { command: "a", attempt: 1, exitText: "exited 1", output: "old" };
		state.lastFailureSnapshot = "stale";
		const fake = createFakeExec({});
		const outcome = await runGoalGates(["a", "b"], state, {
			cwd: "/repo",
			exec: fake.exec,
			captureSnapshot: snapshotSequence("s1"),
		});
		expect(outcome).toBe("passed");
		expect(fake.calls).toEqual(["a", "b"]);
		expect(state.lastFailure).toBeUndefined();
		expect(state.lastFailureSnapshot).toBeUndefined();
		expect(state.attempts).toEqual({ a: 0, b: 0 });
	});

	it("captures failing gate output and stops at the first failure", async () => {
		const state = createGoalGateState();
		const fake = createFakeExec({
			bad: [execResult({ status: 1, stdout: "3 tests failed", stderr: "boom" })],
		});
		const outcome = await runGoalGates(["bad", "never"], state, {
			cwd: "/repo",
			exec: fake.exec,
			captureSnapshot: snapshotSequence("s1", "s2"),
		});
		expect(outcome).toBe("failed");
		expect(fake.calls).toEqual(["bad"]);
		expect(state.lastFailure).toMatchObject({
			command: "bad",
			attempt: 1,
			exitText: "exited 1",
			output: "3 tests failed\nboom",
		});
		expect(state.lastFailureSnapshot).toBe("s2");
	});

	it("returns failed without a cwd", async () => {
		const state = createGoalGateState();
		const fake = createFakeExec({});
		expect(await runGoalGates(["a"], state, { exec: fake.exec })).toBe("failed");
		expect(fake.calls).toEqual([]);
	});

	it("skips the rerun when the worktree is unchanged since the last failure", async () => {
		const state = createGoalGateState();
		const fake = createFakeExec({
			bad: [execResult({ status: 1, stdout: "fail" })],
		});
		// First run: pre-snapshot s1, post-run snapshot s1 (gate did not mutate the tree).
		const first = await runGoalGates(["bad"], state, {
			cwd: "/repo",
			exec: fake.exec,
			captureSnapshot: snapshotSequence("s1", "s1"),
		});
		expect(first).toBe("failed");
		expect(state.lastFailure?.attempt).toBe(1);
		// Second run: worktree still hashes to s1 → gate must NOT rerun.
		const second = await runGoalGates(["bad"], state, {
			cwd: "/repo",
			exec: fake.exec,
			captureSnapshot: snapshotSequence("s1"),
		});
		expect(second).toBe("failed");
		expect(fake.calls).toEqual(["bad"]);
		expect(state.lastFailure?.attempt).toBe(2);
		expect(state.lastFailure?.exitText).toBe(GOAL_GATE_UNCHANGED_EXIT_TEXT);
		expect(state.lastFailure?.output).toContain("workspace has not changed");
	});

	it("reruns the gate when the worktree changed after a failure", async () => {
		const state = createGoalGateState();
		const fake = createFakeExec({
			bad: [execResult({ status: 1, stdout: "fail" }), execResult({ status: 0 })],
		});
		await runGoalGates(["bad"], state, {
			cwd: "/repo",
			exec: fake.exec,
			captureSnapshot: snapshotSequence("s1", "s1"),
		});
		const second = await runGoalGates(["bad"], state, {
			cwd: "/repo",
			exec: fake.exec,
			captureSnapshot: snapshotSequence("s2", "s2"),
		});
		expect(second).toBe("passed");
		expect(fake.calls).toEqual(["bad", "bad"]);
		expect(state.lastFailure).toBeUndefined();
	});

	it("does not dedup when snapshots are unavailable", async () => {
		const state = createGoalGateState();
		const fake = createFakeExec({
			bad: [execResult({ status: 1 }), execResult({ status: 1 })],
		});
		await runGoalGates(["bad"], state, {
			cwd: "/repo",
			exec: fake.exec,
			captureSnapshot: snapshotSequence(undefined),
		});
		await runGoalGates(["bad"], state, {
			cwd: "/repo",
			exec: fake.exec,
			captureSnapshot: snapshotSequence(undefined),
		});
		expect(fake.calls).toEqual(["bad", "bad"]);
	});

	it("exhausts retries after maxRetries failed attempts", async () => {
		const state = createGoalGateState();
		const fake = createFakeExec({
			bad: [execResult({ status: 1 }), execResult({ status: 1 }), execResult({ status: 1 })],
		});
		const options = (run: number) => ({
			cwd: "/repo",
			maxRetries: 2,
			exec: fake.exec,
			captureSnapshot: snapshotSequence(`pre${run}`, `post${run}`),
		});
		expect(await runGoalGates(["bad"], state, options(1))).toBe("failed");
		expect(await runGoalGates(["bad"], state, options(2))).toBe("failed");
		expect(await runGoalGates(["bad"], state, options(3))).toBe("retry_exhausted");
		expect(state.lastFailure?.attempt).toBe(3);
	});

	it("runs real shell gates: exit 1 fails, exit 0 passes", async () => {
		const state = createGoalGateState();
		const noSnapshot = async () => undefined;
		const failed = await runGoalGates(["exit 1"], state, {
			cwd: process.cwd(),
			captureSnapshot: noSnapshot,
		});
		expect(failed).toBe("failed");
		expect(state.lastFailure?.exitText).toBe("exited 1");
		const passed = await runGoalGates(["exit 0"], state, {
			cwd: process.cwd(),
			captureSnapshot: noSnapshot,
		});
		expect(passed).toBe("passed");
	});
});

describe("buildGoalGateFailureContinuation", () => {
	it("feeds the gate output verbatim into the continuation prompt", () => {
		const text = buildGoalGateFailureContinuation(
			{ command: "bun test", attempt: 2, exitText: "exited 1", output: "expected 3 to be 4" },
			3,
			0,
		);
		expect(text).toContain("Goal quality gate failed (attempt 2/3): `bun test` exited 1.");
		expect(text).toContain("Output:\nexpected 3 to be 4");
		expect(text).toContain("Continue working. Fix the failure");
	});
});

interface RuntimeHarness {
	runtime: GoalRuntime;
	fake: FakeExec;
	setSnapshot(hash: string | undefined): void;
	getState(): GoalModeState | undefined;
}

function createRuntimeHarness(results: Record<string, GoalGateExecResult[]>, maxRetries = 3): RuntimeHarness {
	let state: GoalModeState | undefined;
	let snapshot: string | undefined = "s1";
	const usage: GoalTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const fake = createFakeExec(results);
	const host: GoalRuntimeHost = {
		getState: () => state,
		setState: next => {
			state = next;
		},
		getCurrentUsage: () => ({ ...usage }),
		emit: () => {},
		persist: () => {},
		sendHiddenMessage: async () => {},
		now: () => 1_000,
		gateContext: () => ({
			cwd: "/repo",
			maxRetries,
			exec: fake.exec,
			captureSnapshot: async () => snapshot,
		}),
	};
	return {
		runtime: new GoalRuntime(host),
		fake,
		setSnapshot: hash => {
			snapshot = hash;
		},
		getState: () => state,
	};
}

describe("GoalRuntime quality gates", () => {
	it("feeds failing gate output into the continuation prompt", async () => {
		const harness = createRuntimeHarness({
			"bun test": [execResult({ status: 1, stdout: "1 fail" })],
		});
		await harness.runtime.createGoal({ objective: "ship it", gates: ["bun test"] });
		const prompt = await harness.runtime.buildGateAwareContinuationPrompt();
		expect(prompt).toContain("Goal quality gate failed (attempt 1/3): `bun test` exited 1.");
		expect(prompt).toContain("1 fail");
	});

	it("steers with the unchanged-workspace message instead of rerunning gates", async () => {
		const harness = createRuntimeHarness({
			"bun test": [execResult({ status: 1, stdout: "1 fail" })],
		});
		await harness.runtime.createGoal({ objective: "ship it", gates: ["bun test"] });
		await harness.runtime.buildGateAwareContinuationPrompt();
		const prompt = await harness.runtime.buildGateAwareContinuationPrompt();
		expect(harness.fake.calls).toEqual(["bun test"]);
		expect(prompt).toContain(GOAL_GATE_UNCHANGED_EXIT_TEXT);
		expect(prompt).toContain("workspace has not changed");
	});

	it("falls back to the normal continuation prompt when gates pass", async () => {
		const harness = createRuntimeHarness({});
		await harness.runtime.createGoal({ objective: "ship the gates", gates: ["bun test"] });
		const prompt = await harness.runtime.buildGateAwareContinuationPrompt();
		expect(prompt).toContain("ship the gates");
		expect(prompt).not.toContain("quality gate failed");
	});

	it("stops auto-continuation once gate retries are exhausted", async () => {
		const harness = createRuntimeHarness({ "bun test": [execResult({ status: 1 }), execResult({ status: 1 })] }, 1);
		await harness.runtime.createGoal({ objective: "ship it", gates: ["bun test"] });
		harness.setSnapshot("s1");
		expect(await harness.runtime.buildGateAwareContinuationPrompt()).toContain("attempt 1/1");
		harness.setSnapshot("s2");
		expect(await harness.runtime.buildGateAwareContinuationPrompt()).toBeUndefined();
	});

	it("blocks goal completion while a gate fails and allows it after gates pass", async () => {
		const harness = createRuntimeHarness({
			"bun test": [execResult({ status: 1, stdout: "1 fail" }), execResult({ status: 0 })],
		});
		await harness.runtime.createGoal({ objective: "ship it", gates: ["bun test"] });
		expect(harness.runtime.completeGoalFromTool()).rejects.toThrow(/cannot complete goal/);
		harness.setSnapshot("s2");
		const completed = await harness.runtime.completeGoalFromTool();
		expect(completed.status).toBe("complete");
	});

	it("ignores gates on goals without any configured", async () => {
		const harness = createRuntimeHarness({});
		await harness.runtime.createGoal({ objective: "plain goal" });
		expect(await harness.runtime.runGates()).toBeUndefined();
		expect(harness.fake.calls).toEqual([]);
	});
});
