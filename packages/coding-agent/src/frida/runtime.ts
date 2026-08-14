/**
 * Interpreter resolution and private-environment provisioning for the Frida
 * worker.
 *
 * Mirrors the bundled ida-bridge bootstrap (`src/disasm/ida/bridge-runtime.ts`):
 * an OMS-owned venv per base interpreter, keyed by a fingerprint over the
 * interpreter identity and the pinned dependency set, with an atomic rename
 * and an import probe so a half-provisioned environment is never reused.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { $which, getConfigRootDir, ptree } from "@oh-my-soup/pi-utils";

const RUNTIME_FORMAT = 1;
const PROCESS_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL_CHARS = 32 * 1024;

/**
 * Pinned so a provisioned environment is reproducible. Frida 17 removed
 * `Module.findExportByName` and `Memory.readByteArray`; the agent in
 * `worker.py` targets the 17.x API and would break on 16.x.
 */
export const FRIDA_DEPENDENCIES = ["frida==17.17.0"] as const;

const IMPORT_PROBE = ["import frida", "print('oms-frida-ready')"].join(";");

/** Interpreters tried, in order, when no explicit one is configured. */
const PYTHON_CANDIDATES: ReadonlyArray<readonly string[]> = [["python3"], ["python"], ["py", "-3"]];

export interface FridaRuntime {
	/** Canonical absolute path of the base interpreter that built the venv. */
	basePython: string;
	/** Interpreter inside the OMS-owned environment; this runs the worker. */
	python: string;
	environmentDirectory: string;
	fingerprint: string;
}

interface RuntimeMarker {
	format: number;
	fingerprint: string;
	dependencies: readonly string[];
}

const runtimePreparations = new Map<string, Promise<void>>();

/**
 * Resolve a usable base interpreter. An explicit path is validated and used
 * verbatim; otherwise candidates are probed and normalized to the absolute
 * `sys.executable` they report — which is what turns the Windows `py -3`
 * launcher (and the Microsoft Store `python` shim) into a real path.
 */
export async function resolveBasePython(explicit?: string): Promise<string> {
	if (explicit?.trim()) {
		const resolved = await canonicalInterpreter([explicit.trim()]);
		if (!resolved) throw new Error(`Configured Frida interpreter is not a usable Python 3: ${explicit}`);
		return resolved;
	}
	for (const candidate of PYTHON_CANDIDATES) {
		const first = candidate[0];
		if (!first) continue;
		if (!(await $which(first))) continue;
		const resolved = await canonicalInterpreter(candidate);
		if (resolved) return resolved;
	}
	throw new Error(
		"No usable Python 3 interpreter was found for Frida. Install Python 3.9+ or set `frida.python` to its path.",
	);
}

/** Ask an interpreter for its own absolute path; `undefined` when unusable. */
async function canonicalInterpreter(command: readonly string[]): Promise<string | undefined> {
	const probe = "import sys; sys.stdout.write(sys.executable if sys.version_info >= (3, 9) else '')";
	try {
		const child = ptree.spawn([...command, "-c", probe], { stdin: "ignore" });
		const stdout = await collectTail(child.stdout);
		const exitCode = await child.exited;
		if (exitCode !== 0) return undefined;
		const executable = stdout.trim();
		if (!executable || !fs.existsSync(executable)) return undefined;
		return fs.realpathSync(executable);
	} catch {
		return undefined;
	}
}

/** Locate (without creating) the private environment for one base interpreter. */
export function resolveFridaRuntime(basePython: string): FridaRuntime {
	const canonicalPython = fs.realpathSync(basePython);
	const stat = fs.statSync(canonicalPython);
	const fingerprint = crypto
		.createHash("sha256")
		.update(
			JSON.stringify([
				canonicalPython,
				stat.size,
				stat.mtimeMs,
				process.platform,
				process.arch,
				RUNTIME_FORMAT,
				FRIDA_DEPENDENCIES,
			]),
		)
		.digest("hex");
	const environmentDirectory = path.join(getConfigRootDir(), "frida", "python", fingerprint.slice(0, 20));
	return {
		basePython: canonicalPython,
		python: virtualEnvironmentPython(environmentDirectory),
		environmentDirectory,
		fingerprint,
	};
}

/** Create the environment and install pinned frida if it is not already good. */
export async function ensureFridaRuntime(
	runtime: FridaRuntime,
	env: Record<string, string | undefined>,
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	let preparation = runtimePreparations.get(runtime.environmentDirectory);
	if (!preparation) {
		preparation = prepareRuntime(runtime, env, cwd).finally(() => {
			runtimePreparations.delete(runtime.environmentDirectory);
		});
		runtimePreparations.set(runtime.environmentDirectory, preparation);
	}
	await awaitWithSignal(preparation, signal);
}

