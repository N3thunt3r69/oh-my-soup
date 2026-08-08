import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	nextFireAfter,
	parseHeartbeatArgs,
	parseScheduledPromptSchedule,
	SCHEDULED_PROMPTS_FILENAME,
	type ScheduledPromptJob,
	ScheduledPromptStore,
} from "@oh-my-pi/pi-coding-agent/session/scheduled-prompts";

const cleanup: string[] = [];

function makeStore(): { store: ScheduledPromptStore; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-scheduled-prompts-"));
	cleanup.push(dir);
	const file = path.join(dir, SCHEDULED_PROMPTS_FILENAME);
	return { store: new ScheduledPromptStore(file), file };
}

afterEach(() => {
	for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseScheduledPromptSchedule", () => {
	const now = new Date("2026-08-08T12:00:00Z");

	test("parses interval shorthand with minimum bound", () => {
		const { schedule, nextFireAt } = parseScheduledPromptSchedule("every 5m", now);
		expect(schedule.kind).toBe("interval");
		expect(schedule.intervalMs).toBe(5 * 60_000);
		expect(nextFireAt.getTime()).toBe(now.getTime() + 5 * 60_000);
		expect(() => parseScheduledPromptSchedule("every 5s", now)).toThrow(/at least 10 seconds/);
	});

	test("parses one-shot 'in' and 'at' schedules", () => {
		const inParsed = parseScheduledPromptSchedule("in 2h", now);
		expect(inParsed.schedule.kind).toBe("once");
		expect(inParsed.nextFireAt.getTime()).toBe(now.getTime() + 2 * 60 * 60_000);

		const atParsed = parseScheduledPromptSchedule("at 2026-08-09T09:00:00Z", now);
		expect(atParsed.schedule.kind).toBe("once");
		expect(atParsed.nextFireAt.toISOString()).toBe("2026-08-09T09:00:00.000Z");
		expect(() => parseScheduledPromptSchedule("at 2020-01-01T00:00:00Z", now)).toThrow(/future/);
	});

	test("parses cron expressions and aliases", () => {
		const cron = parseScheduledPromptSchedule("30 9 * * *", now);
		expect(cron.schedule.kind).toBe("cron");
		expect(cron.nextFireAt.getMinutes()).toBe(30);
		expect(cron.nextFireAt.getHours()).toBe(9);
		expect(cron.nextFireAt.getTime()).toBeGreaterThan(now.getTime());

		const hourly = parseScheduledPromptSchedule("@hourly", now);
		expect(hourly.schedule.expression).toBe("0 * * * *");
		expect(hourly.nextFireAt.getMinutes()).toBe(0);
	});

	test("rejects garbage", () => {
		expect(() => parseScheduledPromptSchedule("whenever", now)).toThrow();
		expect(() => parseScheduledPromptSchedule("", now)).toThrow();
	});
});

describe("nextFireAfter", () => {
	const after = new Date("2026-08-08T12:34:00Z");

	test("once schedules never recur", () => {
		expect(nextFireAfter({ kind: "once", expression: "in 5m" }, after)).toBeUndefined();
	});

	test("interval schedules advance from the given time", () => {
		const next = nextFireAfter({ kind: "interval", expression: "every 5m", intervalMs: 300_000 }, after);
		expect(next?.getTime()).toBe(after.getTime() + 300_000);
	});

	test("cron schedules find the next matching minute strictly after", () => {
		const next = nextFireAfter({ kind: "cron", expression: "*/15 * * * *" }, after);
		expect(next).toBeDefined();
		expect(next!.getTime()).toBeGreaterThan(after.getTime());
		expect(next!.getMinutes() % 15).toBe(0);
	});
});

describe("parseHeartbeatArgs", () => {
	test("empty and 'status' report status", () => {
		expect(parseHeartbeatArgs("")).toEqual({ kind: "status" });
		expect(parseHeartbeatArgs("status")).toEqual({ kind: "status" });
	});

	test("bare interval shorthand becomes 'every N'", () => {
		const parsed = parseHeartbeatArgs("5m check CI");
		expect(parsed).toEqual({ kind: "set", scheduleText: "every 5m", prompt: "check CI" });
	});

	test("explicit every/in/at/cron schedules with delivery flags", () => {
		expect(parseHeartbeatArgs("every 10m poll the queue --steer")).toEqual({
			kind: "set",
			scheduleText: "every 10m",
			prompt: "poll the queue",
			deliveryMode: "steer",
		});
		expect(parseHeartbeatArgs("--follow-up in 1h remind me to stretch")).toEqual({
			kind: "set",
			scheduleText: "in 1h",
			prompt: "remind me to stretch",
			deliveryMode: "follow_up",
		});
		expect(parseHeartbeatArgs('"0 9 * * 1" weekly standup notes')).toEqual({
			kind: "set",
			scheduleText: "0 9 * * 1",
			prompt: "weekly standup notes",
		});
		expect(parseHeartbeatArgs("0 9 * * 1 weekly standup notes")).toEqual({
			kind: "set",
			scheduleText: "0 9 * * 1",
			prompt: "weekly standup notes",
		});
	});

	test("missing schedule or prompt is an error", () => {
		expect(() => parseHeartbeatArgs("check CI")).toThrow(/Usage/);
		expect(() => parseHeartbeatArgs("every 5m")).toThrow(/Usage/);
		expect(() => parseHeartbeatArgs("5m --deliver sideways x")).toThrow(/Delivery mode/);
	});
});

