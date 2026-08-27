import { afterEach, describe, expect, it, vi } from "bun:test";
import { dropSettingsGroupShadows } from "@oh-my-soup/pi-coding-agent/config/settings";
import { logger } from "@oh-my-soup/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("dropSettingsGroupShadows", () => {
	it("drops a non-object leaf that would shadow a settings group", () => {
		expect(dropSettingsGroupShadows({ tui: "fullscreen" }, "/proj/.claude/settings.json")).toEqual({});
	});

	it("keeps well-formed nested objects for a settings group", () => {
		const result = dropSettingsGroupShadows({ tui: { resizeScrollback: "preserve" } }, "/proj/.claude/settings.json");
		expect(result).toEqual({ tui: { resizeScrollback: "preserve" } });
	});

	it("drops nested non-object shadows without discarding valid siblings", () => {
		const result = dropSettingsGroupShadows(
			{ auth: { broker: "nonsense" }, autoResume: true },
			"/proj/.claude/settings.json",
		);
		expect(result).toEqual({ auth: {}, autoResume: true });
	});

	it("drops a top-level model string that would shadow model.*", () => {
		expect(dropSettingsGroupShadows({ model: "opus" }, "/proj/.claude/settings.json")).toEqual({});
	});

	it("passes unknown keys and schema leaves through untouched", () => {
		const input = {
			permissions: { allow: ["Bash"] },
			$schema: "https://json.schemastore.org/claude-code-settings.json",
			cycleOrder: ["a", "b"],
		};
		expect(dropSettingsGroupShadows(input, "/proj/.claude/settings.json")).toEqual(input);
	});

	it("warns with the setting and source without logging the ignored value", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const secret = "sensitive-project-value";
		dropSettingsGroupShadows({ tui: secret }, "/proj/.claude/settings.json");

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith("Settings: ignoring project setting that would shadow a settings group", {
			setting: "tui",
			source: "/proj/.claude/settings.json",
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
	});
});
