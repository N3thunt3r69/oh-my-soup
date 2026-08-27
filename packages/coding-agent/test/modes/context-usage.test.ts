/**
 * Contract: tool schema token estimation reflects the wire JSON Schema.
 *
 * Tools authored with arktype must be counted by the JSON Schema providers
 * actually receive — not by stringifying the arktype instance's enumerable
 * internals, which massively overcounts.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-soup/omstype";
import { Tokenizer } from "@oh-my-soup/pi-agent-core";
import { arkToWireSchema } from "@oh-my-soup/pi-ai/utils/schema";
import {
	type ContextBreakdown,
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	estimateToolSchemaTokens,
	renderContextUsage,
} from "@oh-my-soup/pi-coding-agent/modes/utils/context-usage";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";

const tokenizer = new Tokenizer();

const strictTokenizer = {
	countTokens(input: string | readonly string[]): number {
		const fragments = typeof input === "string" ? [input] : Array.from(input);
		for (const fragment of fragments) {
			if (typeof fragment !== "string") throw new TypeError("non-string token fragment");
		}
		return fragments.reduce((total, fragment) => total + fragment.length, 0);
	},
} as never;

function bindCapableSchema() {
	return Object.assign((value: unknown) => value, {
		toJsonSchema: () => ({ type: "object", properties: { a: { type: "string" } } }),
		assert: (value: unknown) => value,
	});
}

describe("estimateToolSchemaTokens", () => {
	it("counts arktype tool schemas by their wire JSON Schema, not arktype internals", () => {
		const parameters = type({
			"query /** search query */": "string",
			"limit?": "number",
		});
		const arktypeEstimate = estimateToolSchemaTokens(
			[{ name: "web_search", description: "Searches the web.", parameters } as never],
			tokenizer,
		);
		const wireEstimate = estimateToolSchemaTokens(
			[{ name: "web_search", description: "Searches the web.", parameters: arkToWireSchema(parameters) } as never],
			tokenizer,
		);
		expect(arktypeEstimate).toBe(wireEstimate);
	});

	it("counts a proxied bind-capable callable schema like the unwrapped tool", () => {
		const schema = bindCapableSchema();
		const unwrapped = { name: "ext", description: "ext tool", parameters: schema };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(unwrapped, wrapper);

		expect(estimateToolSchemaTokens([wrapper as never], tokenizer)).toBe(
			estimateToolSchemaTokens([unwrapped as never], tokenizer),
		);
		expect(estimateToolSchemaTokens([wrapper as never], tokenizer)).toBeGreaterThan(0);
	});

	it("runs the full non-message breakdown on a proxied extension tool", () => {
		const schema = bindCapableSchema();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy({ name: "ext", description: "ext tool", parameters: schema }, wrapper);
		const session = { systemPrompt: ["base"], agent: { state: { tools: [wrapper] } } };

		expect(computeNonMessageBreakdown(session as never, tokenizer).toolsTokens).toBeGreaterThan(0);
	});

	it("skips a parameters value that stringifies to undefined", () => {
		const estimate = estimateToolSchemaTokens(
			[{ name: "odd", description: "odd tool", parameters: function bareSchema() {} } as never],
			tokenizer,
		);
		expect(estimate).toBe(estimateToolSchemaTokens([{ name: "odd", description: "odd tool" } as never], tokenizer));
	});
});

/**
 * Contract: the /context panel surfaces estimated snapcompact wire savings —
 * applied swaps show "saves" figures, inactive states say why.
 */
