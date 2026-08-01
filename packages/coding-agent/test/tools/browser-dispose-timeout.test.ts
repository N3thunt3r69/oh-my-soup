/**
 * Regression test for issue #5260: the browser tool can hang indefinitely at
 * the "Closing tab" phase.
 *
 * Headless Camoufox handles are virtual (the worker owns the live browser), so
 * dispose no longer awaits a wedged `browser.close()` — it kills the engine
 * pid reported by the worker. The kill itself is bounded: a wedged engine
 * that never answers SIGTERM must not freeze `releaseBrowser` either, so the
 * wait is capped and cleanup always completes.
 */

import { describe, expect, it, spyOn } from "bun:test";
import * as attach from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";

/** Build a headless handle whose engine pid is (or is not) known. */
function makeHeadlessHandle(pid: number | undefined): BrowserHandle {
	return {
		key: `headless:1:test-${pid ?? "nopid"}`,
		kind: { kind: "headless", headless: true },
		refCount: 1,
		pid,
	} as unknown as BrowserHandle;
}

describe("browser dispose — headless engine kill must not hang forever (issue #5260)", () => {
	it("bounds a wedged engine kill and still completes cleanup", async () => {
		const killSpy = spyOn(attach, "gracefulKillTreeOnce").mockImplementation(
			() => new Promise<void>(() => {}), // never resolves
		);
		try {
			const start = Date.now();
			await releaseBrowser(makeHeadlessHandle(4242), { kill: false });
			const elapsed = Date.now() - start;

			// The kill was attempted, but the release still returned rather than
			// hanging on the never-resolving promise.
			expect(killSpy).toHaveBeenCalledTimes(1);
			expect(killSpy.mock.calls[0]?.[0]).toBe(4242);
			expect(elapsed).toBeLessThan(15_000);
		} finally {
			killSpy.mockRestore();
		}
	}, 20_000);

	it("does not attempt a kill when no engine pid was reported", async () => {
		const killSpy = spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		try {
			await releaseBrowser(makeHeadlessHandle(undefined), { kill: false });
			expect(killSpy).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
		}
	}, 20_000);
});
