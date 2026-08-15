import { directoryExists, getProjectDir, normalizePathForComparison, setProjectDir } from "@oh-my-soup/pi-utils";
import { homedir, tmpdir } from "os";
import { join } from "path";

import type { Args } from "./args";

/**
 * Attempts to set the project directory when the target exists.
 *
 * @param directory - Directory to apply.
 * @returns Whether the project directory was changed.
 */
const tryProjectDir = async (directory: string): Promise<boolean> => {
	try {
		if ((await directoryExists(directory)) === false) return false;

		setProjectDir(directory);
		return true;
	} catch {
		return false;
	}
};

/**
 * Moves the project directory out of the home directory when allowed.
 *
 * @param parsed - Parsed startup arguments.
 * @returns A promise that resolves after the directory check completes.
 */
const maybeAutoChdir = async (parsed: Args): Promise<void> => {
	if (parsed.allowHome === true) return;
	if (parsed.cwd !== undefined) return;

	const home = homedir();
	if (home === "") return;

	const cwd = normalizePathForComparison(getProjectDir());
	if (cwd !== normalizePathForComparison(home)) return;

	const candidates = [join(home, "tmp"), ...(process.platform === "win32" ? [] : ["/tmp", "/var/tmp"])];

	for (const directory of candidates) if (await tryProjectDir(directory)) return;

	const fallback = tmpdir();
	if (fallback === "") return;
	if (normalizePathForComparison(fallback) === cwd) return;

	await tryProjectDir(fallback);
};

/**
 * Applies the configured startup directory or selects a temporary directory
 * when launching from the home directory.
 *
 * @param parsed - Parsed startup arguments.
 * @returns A promise that resolves after the project directory is applied.
 */
export const applyStartupCwd = async (parsed: Args): Promise<void> => {
	if (parsed.cwd === undefined) return await maybeAutoChdir(parsed);

	setProjectDir(parsed.cwd);
	parsed.cwd = getProjectDir();
};
