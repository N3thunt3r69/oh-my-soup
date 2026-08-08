import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigRootDir } from "@oh-my-pi/pi-utils";
import pluginSource from "./OmpGhidraBridge.java" with { type: "text" };
import listProgramsSource from "./OmpGhidraListPrograms.java" with { type: "text" };
import watchParentSource from "./OmpGhidraWatchParent.java" with { type: "text" };

export const GHIDRA_BRIDGE_SCRIPT = "OmpGhidraBridge.java";
export const GHIDRA_LIST_PROGRAMS_SCRIPT = "OmpGhidraListPrograms.java";
export const GHIDRA_WATCH_PARENT_SCRIPT = "OmpGhidraWatchParent.java";

export interface InstalledGhidraPlugin {
	directory: string;
	path: string;
	listProgramsPath: string;
	watchParentPath: string;
}

/** Install the embedded OMP bridge script into a stable user-writable script directory. */
export function installGhidraPlugin(): InstalledGhidraPlugin {
	const directory = path.join(getConfigRootDir(), "ghidra", "scripts");
	fs.mkdirSync(directory, { recursive: true });
	const scriptPath = installScript(directory, GHIDRA_BRIDGE_SCRIPT, pluginSource);
	const listProgramsPath = installScript(directory, GHIDRA_LIST_PROGRAMS_SCRIPT, listProgramsSource);
	const watchParentPath = installScript(directory, GHIDRA_WATCH_PARENT_SCRIPT, watchParentSource);
	return { directory, path: scriptPath, listProgramsPath, watchParentPath };
}

function installScript(directory: string, name: string, source: string): string {
	const scriptPath = path.join(directory, name);
	let installed: string | undefined;
	try {
		installed = fs.readFileSync(scriptPath, "utf8");
	} catch {
		// First install or an unreadable stale copy is replaced below.
	}
	if (installed !== source) fs.writeFileSync(scriptPath, source, "utf8");
	return scriptPath;
}
