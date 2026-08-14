import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-soup/pi-utils";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import {
	credentialPinHash,
	inheritPinnedCredentials,
	recordCredentialPin,
	seedCredentialPins,
} from "../src/session/credential-pin";
import { SessionManager } from "../src/session/session-manager";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, extra?: { orgId?: string }) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
		...extra,
	};
}

function assistantMessage(provider: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "hi" }],
		api: "anthropic-messages",
		provider,
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

describe("credential pins", () => {
	let tempDir: TempDir;
	let storage: AuthStorage;

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = TempDir.createSync("@pi-credential-pin-");
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		store.saveOAuth("anthropic", mintOAuthCredential("a"));
		store.saveOAuth("anthropic", mintOAuthCredential("b"));
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(() => {
		for (const key of ANTHROPIC_ENV) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		tempDir[Symbol.dispose]();
	});

	test("pin entries survive a session reload and the latest pin per provider wins", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("anthropic", Date.now()));
		manager.appendCredentialPin("anthropic", "hash-old");
		manager.appendCredentialPin("openai-codex", "hash-codex");
		manager.appendCredentialPin("anthropic", "hash-new");
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");

		const reopened = await SessionManager.open(file);
		const pins = reopened.getCredentialPins();
		expect(pins.get("anthropic")?.hash).toBe("hash-new");
		expect(pins.get("openai-codex")?.hash).toBe("hash-codex");
	});

	test("later assistant turns advance the pin's effective last-use; other providers and new pins do not", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const pinId = manager.appendCredentialPin("anthropic", "hash-a");
		const pinnedAt = new Date(manager.getEntry(pinId)!.timestamp).getTime();

		// Long session on one account: no new pin entries, only assistant turns.
		const lastTurnAt = pinnedAt + 3 * 60 * 60 * 1000;
		manager.appendMessage(assistantMessage("anthropic", pinnedAt + 60_000));
		manager.appendMessage(assistantMessage("anthropic", lastTurnAt));
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(lastTurnAt);

		// A different provider's turn never advances this provider's pin.
		manager.appendMessage(assistantMessage("openai-codex", lastTurnAt + 60_000));
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(lastTurnAt);

		// An account change re-bases last-use at the new pin.
		const newPinId = manager.appendCredentialPin("anthropic", "hash-b");
		const newPinnedAt = new Date(manager.getEntry(newPinId)!.timestamp).getTime();
		expect(manager.getCredentialPins().get("anthropic")?.lastUsedAt).toBe(newPinnedAt);
	});

	test("seeding re-pins the recorded account in a store with no session stickiness", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		manager.appendCredentialPin("anthropic", hash);

		// Fresh process: no sticky exists yet (the broker-mode resume scenario).
		expect(storage.listOAuthAccounts("anthropic", sessionId).some(account => account.active)).toBe(false);

		seedCredentialPins(storage, manager, sessionId);

		const active = storage.listOAuthAccounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-b");
	});

	test("pins are org-scoped: the same account in two orgs re-pins the matching org credential", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-1" }));
		store.saveOAuth("anthropic", mintOAuthCredential("x", { orgId: "org-2" }));
		const orgStorage = new AuthStorage(store);
		await orgStorage.reload();

		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const identity = { accountId: "account-x", email: "x@example.com" };
		const orgTwoHash = credentialPinHash("anthropic", { ...identity, orgId: "org-2" });
		if (!orgTwoHash) throw new Error("expected a pin hash");
		expect(orgTwoHash).not.toBe(credentialPinHash("anthropic", { ...identity, orgId: "org-1" }));
		manager.appendCredentialPin("anthropic", orgTwoHash);

		seedCredentialPins(orgStorage, manager, sessionId);

		const active = orgStorage.listOAuthAccounts("anthropic", sessionId).find(account => account.active);
		expect(active?.orgId).toBe("org-2");
	});

	test("seeding never clobbers a live sticky from the same process", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.listOAuthAccounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		expect(storage.pinSessionOAuthAccount("anthropic", sessionId, accountA!.credentialId)).toBe(true);

		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		manager.appendCredentialPin("anthropic", hash!);
		seedCredentialPins(storage, manager, sessionId);

		const active = storage.listOAuthAccounts("anthropic", sessionId).find(account => account.active);
		expect(active?.accountId).toBe("account-a");
	});

	test("seeding is a no-op when the pinned account is no longer stored", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-gone" });
		manager.appendCredentialPin("anthropic", hash!);

		seedCredentialPins(storage, manager, sessionId);

		expect(storage.listOAuthAccounts("anthropic", sessionId).some(account => account.active)).toBe(false);
	});

	test("recording appends the serving account's hash once and dedupes repeats", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accounts = storage.listOAuthAccounts("anthropic", sessionId);
		const accountA = accounts.find(account => account.accountId === "account-a");
		storage.pinSessionOAuthAccount("anthropic", sessionId, accountA!.credentialId);

		recordCredentialPin(storage, manager, sessionId, "anthropic");
		recordCredentialPin(storage, manager, sessionId, "anthropic");

		const entries = manager.getBranch().filter(entry => entry.type === "credential_pin");
		expect(entries).toHaveLength(1);
		const identity = storage.getOAuthAccountIdentity("anthropic", sessionId);
		expect(manager.getCredentialPins().get("anthropic")?.hash).toBe(credentialPinHash("anthropic", identity!));
	});

	test("recording persists pinned-ness and re-records when only the flag changes", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionId = manager.getSessionId();
		const accountA = storage.listOAuthAccounts("anthropic").find(account => account.accountId === "account-a");
		if (!accountA) throw new Error("expected stored account-a");

		// Explicit user pin (/rotateaccount) → pin entry carries pinned: true.
		expect(storage.pinSessionOAuthAccount("anthropic", sessionId, accountA.credentialId)).toBe(true);
		recordCredentialPin(storage, manager, sessionId, "anthropic");
		recordCredentialPin(storage, manager, sessionId, "anthropic");
		let pinEntries = manager.getBranch().filter(entry => entry.type === "credential_pin");
		expect(pinEntries).toHaveLength(1);
		expect(manager.getCredentialPins().get("anthropic")?.pinned).toBe(true);

		// Same account, explicitness dropped (implicit restore): flag change alone re-records.
		storage.releaseSessionCredentialForReselection("anthropic", sessionId);
		expect(storage.pinSessionOAuthAccount("anthropic", sessionId, accountA.credentialId, { explicit: false })).toBe(
			true,
		);
		recordCredentialPin(storage, manager, sessionId, "anthropic");
		pinEntries = manager.getBranch().filter(entry => entry.type === "credential_pin");
		expect(pinEntries).toHaveLength(2);
		expect(manager.getCredentialPins().get("anthropic")?.pinned).toBe(false);
	});

	test("seeding restores explicit pins as pinned stickies; implicit pins stay implicit", () => {
		const managerA = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionA = managerA.getSessionId();
		const hash = credentialPinHash("anthropic", { accountId: "account-b", email: "b@example.com" });
		if (!hash) throw new Error("expected a pin hash");
		managerA.appendCredentialPin("anthropic", hash, true);
		seedCredentialPins(storage, managerA, sessionA);
		expect(storage.getSessionOAuthStickyInfo("anthropic", sessionA)?.pinned).toBe(true);

		const managerB = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionB = managerB.getSessionId();
		managerB.appendCredentialPin("anthropic", hash);
		seedCredentialPins(storage, managerB, sessionB);
		expect(storage.getSessionOAuthStickyInfo("anthropic", sessionB)?.pinned).toBe(false);
	});

	test("subagents inherit the parent's explicitly pinned account, not implicit stickies", () => {
		const accountB = storage.listOAuthAccounts("anthropic").find(account => account.accountId === "account-b");
		if (!accountB) throw new Error("expected stored account-b");

		// /rotateaccount pinned account-b on the parent → child routes to it.
		expect(storage.pinSessionOAuthAccount("anthropic", "parent-session", accountB.credentialId)).toBe(true);
		inheritPinnedCredentials(storage, "parent-session", "child-session");
		const childActive = storage.listOAuthAccounts("anthropic", "child-session").find(account => account.active);
		expect(childActive?.accountId).toBe("account-b");
		expect(storage.getSessionOAuthStickyInfo("anthropic", "child-session")?.pinned).toBe(true);

		// Implicit parent sticky: children keep ranking freedom.
		expect(
			storage.pinSessionOAuthAccount("anthropic", "parent-implicit", accountB.credentialId, { explicit: false }),
		).toBe(true);
		inheritPinnedCredentials(storage, "parent-implicit", "child-implicit");
		expect(storage.getSessionOAuthStickyInfo("anthropic", "child-implicit")).toBeUndefined();
	});
});
