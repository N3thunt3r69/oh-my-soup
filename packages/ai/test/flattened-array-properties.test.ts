import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-soup/omstype";
import type { Tool } from "@oh-my-soup/pi-ai/types";
import { validateToolArguments } from "@oh-my-soup/pi-ai/utils/validation";

const questionItem = type({
	id: type("string"),
	question: type("string"),
	options: type({ label: type("string") }).array(),
	"recommended?": type("number"),
});

const askTool: Tool = {
	name: "ask",
	description: "Ask the user a question",
	parameters: type({ questions: questionItem.array().atLeastLength(1) }),
};

function callWith(
	parameters: Record<string, unknown>,
	tool: Tool = askTool,
): { success: boolean; args: unknown; error?: unknown } {
	try {
		return {
			success: true,
			args: validateToolArguments(tool, {
				type: "toolCall",
				id: "call-1",
				name: tool.name,
				arguments: parameters,
			}),
		};
	} catch (error) {
		return { success: false, args: parameters, error };
	}
}

describe("flattened array-property normalization", () => {
	it("rebuilds nested arrays and objects before validation", () => {
		const result = callWith({
			"questions[0].id": "doc_structure",
			"questions[0].question": "Which format should we adopt?",
			"questions[0].options[0].label": "Structured Markdown",
			"questions[0].options[1].label": "Plain text",
			"questions[0].recommended": 0,
		});

		expect(result.success).toBe(true);
		expect(result.args).toEqual({
			questions: [
				{
					id: "doc_structure",
					question: "Which format should we adopt?",
					options: [{ label: "Structured Markdown" }, { label: "Plain text" }],
					recommended: 0,
				},
			],
		});
	});

	it("handles multiple array elements across one property", () => {
		const result = callWith({
			"questions[0].id": "q1",
			"questions[0].question": "First",
			"questions[0].options[0].label": "A",
			"questions[1].id": "q2",
			"questions[1].question": "Second",
			"questions[1].options[0].label": "B",
		});

		expect(result.success).toBe(true);
		expect(result.args).toEqual({
			questions: [
				{ id: "q1", question: "First", options: [{ label: "A" }] },
				{ id: "q2", question: "Second", options: [{ label: "B" }] },
			],
		});
	});

	it("supports bare leaf array elements", () => {
		const tool: Tool = {
			name: "tags",
			description: "",
			parameters: type({ tags: type("string").array().atLeastLength(2) }),
		};
		const result = callWith({ "tags[0]": "alpha", "tags[1]": "beta" }, tool);
		expect(result.success).toBe(true);
		expect(result.args).toEqual({ tags: ["alpha", "beta"] });
	});

	it("preserves non-flattened sibling keys", () => {
		const tool: Tool = {
			name: "questions",
			description: "",
			parameters: type({ title: type("string"), questions: questionItem.array().atLeastLength(1) }),
		};
		const result = callWith(
			{
				title: "Session",
				"questions[0].id": "q",
				"questions[0].question": "Go?",
				"questions[0].options[0].label": "Yes",
			},
			tool,
		);
		expect(result.success).toBe(true);
		expect(result.args).toEqual({
			title: "Session",
			questions: [{ id: "q", question: "Go?", options: [{ label: "Yes" }] }],
		});
	});

	it("leaves already nested arrays untouched", () => {
		const args = { questions: [{ id: "q", question: "Go?", options: [{ label: "Yes" }] }] };
		const result = callWith(args);
		expect(result.success).toBe(true);
		expect(result.args).toEqual(args);
	});

	it("leaves non-array dotted keys untouched", () => {
		const tool: Tool = {
			name: "literal",
			description: "",
			parameters: type({ "a.b": type("number"), c: type("number") }),
		};
		const args = { "a.b": 1, c: 2 };
		const result = callWith(args, tool);
		expect(result.success).toBe(true);
		expect(result.args).toEqual(args);
	});

	it("leaves malformed indexed keys untouched and surfaces validation", () => {
		expect(callWith({ "questions[foo]": "nope" }).success).toBe(false);
		expect(callWith({ label: "300" }).success).toBe(false);
	});

	it("rejects literal-root collisions without mutating caller containers", () => {
		const questions: unknown[] = [];
		const result = callWith({ questions, "questions[0].id": "x" });
		expect(result.success).toBe(false);
		expect(questions).toEqual([]);
	});

	it("rejects prefix/leaf collisions instead of overwriting either value", () => {
		const tool: Tool = {
			name: "items",
			description: "",
			parameters: type({ items: type({ label: type("string") }).array() }),
		};
		const result = callWith({ "items[0]": "scalar", "items[0].label": "nested" }, tool);
		expect(result.success).toBe(false);
	});

	it("keeps prototype-named path segments inert", () => {
		const tool: Tool = {
			name: "items",
			description: "",
			parameters: type({ items: type({ label: type("string") }).array() }),
		};
		const result = callWith({ "items[0].__proto__.polluted": "yes" }, tool);
		expect(result.success).toBe(false);
		expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
	});
});