async function prepareRuntime(
	runtime: FridaRuntime,
	env: Record<string, string | undefined>,
	cwd: string,
): Promise<void> {
	if (runtimeMarkerMatches(runtime) && (await probeRuntime(runtime.python, env, cwd))) return;
	const parent = path.dirname(runtime.environmentDirectory);
	fs.mkdirSync(parent, { recursive: true });
	const temporary = fs.mkdtempSync(path.join(parent, `.venv-${process.pid}-`));
	try {
		await runChecked(
			[runtime.basePython, "-m", "venv", temporary],
			`create OMS's private Frida Python environment with ${runtime.basePython}`,
			env,
			cwd,
		);
		await runChecked(
			[
				virtualEnvironmentPython(temporary),
				"-m",
				"pip",
				"install",
				"--disable-pip-version-check",
				"--no-input",
				"--only-binary=:all:",
				"--no-warn-script-location",
				...FRIDA_DEPENDENCIES,
			],
			"install Frida into OMS's private Python environment",
			env,
			cwd,
		);
		writeJson(path.join(temporary, ".oms-runtime.json"), {
			format: RUNTIME_FORMAT,
			fingerprint: runtime.fingerprint,
			dependencies: FRIDA_DEPENDENCIES,
		} satisfies RuntimeMarker);
		const destinationHealthy = runtimeMarkerMatches(runtime) && (await probeRuntime(runtime.python, env, cwd));
		if (!destinationHealthy) {
			fs.rmSync(runtime.environmentDirectory, { recursive: true, force: true });
			fs.renameSync(temporary, runtime.environmentDirectory);
		}
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
	if (!(await probeRuntime(runtime.python, env, cwd))) {
		fs.rmSync(runtime.environmentDirectory, { recursive: true, force: true });
		throw new Error(`OMS's private Frida environment failed its import check: ${runtime.python}`);
	}
}

function runtimeMarkerMatches(runtime: FridaRuntime): boolean {
	if (!fs.existsSync(runtime.python)) return false;
	const marker = readJson<Partial<RuntimeMarker>>(path.join(runtime.environmentDirectory, ".oms-runtime.json"));
	return (
		marker?.format === RUNTIME_FORMAT &&
		marker.fingerprint === runtime.fingerprint &&
		JSON.stringify(marker.dependencies) === JSON.stringify(FRIDA_DEPENDENCIES)
	);
}

async function probeRuntime(python: string, env: Record<string, string | undefined>, cwd: string): Promise<boolean> {
	try {
		await runChecked([python, "-c", IMPORT_PROBE], "validate OMS's private Frida runtime", env, cwd);
		return true;
	} catch {
		return false;
	}
}

function virtualEnvironmentPython(directory: string): string {
	return process.platform === "win32"
		? path.join(directory, "Scripts", "python.exe")
		: path.join(directory, "bin", "python");
}

async function runChecked(
	args: string[],
	label: string,
	env: Record<string, string | undefined>,
	cwd: string,
): Promise<void> {
	const child = ptree.spawn(args, { cwd, env: { ...env, PIP_NO_INPUT: "1" }, detached: true });
	const stdoutPromise = collectTail(child.stdout);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.exitCode === null) child.kill();
	}, PROCESS_TIMEOUT_MS);
	let exitCode: number;
	try {
		exitCode = await child.exited;
	} finally {
		clearTimeout(timer);
	}
	const stdout = (await stdoutPromise).trim();
	const stderr = child.peekStderr().trim();
	if (exitCode === 0 && !timedOut) return;
	const detail = [stdout, stderr].filter(Boolean).join("\n");
	throw new Error(
		`Failed to ${label}${timedOut ? " before timeout" : ` (exit ${exitCode})`}${detail ? `\n${detail}` : ""}`,
	);
}

async function collectTail(stream: ReadableStream<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder();
	let output = "";
	for await (const chunk of stream) {
		output += decoder.decode(chunk, { stream: true });
		if (output.length > OUTPUT_TAIL_CHARS * 2) output = output.slice(-OUTPUT_TAIL_CHARS);
	}
	output += decoder.decode();
	return output.length > OUTPUT_TAIL_CHARS ? output.slice(-OUTPUT_TAIL_CHARS) : output;
}

function readJson<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(filePath: string, value: unknown): void {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw abortError(signal);
	return await Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
		}),
	]);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Operation aborted"));
}
