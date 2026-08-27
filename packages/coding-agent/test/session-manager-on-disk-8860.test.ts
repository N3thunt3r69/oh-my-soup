import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-soup/pi-coding-agent/session/session-storage";

function freshSession(): SessionManager {
	const cwd = join("/tmp", `oms-on-disk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	return SessionManager.create(cwd, join(cwd, "sessions"), new MemorySessionStorage());
}

describe("SessionManager.isSessionOnDisk", () => {
	it("returns false for a fresh lazy session whose JSONL was never materialized", () => {
		const session = freshSession();
		expect(session.getSessionId()).not.toBe("");
		expect(session.getSessionFile()).toBeTruthy();
		expect(session.isSessionOnDisk()).toBe(false);
	});

	it("returns true once ensureOnDisk materializes the session file", async () => {
		const session = freshSession();
		expect(session.isSessionOnDisk()).toBe(false);
		await session.ensureOnDisk();
		expect(session.isSessionOnDisk()).toBe(true);
		expect(session.getSessionFile()).toBeTruthy();
	});

	it("stays false for an in-memory non-persisting session", () => {
		const session = SessionManager.inMemory();
		expect(session.isSessionOnDisk()).toBe(false);
	});
});
