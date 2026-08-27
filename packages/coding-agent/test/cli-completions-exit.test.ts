import { afterEach, describe, expect, it, vi } from "bun:test";
import Completions from "@oh-my-soup/pi-coding-agent/commands/completions";
import { postmortem } from "@oh-my-soup/pi-utils";

describe("Completions command exit contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("quits cleanly after writing the generated script", async () => {
		const writeSpy = vi.spyOn(Bun, "write").mockResolvedValue(0);
		const quitSpy = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		const command = new Completions(["zsh"], {
			bin: "oms",
			version: "0.0.0-test",
			commands: new Map(),
		});

		await command.run();

		expect(writeSpy).toHaveBeenCalled();
		expect(writeSpy.mock.invocationCallOrder[0]).toBeLessThan(quitSpy.mock.invocationCallOrder[0]);
		expect(quitSpy).toHaveBeenCalledWith(0);
	});
});
