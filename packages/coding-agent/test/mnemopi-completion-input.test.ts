import { describe, expect, it } from "bun:test";
import { resolveMemoryCompletionInput } from "../src/mnemopi/backend";
import memoryExtractionPrompt from "../src/prompts/system/memory-extraction-system.md" with { type: "text" };

describe("resolveMemoryCompletionInput", () => {
	it("splits an extraction call into instruction and input turns", () => {
		const rendered = "whatever Mnemopi rendered for the prompt slot";
		const request = resolveMemoryCompletionInput(rendered, {
			task: { kind: "memory-extraction", input: "Sam works at Globex." },
		});
		expect(request.systemPrompt).toBe(memoryExtractionPrompt);
		expect(request.prompt).toBe("Sam works at Globex.");
		expect(request.prompt).not.toContain("rendered");
	});

	it("keeps the rendered prompt and adds no system turn without an extraction task", () => {
		const rendered = "Summarize these memories faithfully.";
		expect(resolveMemoryCompletionInput(rendered)).toEqual({ prompt: rendered });
		expect(resolveMemoryCompletionInput(rendered, {})).toEqual({ prompt: rendered });
		expect(resolveMemoryCompletionInput(rendered, { maxTokens: 256 })).toEqual({ prompt: rendered });
	});

	it("does not leak the extraction instructions into the user turn", () => {
		const request = resolveMemoryCompletionInput("ignored", {
			task: { kind: "memory-extraction", input: "Sam prefers dark mode." },
		});
		expect(request.prompt).toBe("Sam prefers dark mode.");
		expect(memoryExtractionPrompt).not.toContain("Sam prefers dark mode.");
	});
});
