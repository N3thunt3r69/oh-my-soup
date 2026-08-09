import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { getConfigRootDir, ptree } from "@oh-my-soup/pi-utils";
import bundleText from "./ida-bridge.bundle.txt" with { type: "text" };

const BUNDLE_FORMAT = 1;
const RUNTIME_FORMAT = 1;
const PROCESS_TIMEOUT_MS = 180_000;
const OUTPUT_TAIL_CHARS = 32 * 1024;
const DEPENDENCIES = [
	"annotated-types==0.8.0",
	"apsw==3.53.4.0",
	"pydantic==2.13.4",
	"pydantic-core==2.46.4",
	"typing-extensions==4.16.0",
	"typing-inspection==0.4.2",
	"websocket-client==1.9.0",
	"websockets==17.0.1",
] as const;
const IMPORT_PROBE = [
	"import apsw",
	"import pydantic",
	"import websocket",
	"import websockets",
	"import ida_bridge.server",
	"print('oms-ida-bridge-ready')",
].join(";");

interface EmbeddedBundle {
	format: number;
	repository: string;
	revision: string;
	license: string;
	files: Record<string, string>;
}

interface SourceMarker {
	format: number;
	revision: string;
	digest: string;
}

interface RuntimeMarker {
	format: number;
	fingerprint: string;
	revision: string;
	dependencies: readonly string[];
}

export interface BundledIdaBridgeRuntime {
	basePython: string;
	python: string;
	sourceDirectory: string;
	environmentDirectory: string;
	fingerprint: string;
}

const bundle = parseBundle();
const bundleDigest = crypto.createHash("sha256").update(bundleText.trim()).digest("hex");
const runtimePreparations = new Map<string, Promise<void>>();

/** Resolve OMS-owned ida-bridge source and a private environment for one Python interpreter. */
export function resolveBundledIdaBridge(basePython: string): BundledIdaBridgeRuntime {
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
				bundle.revision,
				DEPENDENCIES,
			]),
		)
		.digest("hex");
	const sourceDirectory = installBundledSource();
	const environmentDirectory = path.join(getConfigRootDir(), "ida", "python", fingerprint.slice(0, 20));
	return {
		basePython: canonicalPython,
		python: virtualEnvironmentPython(environmentDirectory),
		sourceDirectory,
		environmentDirectory,
		fingerprint,
	};
}

