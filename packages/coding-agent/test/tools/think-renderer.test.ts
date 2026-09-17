import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-soup/pi-ai";
import { ThinkingInbandScanner } from "@oh-my-soup/pi-ai/dialect";
import { AssistantMessageComponent } from "@oh-my-soup/pi-coding-agent/modes/components/assistant-message";
import { getThemeByName, initTheme } from "@oh-my-soup/pi-coding-agent/modes/theme/theme";
import { ThinkTool, thinkToolRenderer } from "../../src/tools/think";

beforeAll(async () => {
	await initTheme();
});

function scratchpadMessage(thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("thinkToolRenderer", () => {
	it("renders thoughts with thinkingText color and italic style", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const callComponent = thinkToolRenderer.renderCall(
			{ thoughts: "Cache the parsed config, then check invalidation." },
			{ expanded: true, isPartial: false },
			uiTheme,
		);

		expect(callComponent).toBeDefined();
		const lines = callComponent.render(100);
		const fullText = lines.join("\n");

		expect(fullText).toContain("Cache the parsed config, then check invalidation.");
		expect(fullText).toContain(uiTheme.fg("thinkingText", "Cache the parsed config, then check invalidation."));
	});

	it.each([
		["<thinking>", "</thinking>"],
		["<think>", "</think>"],
		["<scratchpad>", "</scratchpad>"],
	])("renders parsed %s scratchpads like explicit tool calls without leaking tags", async (open, close) => {
		const scanner = new ThinkingInbandScanner();
		const events = [
			...scanner.feed(`Before ${open.slice(0, 3)}`),
			...scanner.feed(`${open.slice(3)}Compare the invariants`),
			...scanner.feed(`${close.slice(0, -2)}`),
			...scanner.feed(`${close.slice(-2)} after.`),
			...scanner.flush(),
		];
		const visibleText = events
			.filter((event): event is Extract<(typeof events)[number], { type: "text" }> => event.type === "text")
			.map(event => event.text)
			.join("");
		const scratchpad = events
			.filter(
				(event): event is Extract<(typeof events)[number], { type: "thinkingDelta" }> =>
					event.type === "thinkingDelta",
			)
			.map(event => event.delta)
			.join("");

		expect(visibleText).toBe("Before  after.");
		expect(visibleText).not.toContain(open);
		expect(visibleText).not.toContain(close);
		expect(scratchpad).toBe("Compare the invariants");
		expect(events.some(event => event.type === "toolStart" || event.type === "toolEnd")).toBe(false);

		const uiTheme = (await getThemeByName("dark"))!;
		const parsed = new AssistantMessageComponent(scratchpadMessage(scratchpad)).render(100);
		const explicit = thinkToolRenderer
			.renderCall({ thoughts: scratchpad }, { expanded: true, isPartial: false }, uiTheme)
			.render(100);
		expect(parsed).toEqual(explicit);
	});

	it("returns a minimal continuation result", async () => {
		const result = await new ThinkTool().execute("think-1", { thoughts: "Check the boundary." });
		expect(result).toEqual({
			content: [{ type: "text", text: "Continue." }],
			details: { recorded: true },
		});
	});

	it("has inline set to true", () => {
		expect(thinkToolRenderer.inline).toBe(true);
	});

	it("returns undefined for renderResult", () => {
		expect(thinkToolRenderer.renderResult()).toBeUndefined();
	});

	it("handles empty or missing thoughts gracefully", async () => {
		const theme = await getThemeByName("dark");
		const uiTheme = theme!;

		const emptyCall = thinkToolRenderer.renderCall({}, { expanded: true, isPartial: false }, uiTheme);
		expect(emptyCall).toBeDefined();
		expect(emptyCall.render(100)).toEqual([]);
	});
});
