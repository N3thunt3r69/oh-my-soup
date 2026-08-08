/**
 * Scheduled prompts ("heartbeats"): session-local jobs that inject a prompt on
 * a schedule — once (`in 10m`, `at <ISO>`), on an interval (`every 5m`), or on
 * a five-field cron expression (`0 9 * * 1`, `@hourly`).
 *
 * The job store is a JSON file next to the session's `.jsonl` history; the
 * timer loop lives in the live session process (no daemon). Delivery maps onto
 * the session's existing input paths: "steer" interrupts the current turn,
 * "follow_up" waits for it to finish (both start a turn when the session is
 * idle).
 *
 * Crash safety: `nextFireAt` is persisted and each due job is claimed —
 * advanced and written to disk — BEFORE its prompt is delivered. A restart
 * therefore never re-fires a delivered job, and a job whose fire time passed
 * while the process was down fires exactly once, late, with the next
 * occurrence computed from "now" rather than replaying every missed slot.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ScheduledPromptStatus = "active" | "paused" | "completed" | "cancelled";
export type ScheduledPromptScheduleKind = "once" | "interval" | "cron";
/** "steer" interrupts the current turn; "follow_up" waits for it to finish. */
export type ScheduledPromptDeliveryMode = "steer" | "follow_up";

export interface ScheduledPromptSchedule {
	kind: ScheduledPromptScheduleKind;
	/** Human-readable schedule text as entered ("every 5m", "0 9 * * 1", "in 2h"). */
	expression: string;
	/** Interval period; present only for kind "interval". */
	intervalMs?: number;
}

export interface ScheduledPromptJob {
	id: string;
	status: ScheduledPromptStatus;
	/** Owning session id; jobs only fire inside their own session. */
	sessionId: string;
	label?: string;
	prompt: string;
	deliveryMode: ScheduledPromptDeliveryMode;
	schedule: ScheduledPromptSchedule;
	createdAt: string;
	updatedAt: string;
	/** Next due time (ISO). Undefined for completed/cancelled jobs. */
	nextFireAt?: string;
	lastFiredAt?: string;
	lastError?: string;
	runCount: number;
}

export interface CreateScheduledPromptInput {
	sessionId: string;
	scheduleText: string;
	prompt: string;
	label?: string;
	deliveryMode?: ScheduledPromptDeliveryMode;
	now?: Date;
}

export const SCHEDULED_PROMPTS_FILENAME = "scheduled-prompts.json";
export const DEFAULT_SCHEDULED_PROMPT_DELIVERY: ScheduledPromptDeliveryMode = "follow_up";
export const DEFAULT_MAX_SCHEDULED_PROMPT_JOBS = 8;

const MAX_TIMEOUT_MS = 2_147_483_647;
const ONE_SECOND_MS = 1000;
const ONE_MINUTE_MS = 60_000;
const MIN_INTERVAL_MS = 10 * ONE_SECOND_MS;

// ═══════════════════════════════════════════════════════════════════════════
// Schedule parsing
// ═══════════════════════════════════════════════════════════════════════════

const UNIT_RE = "s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours";
const DAY_UNIT_RE = `${UNIT_RE}|d|day|days`;

function unitToMs(unit: string): number {
	const u = unit.toLowerCase();
	if (u.startsWith("s")) return ONE_SECOND_MS;
	if (u.startsWith("m")) return ONE_MINUTE_MS;
	if (u.startsWith("h")) return 60 * ONE_MINUTE_MS;
	return 24 * 60 * ONE_MINUTE_MS;
}