/** Ensure the private Python environment contains the bundled bridge's pinned dependencies. */
export async function ensureBundledIdaBridge(
	runtime: BundledIdaBridgeRuntime,
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

function parseBundle(): EmbeddedBundle {
	let value: unknown;
	try {
		value = JSON.parse(gunzipSync(Buffer.from(bundleText.trim(), "base64")).toString("utf8"));
	} catch (error) {
		throw new Error("The embedded ida-bridge bundle is corrupt", { cause: error });
	}
	if (!value || typeof value !== "object") throw new Error("The embedded ida-bridge bundle is invalid");
	const candidate = value as Partial<EmbeddedBundle>;
	if (
		candidate.format !== BUNDLE_FORMAT ||
		typeof candidate.repository !== "string" ||
		typeof candidate.revision !== "string" ||
		typeof candidate.license !== "string" ||
		!candidate.files ||
		typeof candidate.files !== "object"
	) {
		throw new Error("The embedded ida-bridge bundle metadata is invalid");
	}
	for (const [name, content] of Object.entries(candidate.files)) {
		if (!isSafeBundlePath(name) || typeof content !== "string") {
			throw new Error(`The embedded ida-bridge bundle contains an invalid path: ${name}`);
		}
	}
	if (!("ida_bridge/server.py" in candidate.files) || !("ida_bridge/idalib_runner.py" in candidate.files)) {
		throw new Error("The embedded ida-bridge bundle is incomplete");
	}
	return candidate as EmbeddedBundle;
}

function isSafeBundlePath(value: string): boolean {
	if (!value.startsWith("ida_bridge/") || value.includes("\\")) return false;
	const segments = value.split("/");
	return segments.every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function installBundledSource(): string {
	const parent = path.join(getConfigRootDir(), "ida", "bridge");
	const destination = path.join(parent, bundle.revision);
	if (sourceMarkerMatches(destination)) return destination;
	fs.mkdirSync(parent, { recursive: true });
	const temporary = fs.mkdtempSync(path.join(parent, `.install-${process.pid}-`));
	try {
		for (const [relativePath, content] of Object.entries(bundle.files)) {
			const outputPath = path.join(temporary, ...relativePath.split("/"));
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			fs.writeFileSync(outputPath, content, "utf8");
		}
		fs.writeFileSync(
			path.join(temporary, "NOTICE.txt"),
			[
				"ida-bridge",
				`Source: ${bundle.repository}`,
				`Revision: ${bundle.revision}`,
				`License declared by upstream: ${bundle.license}`,
				"Bundled by Oh My Soup for its managed IDA backend.",
				"",
			].join("\n"),
			"utf8",
		);
		writeJson(path.join(temporary, ".oms-source.json"), {
			format: BUNDLE_FORMAT,
			revision: bundle.revision,
			digest: bundleDigest,
		} satisfies SourceMarker);
		if (sourceMarkerMatches(destination)) return destination;
		fs.rmSync(destination, { recursive: true, force: true });
		fs.renameSync(temporary, destination);
		return destination;
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

function sourceMarkerMatches(directory: string): boolean {
	const marker = readJson<Partial<SourceMarker>>(path.join(directory, ".oms-source.json"));
	return marker?.format === BUNDLE_FORMAT && marker.revision === bundle.revision && marker.digest === bundleDigest;
}

async function prepareRuntime(
	runtime: BundledIdaBridgeRuntime,
	env: Record<string, string | undefined>,
	cwd: string,
): Promise<void> {
	if (runtimeMarkerMatches(runtime) && (await probeRuntime(runtime.python, env, cwd))) return;
	const parent = path.dirname(runtime.environmentDirectory);
	fs.mkdirSync(parent, { recursive: true });
	const temporary = fs.mkdtempSync(path.join(parent, `.venv-${process.pid}-`));
	try {
		await runChecked(
			[runtime.basePython, "-m", "venv", "--system-site-packages", temporary],
			`create OMS's private IDA Python environment with ${runtime.basePython}`,
			env,
			cwd,
		);
		const temporaryPython = virtualEnvironmentPython(temporary);
		await runChecked(
			[
				temporaryPython,
				"-m",
				"pip",
				"install",
				"--disable-pip-version-check",
				"--no-input",
				"--no-deps",
				"--only-binary=:all:",
				"--no-warn-script-location",
				...DEPENDENCIES,
			],
			"provision OMS's bundled ida-bridge dependencies",
			env,
			cwd,
		);
		writeJson(path.join(temporary, ".oms-runtime.json"), runtimeMarker(runtime));
		if (!runtimeMarkerMatches(runtime)) {
			fs.rmSync(runtime.environmentDirectory, { recursive: true, force: true });
			fs.renameSync(temporary, runtime.environmentDirectory);
		}
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
	if (!(await probeRuntime(runtime.python, env, cwd))) {
		fs.rmSync(runtime.environmentDirectory, { recursive: true, force: true });
		throw new Error(`OMS's bundled ida-bridge environment failed its import check: ${runtime.python}`);
	}
}

function runtimeMarker(runtime: BundledIdaBridgeRuntime): RuntimeMarker {
	return {
		format: RUNTIME_FORMAT,
		fingerprint: runtime.fingerprint,
		revision: bundle.revision,
		dependencies: DEPENDENCIES,
	};
}

function runtimeMarkerMatches(runtime: BundledIdaBridgeRuntime): boolean {
	if (!fs.existsSync(runtime.python)) return false;
	const marker = readJson<Partial<RuntimeMarker>>(path.join(runtime.environmentDirectory, ".oms-runtime.json"));
	return (
		marker?.format === RUNTIME_FORMAT &&
		marker.fingerprint === runtime.fingerprint &&
		marker.revision === bundle.revision &&
		JSON.stringify(marker.dependencies) === JSON.stringify(DEPENDENCIES)
	);
}

async function probeRuntime(python: string, env: Record<string, string | undefined>, cwd: string): Promise<boolean> {
	try {
		await runChecked([python, "-c", IMPORT_PROBE], "validate OMS's bundled ida-bridge runtime", env, cwd);
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
	try {
		for await (const chunk of stream) {
			output += decoder.decode(chunk, { stream: true });
			if (output.length > OUTPUT_TAIL_CHARS) output = output.slice(-OUTPUT_TAIL_CHARS);
		}
		output += decoder.decode();
	} catch {
		// Process termination can close the stream abruptly.
	}
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
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Operation aborted"));
}
