/**
 * Inputs deciding whether the pre-load boot notice may be written for this
 * process. Mirrors the startup-splash decision options: pure data in, pure
 * boolean out, so the policy stays unit-testable without a terminal.
 */
export interface BootNoticeDecisionOptions {
	/** CLI argv after profile-flag extraction (empty for a plain `oms` launch). */
	argv: readonly string[];
	stdinIsTTY: boolean | undefined;
	stdoutIsTTY: boolean | undefined;
	stderrIsTTY: boolean | undefined;
}