function stripMatchingQuotes(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * Parse a schedule expression into a normalized schedule plus its first fire
 * time. Accepts `in N <unit>`, `at <ISO date>`, `every N <unit>`,
 * `@hourly`-style aliases, and five-field cron expressions.
 */
export function parseScheduledPromptSchedule(
	input: string,
	now = new Date(),
): { schedule: ScheduledPromptSchedule; nextFireAt: Date } {
	const text = stripMatchingQuotes(input.trim());
	if (!text) throw new Error("Schedule cannot be empty");

	const inMatch = new RegExp(`^in\\s+(\\d+)\\s*(${DAY_UNIT_RE})$`, "i").exec(text);
	if (inMatch) {
		const amount = Number.parseInt(inMatch[1] ?? "", 10);
		return {
			schedule: { kind: "once", expression: text },
			nextFireAt: new Date(now.getTime() + amount * unitToMs(inMatch[2] ?? "")),
		};
	}

	const everyMatch = new RegExp(`^(?:every|each)\\s+(\\d+)\\s*(${UNIT_RE})$`, "i").exec(text);
	if (everyMatch) {
		const amount = Number.parseInt(everyMatch[1] ?? "", 10);
		const intervalMs = amount * unitToMs(everyMatch[2] ?? "");
		if (intervalMs < MIN_INTERVAL_MS) {
			throw new Error("Recurring interval must be at least 10 seconds");
		}
		return {
			schedule: { kind: "interval", expression: text, intervalMs },
			nextFireAt: new Date(now.getTime() + intervalMs),
		};
	}

	if (text.toLowerCase().startsWith("at ")) {
		const when = new Date(text.slice(3).trim());
		if (!Number.isFinite(when.getTime())) {
			throw new Error("Invalid one-shot schedule. Use: at <ISO date>");
		}
		if (when.getTime() <= now.getTime()) {
			throw new Error("One-shot schedule must be in the future");
		}
		return { schedule: { kind: "once", expression: text }, nextFireAt: when };
	}

	const expression = normalizeCronAlias(text);
	const nextFireAt = nextCronFireAfter(expression, now);
	return { schedule: { kind: "cron", expression }, nextFireAt };
}

/**
 * Next occurrence strictly after `after`. Returns undefined for "once"
 * schedules — they never recur.
 */
export function nextFireAfter(schedule: ScheduledPromptSchedule, after: Date): Date | undefined {
	if (schedule.kind === "once") return undefined;
	if (schedule.kind === "interval") {
		if (!schedule.intervalMs || schedule.intervalMs <= 0) {
			throw new Error(`Invalid interval schedule: ${schedule.expression}`);
		}
		return new Date(after.getTime() + schedule.intervalMs);
	}
	return nextCronFireAfter(schedule.expression, after);
}

// ── Tiny vendored five-field cron matcher (minute hour day month weekday) ──

interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
}

function nextCronFireAfter(expression: string, after: Date): Date {
	const fields = parseCronExpression(expression);
	const candidate = new Date(after.getTime());
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	const deadline = candidate.getTime() + 366 * 24 * 60 * ONE_MINUTE_MS;
	while (candidate.getTime() <= deadline) {
		if (matchesCronFields(candidate, fields)) return candidate;
		candidate.setMinutes(candidate.getMinutes() + 1);
	}
	throw new Error(`Cron schedule did not match within one year: ${expression}`);
}

function parseCronExpression(expression: string): CronFields {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(
			"Unsupported schedule. Use 'every 5m', 'in 10m', 'at <ISO date>', @hourly, or five cron fields: minute hour day month weekday",
		);
	}
	return {
		minute: parseCronField(parts[0] ?? "", 0, 59),
		hour: parseCronField(parts[1] ?? "", 0, 23),
		dayOfMonth: parseCronField(parts[2] ?? "", 1, 31),
		month: parseCronField(parts[3] ?? "", 1, 12),
		dayOfWeek: parseCronField(parts[4] ?? "", 0, 7),
	};
}

function parseCronField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		if (!part) throw new Error(`Invalid cron field: ${field}`);
		const [rangeText, stepText] = part.split("/");
		const step = stepText === undefined ? 1 : parseCronNumber(stepText, 1, max);
		let start: number;
		let end: number;
		if (rangeText === "*") {
			start = min;
			end = max;
		} else if (rangeText?.includes("-")) {
			const [startText, endText] = rangeText.split("-");
			start = parseCronNumber(startText, min, max);
			end = parseCronNumber(endText, min, max);
			if (start > end) throw new Error(`Invalid cron range: ${rangeText}`);
		} else {
			start = parseCronNumber(rangeText, min, max);
			end = start;
		}
		for (let value = start; value <= end; value += step) {
			values.add(value);
		}
	}
	return values;
}

function parseCronNumber(value: string | undefined, min: number, max: number): number {
	if (!value || !/^\d+$/.test(value)) throw new Error(`Invalid cron number: ${value ?? ""}`);
	const parsed = Number.parseInt(value, 10);
	if (parsed < min || parsed > max) throw new Error(`Cron number out of range: ${value}`);
	return parsed;
}