describe("ScheduledPromptStore", () => {
	test("round-trips jobs through the JSON file", () => {
		const { store, file } = makeStore();
		const job = store.create({
			sessionId: "s1",
			scheduleText: "every 5m",
			prompt: "check CI",
			label: "ci",
		});
		expect(fs.existsSync(file)).toBe(true);

		// A fresh store over the same file sees the identical job.
		const reloaded = new ScheduledPromptStore(file).listForSession("s1");
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]).toEqual(job);
		expect(reloaded[0]!.deliveryMode).toBe("follow_up");
		expect(new ScheduledPromptStore(file).listForSession("other")).toHaveLength(0);
	});

	test("update persists mutations", () => {
		const { store, file } = makeStore();
		const job = store.create({ sessionId: "s1", scheduleText: "every 5m", prompt: "x" });
		store.update(job.id, j => ({ ...j, status: "paused", nextFireAt: undefined }));
		const reloaded = new ScheduledPromptStore(file).listForSession("s1");
		expect(reloaded[0]!.status).toBe("paused");
		expect(reloaded[0]!.nextFireAt).toBeUndefined();
	});

	test("claimDue advances and persists before delivery (no duplicate fire after restart)", () => {
		const { store, file } = makeStore();
		const created = new Date("2026-08-08T12:00:00Z");
		const job = store.create({ sessionId: "s1", scheduleText: "every 5m", prompt: "x", now: created });

		const fireTime = new Date("2026-08-08T12:05:01Z");
		const claimed = store.claimDue("s1", fireTime);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]!.id).toBe(job.id);
		expect(claimed[0]!.runCount).toBe(1);
		expect(claimed[0]!.lastFiredAt).toBe(fireTime.toISOString());

		// Simulated restart: the persisted job is already advanced, so nothing is due.
		const restarted = new ScheduledPromptStore(file);
		expect(restarted.claimDue("s1", fireTime)).toHaveLength(0);
		const next = restarted.nextFireAt("s1");
		expect(next?.getTime()).toBe(fireTime.getTime() + 5 * 60_000);
	});

	test("catch-up fires once late and never storms", () => {
		const { store } = makeStore();
		const created = new Date("2026-08-08T12:00:00Z");
		store.create({ sessionId: "s1", scheduleText: "every 5m", prompt: "x", now: created });

		// Process was down for an hour: 12 slots were missed.
		const wake = new Date("2026-08-08T13:00:00Z");
		const claimed = store.claimDue("s1", wake);
		expect(claimed).toHaveLength(1); // one late fire, not twelve

		// Next occurrence is computed from wake time, not from the missed slots.
		expect(store.nextFireAt("s1")?.getTime()).toBe(wake.getTime() + 5 * 60_000);
		expect(store.claimDue("s1", wake)).toHaveLength(0);
	});

	test("one-shot jobs complete after firing", () => {
		const { store } = makeStore();
		const created = new Date("2026-08-08T12:00:00Z");
		store.create({ sessionId: "s1", scheduleText: "in 10m", prompt: "x", now: created });

		const wake = new Date("2026-08-08T14:00:00Z");
		const claimed = store.claimDue("s1", wake);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]!.status).toBe("completed");
		expect(store.nextFireAt("s1")).toBeUndefined();
		expect(store.claimDue("s1", wake)).toHaveLength(0);
	});

	test("paused and cancelled jobs never fire", () => {
		const { store } = makeStore();
		const created = new Date("2026-08-08T12:00:00Z");
		const a = store.create({ sessionId: "s1", scheduleText: "every 5m", prompt: "a", now: created });
		const b = store.create({ sessionId: "s1", scheduleText: "every 5m", prompt: "b", now: created });
		store.update(a.id, j => ({ ...j, status: "paused", nextFireAt: undefined }) as ScheduledPromptJob);
		store.update(b.id, j => ({ ...j, status: "cancelled", nextFireAt: undefined }) as ScheduledPromptJob);
		expect(store.claimDue("s1", new Date("2026-08-08T13:00:00Z"))).toHaveLength(0);
	});

	test("memory-only store works without a file path", () => {
		const store = new ScheduledPromptStore();
		const job = store.create({ sessionId: "s1", scheduleText: "every 5m", prompt: "x" });
		expect(store.listForSession("s1")).toHaveLength(1);
		expect(store.claimDue("s1", new Date(Date.now() + 6 * 60_000))).toHaveLength(1);
		expect(store.listForSession("s1")[0]!.runCount).toBe(1);
		expect(job.runCount).toBe(0); // snapshots are immutable
	});

	test("corrupt store file is treated as empty", () => {
		const { store, file } = makeStore();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{not json", "utf8");
		expect(store.load()).toEqual([]);
		// And a create over the corrupt file recovers by rewriting it.
		store.create({ sessionId: "s1", scheduleText: "every 5m", prompt: "x" });
		expect(store.listForSession("s1")).toHaveLength(1);
	});
});
