import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertOwnerPrivateDir,
	controlDirGuardError,
	controlPathFitsBudget,
	getControlDir,
	getControlPathTemplate,
	resolveSshControlDir,
	sshControlFallbackDir,
} from "../src/ssh/connection-manager";

describe("SSH control-path budget (#9070)", () => {
	it("accounts for the expanded socket name and mux temporary-bind suffix", () => {
		const profileDir = "/Users/arthur/.oms/profiles/upstream/ssh-control";
		expect(Buffer.byteLength(profileDir)).toBe(48);
		expect(controlPathFitsBudget(profileDir, "darwin")).toBe(false);
		expect(controlPathFitsBudget("/Users/arthur/.oms/ssh-control", "darwin")).toBe(true);
	});

	it("enforces the platform sun_path boundaries", () => {
		expect(controlPathFitsBudget("a".repeat(40), "darwin")).toBe(true);
		expect(controlPathFitsBudget("a".repeat(41), "darwin")).toBe(false);
		expect(controlPathFitsBudget("a".repeat(44), "linux")).toBe(true);
		expect(controlPathFitsBudget("a".repeat(45), "linux")).toBe(false);
	});
});

describe("sshControlFallbackDir", () => {
	it("is deterministic and leaves macOS sun_path slack", () => {
		const canonicalDir = "/Users/arthur/.oms/profiles/upstream/ssh-control";
		const fallback = sshControlFallbackDir(canonicalDir, 501);
		expect(fallback).toBe(sshControlFallbackDir(canonicalDir, 501));
		expect(fallback).toBe(path.join("/tmp", "oms-b195c7902f4cd230ba47"));
		expect(Buffer.byteLength(fallback)).toBe(29);
		const tempBind = path.join(fallback, `${"a".repeat(40)}.sock.${"b".repeat(16)}`);
		expect(103 - Buffer.byteLength(tempBind)).toBe(11);
		expect(controlPathFitsBudget(fallback, "darwin")).toBe(true);
	});

	it("isolates canonical control directories and uids", () => {
		const base = "/Users/arthur/.oms/ssh-control";
		expect(sshControlFallbackDir(base, 501)).not.toBe(
			sshControlFallbackDir("/different/xdg/state/oms/ssh-control", 501),
		);
		expect(sshControlFallbackDir(base, 501)).not.toBe(sshControlFallbackDir(base, 502));
	});
});

describe("resolveSshControlDir", () => {
	it("keeps canonical directories that fit", () => {
		const canonicalDir = "/Users/arthur/.oms/ssh-control";
		expect(resolveSshControlDir({ canonicalDir, platform: "darwin", uid: 501 })).toEqual({
			dir: canonicalDir,
			shared: false,
		});
	});

	it("relocates overflowing paths to a bounded shared fallback", () => {
		const canonicalDir = "/Users/arthur/.oms/profiles/upstream/ssh-control";
		const choice = resolveSshControlDir({ canonicalDir, platform: "darwin", uid: 501, tmpBase: "/tmp" });
		expect(choice).toEqual({ dir: path.join("/tmp", "oms-b195c7902f4cd230ba47"), shared: true });
		expect(controlPathFitsBudget(choice.dir, "darwin")).toBe(true);
	});

	it("preserves isolation across distinct XDG state roots", () => {
		const first = resolveSshControlDir({
			canonicalDir: "/very/long/xdg-state-a/oms/profiles/upstream/ssh-control",
			platform: "darwin",
			uid: 501,
		});
		const second = resolveSshControlDir({
			canonicalDir: "/very/long/xdg-state-b/oms/profiles/upstream/ssh-control",
			platform: "darwin",
			uid: 501,
		});
		expect(first.shared).toBe(true);
		expect(second.shared).toBe(true);
		expect(first.dir).not.toBe(second.dir);
	});

	it("does not relocate on Windows or without a uid", () => {
		const canonicalDir = "/Users/arthur/.oms/profiles/upstream/ssh-control";
		expect(resolveSshControlDir({ canonicalDir, platform: "win32", uid: 501 })).toEqual({
			dir: canonicalDir,
			shared: false,
		});
		expect(resolveSshControlDir({ canonicalDir, platform: "darwin", uid: undefined })).toEqual({
			dir: canonicalDir,
			shared: false,
		});
	});
});

describe("controlDirGuardError", () => {
	const valid = { isSymlink: false, isDir: true, uid: 501, mode: 0o700 };

	it("accepts only an owner-private directory", () => {
		expect(controlDirGuardError(valid, 501)).toBeNull();
		expect(controlDirGuardError({ ...valid, isSymlink: true }, 501)).toBe("is a symlink");
		expect(controlDirGuardError({ ...valid, isDir: false }, 501)).toBe("is not a directory");
		expect(controlDirGuardError({ ...valid, uid: 999 }, 501)).toContain("not 501");
		expect(controlDirGuardError({ ...valid, mode: 0o755 }, 501)).toContain("0700");
	});

	it("skips ownership when the process exposes no uid", () => {
		expect(controlDirGuardError({ ...valid, uid: 999 }, undefined)).toBeNull();
	});
});

describe.skipIf(process.platform === "win32")("assertOwnerPrivateDir", () => {
	let scratch = "";

	afterEach(() => {
		if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
		scratch = "";
	});

	const makeScratch = () => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oms-ssh-guard-"));
		return scratch;
	};

	it("normalizes loose permissions on the pinned inode", () => {
		const dir = path.join(makeScratch(), "ctl");
		fs.mkdirSync(dir, { mode: 0o755 });
		fs.chmodSync(dir, 0o755);
		expect(() => assertOwnerPrivateDir(dir)).not.toThrow();
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
	});

	it("refuses a symlinked final component", () => {
		const root = makeScratch();
		const victim = path.join(root, "victim");
		fs.mkdirSync(victim, { mode: 0o700 });
		const link = path.join(root, "ctl");
		fs.symlinkSync(victim, link);
		expect(() => assertOwnerPrivateDir(link)).toThrow("is a symlink");
	});

	it("refuses a non-directory", () => {
		const file = path.join(makeScratch(), "ctl");
		fs.writeFileSync(file, "");
		expect(() => assertOwnerPrivateDir(file)).toThrow("is not a directory");
	});
});

describe("control template sharing", () => {
	it("keeps %C.sock under the resolved control directory", () => {
		expect(getControlPathTemplate()).toBe(path.join(getControlDir(), "%C.sock"));
	});
});
