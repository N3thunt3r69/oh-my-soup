import { Process } from "@oh-my-soup/pi-natives";
import { killProcessGroup } from "./kernel-base";

/** Wall-clock ceiling for runtime discovery when the eval budget is larger or disabled. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface BackendProbeOptions {
	/** Cancels discovery with the caller's turn. */
	signal?: AbortSignal;
	/** Total discovery budget in milliseconds, capped at {@link DEFAULT_PROBE_TIMEOUT_MS}. */
	timeoutMs?: number;
}

export interface BoundedProbeResult {
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
}

export interface BoundedProbeSpawnOptions extends BackendProbeOptions {
	cwd: string;
	env: Record<string, string | undefined>;
}

function resolveProbeBound(timeoutMs: number | undefined): number {
	return Math.min(
		timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : DEFAULT_PROBE_TIMEOUT_MS,
		DEFAULT_PROBE_TIMEOUT_MS,
	);
}

/**
 * Force-kill an isolated probe and its descendants. The native tree walk
 * reaches children that created their own group; the POSIX group sweep closes
 * parent/child enumeration races inside the probe's detached session.
 */
function forceKillProbe(pid: number, directKill: () => void): void {
	let treeKilled = false;
	try {
		const processRef = Process.fromPid(pid);
		treeKilled = (processRef?.killTree(9) ?? 0) > 0;
	} catch {
		// Continue with the process-group/direct fallbacks.
	}
	const groupKilled = killProcessGroup(pid, "SIGKILL");
	if (treeKilled || groupKilled) return;
	directKill();
}

/** Spawn a probe without inherited stdio and reap it after timeout or cancellation. */
export async function runBoundedProbe(
	command: string[],
	{ cwd, env, signal, timeoutMs }: BoundedProbeSpawnOptions,
): Promise<BoundedProbeResult> {
	if (signal?.aborted) return { exitCode: null, timedOut: false, aborted: true };

	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		windowsHide: true,
		detached: process.platform !== "win32",
	});
	let termination: "timeout" | "abort" | undefined;
	const directKill = (): void => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// The direct child has already been reaped.
		}
	};
	const terminate = (reason: "timeout" | "abort"): void => {
		if (termination) return;
		termination = reason;
		forceKillProbe(proc.pid, directKill);
	};
	const timer = setTimeout(() => terminate("timeout"), resolveProbeBound(timeoutMs));
	const onAbort = (): void => terminate("abort");
	signal?.addEventListener("abort", onAbort, { once: true });
	// Close the check-to-listener race: abort may have happened during spawn.
	if (signal?.aborted) onAbort();
	try {
		const exitCode = await proc.exited;
		return {
			exitCode: termination ? null : exitCode,
			timedOut: termination === "timeout",
			aborted: termination === "abort",
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

export interface ProbeCandidate {
	command: string[];
	env: Record<string, string | undefined>;
	label: string;
}

export type CandidateProbeResult = { ok: true; index: number } | { ok: false; aborted: boolean; failures: string[] };

/** Probe ordered candidates under one shared discovery deadline. */
export async function probeCandidates(
	candidates: ProbeCandidate[],
	{ cwd, signal, timeoutMs }: BackendProbeOptions & { cwd: string },
): Promise<CandidateProbeResult> {
	const deadline = performance.now() + resolveProbeBound(timeoutMs);
	const failures: string[] = [];
	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		if (signal?.aborted) return { ok: false, aborted: true, failures };
		const remaining = deadline - performance.now();
		if (remaining <= 0) {
			failures.push(`${candidate.label} (probe budget exhausted)`);
			break;
		}
		try {
			const probe = await runBoundedProbe(candidate.command, {
				cwd,
				env: candidate.env,
				signal,
				timeoutMs: remaining,
			});
			if (probe.exitCode === 0) return { ok: true, index };
			if (probe.aborted) return { ok: false, aborted: true, failures };
			failures.push(
				probe.timedOut
					? `${candidate.label} (probe timed out)`
					: `${candidate.label} (exit code ${probe.exitCode})`,
			);
		} catch (error) {
			failures.push(`${candidate.label} (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	return { ok: false, aborted: false, failures };
}
