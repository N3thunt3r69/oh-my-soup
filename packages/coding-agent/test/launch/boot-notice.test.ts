import { describe, expect, it } from "bun:test";
import { shouldShowBootNotice } from "../../src/launch/boot-notice";

const tty = { stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true } as const;

describe("boot notice decision", () => {
	it("allows only a bare interactive TTY launch", () => {
		expect(shouldShowBootNotice({ argv: [], ...tty })).toBe(true);
	});

	it("stays silent for any argument (subcommands, flags, fast paths)", () => {
		for (const argv of [["--version"], ["--help"], ["-p", "hi"], ["stats"], ["--mode", "rpc"], ["--resume"]]) {
			expect(shouldShowBootNotice({ argv, ...tty })).toBe(false);
		}
	});

	it("stays silent when any stream is not a TTY", () => {
		expect(shouldShowBootNotice({ argv: [], ...tty, stdoutIsTTY: false })).toBe(false);
		expect(shouldShowBootNotice({ argv: [], ...tty, stdinIsTTY: undefined })).toBe(false);
		expect(shouldShowBootNotice({ argv: [], ...tty, stderrIsTTY: false })).toBe(false);
	});
});
