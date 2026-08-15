import type { BootNoticeDecisionOptions } from "../types/boot";

/**
 * One dim reassurance line written to stderr BEFORE the heavy command graph
 * loads, so slow starts (cold page cache, first launch after a reboot) show
 * activity instead of a blank terminal. Module evaluation blocks the event
 * loop, so this is deliberately a static line, not a spinner; the TUI's first
 * paint (or {@link clearBootNotice} on the root-command path) replaces it.
 */
const NOTICE = "\x1b[2m\u{1F35C} oms is starting\u2026 (first launch after a reboot takes longer)\x1b[0m";

let noticeShown = false;

/**
 * Decide whether the boot notice may be written: only a bare interactive
 * launch (`oms` with no arguments) on a real TTY qualifies. Any argument means
 * a subcommand, flag path, or piped usage whose stdout/stderr must stay clean.
 *
 * @param options - argv and TTY facts for this process.
 * @returns True when the notice should be written.
 */
export const shouldShowBootNotice = (options: BootNoticeDecisionOptions): boolean => {
	if (options.argv.length !== 0) return false;
	if (options.stdinIsTTY !== true) return false;
	if (options.stdoutIsTTY !== true) return false;
	return options.stderrIsTTY === true;
};

/** Write the boot notice when {@link shouldShowBootNotice} allows it. */
export const showBootNotice = (options: BootNoticeDecisionOptions): void => {
	if (!shouldShowBootNotice(options)) return;
	noticeShown = true;
	process.stderr.write(NOTICE);
};

/**
 * Erase the boot notice line once the command graph is loaded and the root
 * command is about to take over the terminal. Safe to call unconditionally;
 * a no-op when the notice was never written.
 */
export const clearBootNotice = (): void => {
	if (!noticeShown) return;
	noticeShown = false;
	process.stderr.write("\r\x1b[2K");
};