function matchesCronFields(date: Date, fields: CronFields): boolean {
	const day = date.getDay();
	const dayMatches = fields.dayOfWeek.has(day) || (day === 0 && fields.dayOfWeek.has(7));
	return (
		fields.minute.has(date.getMinutes()) &&
		fields.hour.has(date.getHours()) &&
		fields.dayOfMonth.has(date.getDate()) &&
		fields.month.has(date.getMonth() + 1) &&
		dayMatches
	);
}

function normalizeCronAlias(text: string): string {
	switch (text) {
		case "@hourly":
			return "0 * * * *";
		case "@daily":
			return "0 0 * * *";
		case "@weekly":
			return "0 0 * * 0";
		case "@monthly":
			return "0 0 1 * *";
		default:
			return text;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// /heartbeat argument grammar
// ═══════════════════════════════════════════════════════════════════════════

export type ParsedHeartbeatArgs =
	| { kind: "status" }
	| {
			kind: "set";
			scheduleText: string;
			prompt: string;
			deliveryMode?: ScheduledPromptDeliveryMode;
	  };

const HEARTBEAT_USAGE = "Usage: /heartbeat <interval|cron> <prompt> [--steer|--follow-up]";

function parseDeliveryToken(token: string): ScheduledPromptDeliveryMode {
	const normalized = token.toLowerCase().replace("-", "_");
	if (normalized === "steer" || normalized === "follow_up") return normalized;
	throw new Error('Delivery mode must be "steer" or "follow-up"');
}

/** Strip `--steer` / `--follow-up` / `--deliver <mode>` flags anywhere in the text. */
function consumeDeliveryFlags(text: string): { deliveryMode?: ScheduledPromptDeliveryMode; rest: string } {
	let deliveryMode: ScheduledPromptDeliveryMode | undefined;
	const rest = text
		.replace(/(^|\s)--deliver(?:=|\s+)(\S+)(?=\s|$)/gi, (_all, lead: string, token: string) => {
			deliveryMode = parseDeliveryToken(token);
			return lead;
		})
		.replace(/(^|\s)--(steer|follow[-_]up)(?=\s|$)/gi, (_all, lead: string, token: string) => {
			deliveryMode = parseDeliveryToken(token);
			return lead;
		})
		.trim();
	return { deliveryMode, rest };
}

/**
 * Consume a leading schedule from heartbeat arguments. Recognizes
 * `every/each N <unit>`, `in N <unit>`, `at <ISO>`, bare `N<unit>` shorthand
 * (`5m` → `every 5m`), `@hourly` aliases, quoted cron expressions, and bare
 * five-field cron prefixes.
 */
function consumeLeadingSchedule(text: string): { scheduleText: string; rest: string } | undefined {
	const every = new RegExp(`^(?:every|each)\\s+\\d+\\s*(?:${UNIT_RE})\\b`, "i").exec(text);
	if (every) return { scheduleText: every[0], rest: text.slice(every[0].length).trim() };

	const inOnce = new RegExp(`^in\\s+\\d+\\s*(?:${DAY_UNIT_RE})\\b`, "i").exec(text);
	if (inOnce) return { scheduleText: inOnce[0], rest: text.slice(inOnce[0].length).trim() };

	const at = /^at\s+(\S+)/i.exec(text);
	if (at) return { scheduleText: at[0], rest: text.slice(at[0].length).trim() };

	const bare = new RegExp(`^(\\d+\\s*(?:${UNIT_RE}))(?:\\s+|$)`, "i").exec(text);
	if (bare) return { scheduleText: `every ${(bare[1] ?? "").trim()}`, rest: text.slice(bare[0].length).trim() };

	const alias = /^(@hourly|@daily|@weekly|@monthly)\b/i.exec(text);
	if (alias) return { scheduleText: alias[1] ?? "", rest: text.slice(alias[0].length).trim() };

	const quoted = /^(?:"([^"]+)"|'([^']+)')\s*/.exec(text);
	if (quoted) {
		return { scheduleText: quoted[1] ?? quoted[2] ?? "", rest: text.slice(quoted[0].length).trim() };
	}

	// Bare five-field cron prefix: consume the first five tokens when they parse.
	const tokens = text.split(/\s+/);
	if (tokens.length >= 6) {
		const candidate = tokens.slice(0, 5).join(" ");
		try {
			parseCronExpression(normalizeCronAlias(candidate));
			return { scheduleText: candidate, rest: tokens.slice(5).join(" ").trim() };
		} catch {
			// fall through: not a cron prefix
		}
	}
	return undefined;
}

/** Parse `/heartbeat` arguments: empty → status, otherwise `<schedule> <prompt>`. */
export function parseHeartbeatArgs(args: string): ParsedHeartbeatArgs {
	const flags = consumeDeliveryFlags(args.trim());
	const text = flags.rest;
	if (!text || text === "status") return { kind: "status" };

	const schedule = consumeLeadingSchedule(text);
	if (!schedule) throw new Error(HEARTBEAT_USAGE);
	const prompt = stripMatchingQuotes(schedule.rest.trim());
	if (!prompt) throw new Error(HEARTBEAT_USAGE);
	return {
		kind: "set",
		scheduleText: schedule.scheduleText,
		prompt,
		...(flags.deliveryMode ? { deliveryMode: flags.deliveryMode } : {}),
	};
}

/** One-line summary used by `/heartbeat` and `/heartbeats list`. */
export function formatScheduledPromptJob(job: ScheduledPromptJob): string {
	const next = job.nextFireAt ? new Date(job.nextFireAt).toLocaleString() : "-";
	const last = job.lastFiredAt ? new Date(job.lastFiredAt).toLocaleString() : "-";
	const preview = job.prompt.replace(/\s+/g, " ").slice(0, 60);
	const label = job.label ? ` "${job.label}"` : "";
	const error = job.lastError ? ` error=${job.lastError}` : "";
	return `${job.id} ${job.status}${label} [${job.schedule.expression}, ${job.deliveryMode}] next=${next} last=${last} runs=${job.runCount} — ${preview}${error}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════════════════════

interface ScheduledPromptsFile {
	version: 1;
	jobs: ScheduledPromptJob[];
}

function isScheduledPromptJob(value: unknown): value is ScheduledPromptJob {
	if (typeof value !== "object" || value === null) return false;
	const job = value as Record<string, unknown>;
	return (
		typeof job.id === "string" &&
		typeof job.sessionId === "string" &&
		typeof job.prompt === "string" &&
		typeof job.status === "string" &&
		typeof job.schedule === "object" &&
		job.schedule !== null
	);
}

/**
 * JSON-file job store. The file lives next to the session history (one file
 * per session directory, shared by every session in that project); each
 * mutation rewrites atomically via temp-file + rename. When constructed
 * without a path (non-persistent sessions) the store is memory-only.
 */
export class ScheduledPromptStore {
	readonly #filePath: string | undefined;
	#memory: ScheduledPromptJob[] = [];

	constructor(filePath?: string) {
		this.#filePath = filePath;
	}

	get filePath(): string | undefined {
		return this.#filePath;
	}

	/** All jobs in the store, across sessions. */
	load(): ScheduledPromptJob[] {
		if (!this.#filePath) return [...this.#memory];
		let raw: string;
		try {
			raw = fs.readFileSync(this.#filePath, "utf8");
		} catch {
			return [];
		}
		try {
			const parsed = JSON.parse(raw) as Partial<ScheduledPromptsFile>;
			if (!Array.isArray(parsed.jobs)) return [];
			return parsed.jobs.filter(isScheduledPromptJob);
		} catch {
			// Corrupt store: treat as empty rather than crashing the session.
			return [];
		}
	}

	#write(jobs: ScheduledPromptJob[]): void {
		if (!this.#filePath) {
			this.#memory = jobs;
			return;
		}
		const payload: ScheduledPromptsFile = { version: 1, jobs };
		const dir = path.dirname(this.#filePath);
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${this.#filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
		fs.renameSync(tmp, this.#filePath);
	}

	listForSession(sessionId: string, includeInactive = false): ScheduledPromptJob[] {
		return this.load()
			.filter(
				job =>
					job.sessionId === sessionId && (includeInactive || job.status === "active" || job.status === "paused"),
			)
			.sort((a, b) => (a.nextFireAt ?? "\uffff").localeCompare(b.nextFireAt ?? "\uffff"));
	}

	create(input: CreateScheduledPromptInput): ScheduledPromptJob {
		const now = input.now ?? new Date();
		const prompt = input.prompt.trim();
		if (!prompt) throw new Error("Scheduled prompt cannot be empty");
		const parsed = parseScheduledPromptSchedule(input.scheduleText, now);
		const nowIso = now.toISOString();
		const job: ScheduledPromptJob = {
			id: `hb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			status: "active",
			sessionId: input.sessionId,
			label: input.label?.trim() || undefined,
			prompt,
			deliveryMode: input.deliveryMode ?? DEFAULT_SCHEDULED_PROMPT_DELIVERY,
			schedule: parsed.schedule,
			createdAt: nowIso,
			updatedAt: nowIso,
			nextFireAt: parsed.nextFireAt.toISOString(),
			runCount: 0,
		};
		this.#write([...this.load(), job]);
		return job;
	}

	/** Apply `mutate` to the matching job and persist. Returns the updated job. */
	update(
		id: string,
		mutate: (job: ScheduledPromptJob) => ScheduledPromptJob,
		now = new Date(),
	): ScheduledPromptJob | undefined {
		let updated: ScheduledPromptJob | undefined;
		const jobs = this.load().map(job => {
			if (job.id !== id) return job;
			updated = { ...mutate(job), updatedAt: now.toISOString() };
			return updated;
		});
		if (updated) this.#write(jobs);
		return updated;
	}

	/**
	 * Claim every due job for `sessionId`: advance `nextFireAt` (or complete
	 * one-shot jobs), bump counters, and PERSIST before returning the claimed
	 * snapshots. Recurrences are computed from `now`, so slots missed while the
	 * process was down collapse into this single late fire — never a storm —
	 * and a restart after the claim never fires the same slot twice.
	 */
	claimDue(sessionId: string, now = new Date()): ScheduledPromptJob[] {
		const claimed: ScheduledPromptJob[] = [];
		const jobs = this.load().map(job => {
			if (job.sessionId !== sessionId || job.status !== "active") return job;
			if (job.nextFireAt === undefined || Date.parse(job.nextFireAt) > now.getTime()) return job;
			const next = nextFireAfter(job.schedule, now);
			const advanced: ScheduledPromptJob = {
				...job,
				status: next ? "active" : "completed",
				nextFireAt: next?.toISOString(),
				lastFiredAt: now.toISOString(),
				lastError: undefined,
				updatedAt: now.toISOString(),
				runCount: job.runCount + 1,
			};
			claimed.push(advanced);
			return advanced;
		});
		if (claimed.length > 0) this.#write(jobs);
		return claimed;
	}

	/** Earliest due time among this session's active jobs. */
	nextFireAt(sessionId: string): Date | undefined {
		let earliest: number | undefined;
		for (const job of this.load()) {
			if (job.sessionId !== sessionId || job.status !== "active" || job.nextFireAt === undefined) continue;
			const at = Date.parse(job.nextFireAt);
			if (!Number.isFinite(at)) continue;
			if (earliest === undefined || at < earliest) earliest = at;
		}
		return earliest === undefined ? undefined : new Date(earliest);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Scheduler
// ═══════════════════════════════════════════════════════════════════════════

/** Capabilities the scheduler borrows from its owning session. */
export interface ScheduledPromptSchedulerHost {
	sessionId(): string;
	isDisposed(): boolean;
	/** Master switch (`scheduledPrompts.enabled`). Checked at fire time. */
	enabled(): boolean;
	/** Cap on live (active+paused) jobs per session (`scheduledPrompts.maxJobs`). */
	maxJobs(): number;
	/** Inject the prompt via the session's input paths. May throw (recorded as lastError). */
	deliver(job: ScheduledPromptJob, promptText: string, mode: ScheduledPromptDeliveryMode): Promise<void>;
	onError?(job: ScheduledPromptJob, error: unknown): void;
	now?(): Date;
}

/**
 * Session-hosted timer loop: arms one `setTimeout` for the next due job,
 * rearms after every mutation and every fire, and delivers claimed jobs
 * through the host. `start()` performs catch-up (jobs due while the process
 * was down fire once, late).
 */
export class ScheduledPromptScheduler {
	readonly #store: ScheduledPromptStore;
	readonly #host: ScheduledPromptSchedulerHost;
	#timer: Timer | undefined;
	#firing = false;
	#stopped = true;

	constructor(store: ScheduledPromptStore, host: ScheduledPromptSchedulerHost) {
		this.#store = store;
		this.#host = host;
	}

	get store(): ScheduledPromptStore {
		return this.#store;
	}

	/** Begin the timer loop. Due-on-load jobs fire on the next tick (once, late). */
	start(): void {
		this.#stopped = false;
		this.#arm();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	list(includeInactive = false): ScheduledPromptJob[] {
		return this.#store.listForSession(this.#host.sessionId(), includeInactive);
	}

	create(input: Omit<CreateScheduledPromptInput, "sessionId">): ScheduledPromptJob {
		if (!this.#host.enabled()) {
			throw new Error("Scheduled prompts are disabled (scheduledPrompts.enabled)");
		}
		const live = this.list().length;
		const max = this.#host.maxJobs();
		if (live >= max) {
			throw new Error(`Scheduled prompt limit reached (${live}/${max}). Cancel one with /heartbeats cancel <id>.`);
		}
		const job = this.#store.create({ ...input, sessionId: this.#host.sessionId() });
		this.#arm();
		return job;
	}

	pause(id: string): ScheduledPromptJob | undefined {
		const job = this.#resolve(id);
		if (job?.status !== "active") return undefined;
		const updated = this.#store.update(job.id, j => ({
			...j,
			status: "paused",
			nextFireAt: undefined,
		}));
		this.#arm();
		return updated;
	}

	resume(id: string): ScheduledPromptJob | undefined {
		const job = this.#resolve(id);
		if (job?.status !== "paused") return undefined;
		const now = this.#now();
		// Recurring schedules resume from now; a paused one-shot fires immediately
		// (once, late) rather than silently never firing.
		const next = nextFireAfter(job.schedule, now) ?? now;
		const updated = this.#store.update(job.id, j => ({
			...j,
			status: "active",
			nextFireAt: next.toISOString(),
		}));
		this.#arm();
		return updated;
	}

	cancel(id: string): ScheduledPromptJob | undefined {
		const job = this.#resolve(id);
		if (!job) return undefined;
		const updated = this.#store.update(job.id, j => ({
			...j,
			status: "cancelled",
			nextFireAt: undefined,
		}));
		this.#arm();
		return updated;
	}

	/** Resolve a job by exact id or unambiguous id prefix among live jobs. */
	#resolve(id: string): ScheduledPromptJob | undefined {
		const jobs = this.list();
		const exact = jobs.find(job => job.id === id);
		if (exact) return exact;
		const prefixed = jobs.filter(job => job.id.startsWith(id));
		return prefixed.length === 1 ? prefixed[0] : undefined;
	}

	#now(): Date {
		return this.#host.now?.() ?? new Date();
	}

	#arm(minDelayMs = 0): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		if (this.#stopped || this.#host.isDisposed()) return;
		const next = this.#store.nextFireAt(this.#host.sessionId());
		if (!next) return;
		const due = Math.max(0, next.getTime() - this.#now().getTime());
		const delay = Math.min(Math.max(due, minDelayMs), MAX_TIMEOUT_MS);
		this.#timer = setTimeout(() => {
			void this.#fireDue();
		}, delay);
		// Never keep a finished process alive just for a heartbeat.
		this.#timer.unref?.();
	}

	async #fireDue(): Promise<void> {
		if (this.#firing || this.#stopped || this.#host.isDisposed()) return;
		this.#firing = true;
		let deferMs = 0;
		try {
			if (!this.#host.enabled()) {
				// Master switch off: keep jobs intact but re-check once a minute
				// instead of hot-looping on the still-due timer.
				deferMs = ONE_MINUTE_MS;
				return;
			}
			const claimed = this.#store.claimDue(this.#host.sessionId(), this.#now());
			for (const job of claimed) {
				try {
					await this.#host.deliver(job, buildScheduledPromptText(job), job.deliveryMode);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.#store.update(job.id, j => ({ ...j, lastError: message }));
					this.#host.onError?.(job, error);
				}
			}
		} finally {
			this.#firing = false;
			this.#arm(deferMs);
		}
	}
}

/** Wrap the stored prompt so the model knows the turn is machine-initiated. */
export function buildScheduledPromptText(job: ScheduledPromptJob): string {
	const name = job.label ?? job.id;
	return `[Scheduled prompt "${name}" (${job.schedule.expression}) fired. This is an automated heartbeat, not a live user message; there may be nobody watching. Act on the instruction below, then end your turn.]\n${job.prompt}`;
}
