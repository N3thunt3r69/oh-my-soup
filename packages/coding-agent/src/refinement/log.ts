/**
 * Append-only audit log for /refine passes (`<state>/refinements.jsonl`).
 *
 * Every applied pass — including rollbacks — appends one JSON line carrying
 * the ops with lossless before/after entry state plus byte-exact file
 * snapshots, so any pass can be reverse-applied later.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseJsonlLenient } from "@oh-my-soup/pi-utils";
import { getRefinementLogPath, type RefinementStorePaths, readFileOrNull } from "./backends";
import { isRefinementLogEntry, type RefinementLogEntry } from "./types";

export async function appendRefinementLogEntry(
	paths: RefinementStorePaths,
	entry: RefinementLogEntry,
): Promise<string> {
	const logPath = getRefinementLogPath(paths);
	await fs.mkdir(path.dirname(logPath), { recursive: true });
	await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
	return logPath;
}

/** Load the full pass history, oldest first. Malformed lines are skipped. */
export async function loadRefinementLog(paths: RefinementStorePaths): Promise<RefinementLogEntry[]> {
	const raw = await readFileOrNull(getRefinementLogPath(paths));
	if (raw === null) return [];
	return parseJsonlLenient<unknown>(raw).filter(isRefinementLogEntry);
}
