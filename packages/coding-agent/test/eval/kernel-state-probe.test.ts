import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { disposeAllVmContexts, probeLiveVmGlobals } from "@oh-my-soup/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-soup/pi-coding-agent/eval/js/executor";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { TempDir } from "@oh-my-soup/pi-utils";

// JS eval cold-starts a Bun worker; give worker-backed tests headroom above the
// worker-init floor (context-manager WORKER_INIT_TIMEOUT_MS).
setDefaultTimeout(20_000);

describe("post-compaction kernel-state probe + compact.* prelude (JS)", () => {
	let tempDir: TempDir;
	let session: ToolSession;
	let sessionFile: string;
	let sessionId: string;
	let requestedInstructions: string | undefined | null = null;

	beforeAll(() => {
		tempDir = TempDir.createSync("@kernel-state-");
		sessionFile = path.join(tempDir.path(), "session.jsonl");
		sessionId = `js:kernel-state:${tempDir.path()}`;
		session = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionFile,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
			getCompactionStatus: () => ({ tokens: 1200, contextWindow: 200_000, percent: 0.6, scheduled: false }),
			requestCompaction: instructions => {
				requestedInstructions = instructions;
				return { scheduled: true, note: "Compaction runs when the current turn ends" };
			},
		};
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		tempDir.removeSync();
	});

	it("returns undefined when no live VM context exists for the session", async () => {
		expect(await probeLiveVmGlobals("js:no-such-session", 1_000, 50)).toBeUndefined();
	});

	it("lists user-defined globals but not prelude or infrastructure names", async () => {
		const seeded = await executeJs("const probeAlpha = 1;\nfunction probeBeta() {}\nprobeAlpha;", {
			sessionId,
			session,
			sessionFile,
		});
		expect(seeded.exitCode).toBe(0);

		const names = await probeLiveVmGlobals(sessionId, 5_000, 50);
		expect(names).toContain("probeAlpha");
		expect(names).toContain("probeBeta");
		// Prelude/infrastructure names are baseline, never "surviving user state".
		expect(names).not.toContain("read");
		expect(names).not.toContain("budget");
		expect(names).not.toContain("compact");
	});

	it("caps the reported names at the requested limit", async () => {
		const names = await probeLiveVmGlobals(sessionId, 5_000, 1);
		expect(names).toHaveLength(1);
	});

	it("exposes compact.status() through the host bridge", async () => {
		const result = await executeJs("return JSON.stringify(await compact.status());", {
			sessionId,
			session,
			sessionFile,
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual({
			tokens: 1200,
			contextWindow: 200_000,
			percent: 0.6,
			scheduled: false,
		});
	});

	it("schedules via compact.run and forwards focus instructions", async () => {
		const result = await executeJs('return JSON.stringify(await compact.run("keep the plan"));', {
			sessionId,
			session,
			sessionFile,
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual({
			scheduled: true,
			note: "Compaction runs when the current turn ends",
		});
		expect(requestedInstructions).toBe("keep the plan");
	});

	it("rejects compact.* when compaction.agentCallable is disabled", async () => {
		const gatedSession: ToolSession = {
			...session,
			settings: Settings.isolated({ "compaction.agentCallable": false }),
		};
		const result = await executeJs(
			'try { await compact.status(); return "allowed"; } catch (error) { return error.message; }',
			{ sessionId, session: gatedSession, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toContain("compact.* is disabled");
	});
});