describe("renderContextUsage snapcompact section", () => {
	const themeStub = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as never;

	function breakdownWith(snapcompact: ContextBreakdown["snapcompact"]): ContextBreakdown {
		return {
			model: { id: "test-model", name: "Test Model", contextWindow: 200000 } as never,
			contextWindow: 200000,
			categories: [],
			usedTokens: 27929,
			autoCompactBufferTokens: 0,
			freeTokens: 172071,
			snapcompact,
		};
	}

	it("renders savings, skip reasons, and the wire total", () => {
		const output = renderContextUsage(
			breakdownWith({
				visionCapable: true,
				systemPrompt: {
					applied: true,
					scope: "all",
					textTokens: 9768,
					frames: 2,
					imageTokens: 6600,
					savedTokens: 3168,
				},
				toolResults: { total: 3, swapped: 0, textTokens: 0, frames: 0, imageTokens: 0, savedTokens: 0 },
				savedTokens: 3168,
			}),
			themeStub,
		);
		expect(output).toContain("Snapcompact (estimated wire savings)");
		expect(output).toContain("System prompt (all): saves ~3.2K (9.8K text → 2 frames ≈ 6.6K)");
		expect(output).toContain("Tool results: none imaged (3 in history)");
		// 27929 logical − 3168 saved ≈ 25K on the wire.
		expect(output).toContain("Next request: ~25K tokens on the wire");
	});

	it("reports text-only models as inactive", () => {
		const output = renderContextUsage(breakdownWith({ visionCapable: false, savedTokens: 0 }), themeStub);
		expect(output).toContain("Snapcompact: inactive (model has no image input)");
	});

	it("omits the section entirely when no snapcompact setting is on", () => {
		const output = renderContextUsage(breakdownWith(undefined), themeStub);
		expect(output).not.toContain("Snapcompact");
	});
});

/**
 * Contract: the non-message token totals reflect the CURRENT system prompt,
 * tools, and skills — including after they change via reference replacement
 * (the setSystemPrompt/setTools pattern), and stay stable while those inputs
 * hold the same identity. The memo must never serve a stale value for changed
 * inputs.
 */
describe("computeNonMessageTokens / computeNonMessageBreakdown memoization", () => {
	function makeSession(systemPrompt: string[], tools: unknown[] = [], skills: unknown[] = []) {
		return { systemPrompt, agent: { state: { tools } }, skills };
	}

	it("recomputes when the system prompt reference changes and caches otherwise", () => {
		const session = makeSession(["system prompt alpha"]);
		const first = computeNonMessageTokens(session as never, tokenizer);
		// Same inputs (identical refs) → cached, identical value.
		expect(computeNonMessageTokens(session as never, tokenizer)).toBe(first);
		// Replace the system prompt reference (mirrors setSystemPrompt).
		session.systemPrompt = ["system prompt beta with more tokens than alpha"];
		const afterChange = computeNonMessageTokens(session as never, tokenizer);
		expect(afterChange).toBeGreaterThan(first);
		// Cached on the new inputs.
		expect(computeNonMessageTokens(session as never, tokenizer)).toBe(afterChange);
	});

	it("recomputes the breakdown when the tools reference changes", () => {
		const session = makeSession(["base"], []);
		const before = computeNonMessageBreakdown(session as never, tokenizer);
		expect(before.toolsTokens).toBe(0);
		// New tools array reference (mirrors setTools).
		session.agent.state.tools = [{ name: "search", description: "search the web", parameters: {} }];
		const after = computeNonMessageBreakdown(session as never, tokenizer);
		expect(after.toolsTokens).toBeGreaterThan(0);
		// Cached on the new tools.
		expect(computeNonMessageBreakdown(session as never, tokenizer).toolsTokens).toBe(after.toolsTokens);
	});

	it("shares one cache entry so tokens and breakdown invalidate together", () => {
		const session = makeSession(["shared prompt"]);
		const tokens = computeNonMessageTokens(session as never, tokenizer);
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		// Changing the system prompt ref must invalidate BOTH fields, not just
		// the one most recently touched.
		session.systemPrompt = ["shared prompt but longer now to shift the count"];
		expect(computeNonMessageTokens(session as never, tokenizer)).not.toBe(tokens);
		expect(computeNonMessageBreakdown(session as never, tokenizer).systemPromptTokens).not.toBe(
			breakdown.systemPromptTokens,
		);
	});
});

