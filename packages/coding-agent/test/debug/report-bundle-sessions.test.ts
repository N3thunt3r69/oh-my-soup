import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createReportBundle } from "@oh-my-soup/pi-coding-agent/debug/report-bundle";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-soup/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
let cleanupRoot: string | undefined;

afterEach(async () => {
	if (originalXdgStateHome === undefined) {
		delete process.env.XDG_STATE_HOME;
	} else {
		process.env.XDG_STATE_HOME = originalXdgStateHome;
	}
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (cleanupRoot) {
		await removeWithRetries(cleanupRoot);
		cleanupRoot = undefined;
	}
});

async function archiveMembers(archivePath: string): Promise<string[]> {
	const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
	return [...(await archive.files()).keys()].sort();
}

describe("report bundle sessions", () => {
	it("bundles only the current session's subtree, not unrelated co-located sessions", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oms-report-sessions-"));
		const xdgStateHome = path.join(cleanupRoot, "state");
		await fs.mkdir(path.join(xdgStateHome, "oms"), { recursive: true });
		process.env.XDG_STATE_HOME = xdgStateHome;
		setAgentDir(fallbackAgentDir);

		const sessionsDir = path.join(cleanupRoot, "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });

		const sessionFile = path.join(sessionsDir, "2026-08-15T00-00-00_CURRENT.jsonl");
		await Bun.write(sessionFile, '{"type":"session","id":"CURRENT"}\n');
		const artifactsDir = sessionFile.slice(0, -6);
		await fs.mkdir(path.join(artifactsDir, "SubTask"), { recursive: true });
		await Bun.write(path.join(artifactsDir, "SubTask.jsonl"), '{"type":"session","id":"SubTask"}\n');
		await Bun.write(path.join(artifactsDir, "SubTask", "NestedTask.jsonl"), '{"type":"session","id":"NestedTask"}\n');

		await Bun.write(
			path.join(sessionsDir, "2026-08-10T00-00-00_OTHERA.jsonl"),
			'{"type":"session","secret":"private-a"}\n',
		);
		await Bun.write(
			path.join(sessionsDir, "2026-08-12T00-00-00_OTHERB.jsonl"),
			'{"type":"session","secret":"private-b"}\n',
		);

		const result = await createReportBundle({ sessionFile });
		const members = await archiveMembers(result.path);
		await fs.rm(result.path, { force: true });

		expect(members).toContain("artifacts/SubTask.jsonl");
		expect(members).toContain("artifacts/SubTask/NestedTask.jsonl");
		expect(members.some(name => name.includes("OTHERA") || name.includes("OTHERB"))).toBe(false);
	});
});
