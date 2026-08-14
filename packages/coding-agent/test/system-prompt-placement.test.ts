import { describe, expect, test } from "bun:test";
import type { Context } from "@oh-my-soup/pi-ai";
import { applySystemPromptPlacement, resolveSystemPromptPlacement } from "../src/session/system-prompt-placement";

function baseContext(): Context {
	return {
		systemPrompt: ["You are a terse engineer.", "Follow the workspace rules."],
		messages: [{ role: "user", content: "hello", timestamp: 1234 }],
		tools: [],
	};
}

describe("resolveSystemPromptPlacement", () => {
	test("auto keeps the system channel unless the model opts out", () => {
		expect(resolveSystemPromptPlacement("auto", {})).toBe("system");
		expect(resolveSystemPromptPlacement("auto", { supportsSystemPrompt: true })).toBe("system");
		expect(resolveSystemPromptPlacement("auto", { supportsSystemPrompt: false })).toBe("first-turn");
	});

	test("forced modes override the model capability", () => {
		expect(resolveSystemPromptPlacement("system", { supportsSystemPrompt: false })).toBe("system");
		expect(resolveSystemPromptPlacement("first-turn", { supportsSystemPrompt: true })).toBe("first-turn");
	});
});

describe("applySystemPromptPlacement", () => {
	test("returns the context unchanged on the system channel", () => {
		const context = baseContext();
		expect(applySystemPromptPlacement(context, {}, "auto")).toBe(context);
		expect(applySystemPromptPlacement(context, { supportsSystemPrompt: false }, "system")).toBe(context);
	});

	test("relocates the prompt into a synthetic first user turn for incapable models", () => {
		const context = baseContext();
		const placed = applySystemPromptPlacement(context, { supportsSystemPrompt: false }, "auto");

		expect(placed.systemPrompt).toBeUndefined();
		expect(placed.messages).toHaveLength(2);
		const opener = placed.messages[0];
		expect(opener).toEqual({
			role: "user",
			content: "You are a terse engineer.\n\nFollow the workspace rules.",
			synthetic: true,
			timestamp: 0,
		});
		// Original conversation follows untouched; tools survive.
		expect(placed.messages[1]).toBe(context.messages[0]);
		expect(placed.tools).toBe(context.tools);
		// Input context is never mutated.
		expect(context.systemPrompt).toHaveLength(2);
		expect(context.messages).toHaveLength(1);
	});

	test("forced first-turn relocates even for capable models", () => {
		const placed = applySystemPromptPlacement(baseContext(), { supportsSystemPrompt: true }, "first-turn");
		expect(placed.systemPrompt).toBeUndefined();
		expect(placed.messages[0]?.role).toBe("user");
	});

	test("no prompt content means no synthetic turn", () => {
		const empty: Context = { systemPrompt: ["", "   "], messages: [], tools: undefined };
		expect(applySystemPromptPlacement(empty, { supportsSystemPrompt: false }, "auto")).toBe(empty);
		const absent: Context = { messages: [] };
		expect(applySystemPromptPlacement(absent, { supportsSystemPrompt: false }, "first-turn")).toBe(absent);
	});

	test("synthetic opener is byte-stable across requests", () => {
		const first = applySystemPromptPlacement(baseContext(), { supportsSystemPrompt: false }, "auto");
		const second = applySystemPromptPlacement(baseContext(), { supportsSystemPrompt: false }, "auto");
		expect(JSON.stringify(first.messages[0])).toBe(JSON.stringify(second.messages[0]));
	});
});