/**
 * Contract: the Skills category counts only skills actually rendered into the
 * system prompt (mirroring `buildSystemPrompt`'s filter) — hidden/explicit-only
 * skills, and every skill when the `read` tool is absent, contribute zero. The
 * System-prompt subtraction must not be inflated by unrendered skill metadata
 * and clamped to 0 (issue #6498).
 */
describe("computeNonMessageBreakdown skills filtering", () => {
	const readTool = { name: "read", description: "read files", parameters: {} };
	const hidden = { name: "hidden-skill", description: "X".repeat(4000), filePath: "/s/h.md", hide: true };
	const visible = { name: "vis", description: "small visible skill", filePath: "/s/v.md" };
	// First prompt block as rendered: only the visible skill appears.
	const renderedPrompt = "You are an agent.\nSkills:\n- vis: small visible skill\n";

	function session(tools: unknown[], skills: unknown[]) {
		return { systemPrompt: [renderedPrompt], agent: { state: { tools } }, skills } as never;
	}

	it("excludes hidden skills and does not clamp System prompt to 0", () => {
		const b = computeNonMessageBreakdown(session([readTool], [hidden, visible]), tokenizer);
		// Only the visible skill is counted, not the large hidden one.
		expect(b.skillsTokens).toBe(computeNonMessageBreakdown(session([readTool], [visible]), tokenizer).skillsTokens);
		expect(b.skillsTokens).toBeLessThan(100);
		expect(b.systemPromptTokens).toBeGreaterThan(0);
	});

	it("counts zero Skills tokens when the read tool is unavailable", () => {
		const b = computeNonMessageBreakdown(session([], [hidden, visible]), tokenizer);
		expect(b.skillsTokens).toBe(0);
		expect(b.systemPromptTokens).toBe(computeNonMessageBreakdown(session([], []), tokenizer).systemPromptTokens);
	});
});

describe("non-message estimates tolerate absent values without hiding malformed values", () => {
	const readTool = { name: "read", description: "read files", parameters: {} };

	it("accepts undefined tool and skill descriptions", () => {
		const toolTokens = estimateToolSchemaTokens(
			[{ name: "lens_tool", description: undefined, parameters: {} } as never],
			strictTokenizer,
		);
		const breakdown = computeNonMessageBreakdown(
			{
				systemPrompt: ["You are an agent."],
				agent: { state: { tools: [readTool] } },
				skills: [{ name: "lens", description: undefined, filePath: "/s/l.md" } as never],
			},
			strictTokenizer,
		);

		expect(Number.isFinite(toolTokens)).toBe(true);
		expect(breakdown.skillsTokens).toBe("lens".length);
	});

	it("densifies sparse system-prompt arrays in collapsed and breakdown estimates", () => {
		const systemPrompt = new Array<string>(3);
		systemPrompt[0] = "primary";
		systemPrompt[2] = "trailing";
		const session = { systemPrompt, agent: { state: { tools: [] } }, skills: [] };

		expect(computeNonMessageTokens(session, strictTokenizer)).toBe("primarytrailing".length);
		expect(computeNonMessageBreakdown(session, strictTokenizer)).toEqual({
			skillsTokens: 0,
			toolsTokens: 0,
			systemContextTokens: "trailing".length,
			systemPromptTokens: "primary".length,
		});
	});

	it("still rejects present non-string prompt sections and descriptions", () => {
		const malformedPrompt = {
			systemPrompt: ["primary", { text: "not a string" } as never],
			agent: { state: { tools: [] } },
			skills: [],
		};

		expect(() => computeNonMessageTokens(malformedPrompt, strictTokenizer)).toThrow("non-string token fragment");
		expect(() => computeNonMessageBreakdown(malformedPrompt, strictTokenizer)).toThrow("non-string token fragment");
		expect(() =>
			estimateToolSchemaTokens(
				[{ name: "lens_tool", description: { text: "not a string" }, parameters: {} } as never],
				strictTokenizer,
			),
		).toThrow("non-string token fragment");
	});
});
