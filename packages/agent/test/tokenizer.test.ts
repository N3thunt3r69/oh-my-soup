import { describe, expect, test } from "bun:test";
import { Encoding } from "@oh-my-soup/pi-natives";
import { Tokenizer, tokenizerEncodingForModel } from "../src/tokenizer";

describe("tokenizerEncodingForModel", () => {
	test("maps every catalog tokenizer family to its native counter", () => {
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v3" })).toBe(Encoding.ClaudeV3);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v47" })).toBe(Encoding.ClaudeV47);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v5" })).toBe(Encoding.ClaudeV5);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v5-sonnet" })).toBe(Encoding.ClaudeV5Sonnet);
		expect(tokenizerEncodingForModel({ tokenizer: "qwen3" })).toBe(Encoding.Qwen3);
		expect(tokenizerEncodingForModel({ tokenizer: "deepseek-v3" })).toBe(Encoding.DeepSeekV3);
		expect(tokenizerEncodingForModel({ tokenizer: "kimi-k2" })).toBe(Encoding.KimiK2);
		expect(tokenizerEncodingForModel({ tokenizer: "glm5" })).toBe(Encoding.Glm5);
	});

	test("leaves unknown catalog models on the estimate policy", () => {
		expect(tokenizerEncodingForModel({})).toBeNull();
		expect(tokenizerEncodingForModel(undefined)).toBeNull();
	});
});

describe("Tokenizer", () => {
	test("defaults to null encoding and byte estimation", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.encoding).toBeNull();
		expect(tokenizer.countTokens("hello world")).toBe(3);
	});

	test("fixes encoding at construction from catalog policy", () => {
		expect(new Tokenizer({ tokenizer: "claude-v47" }).encoding).toBe(Encoding.ClaudeV47);
		expect(new Tokenizer({ tokenizer: "claude-v5" }).encoding).toBe(Encoding.ClaudeV5);
		expect(new Tokenizer({}).encoding).toBeNull();
	});

	test("keeps instances isolated", () => {
		const claude = new Tokenizer({ tokenizer: "claude-v47" });
		const qwen = new Tokenizer({ tokenizer: "qwen3" });
		const generic = new Tokenizer({});
		expect(claude.encoding).toBe(Encoding.ClaudeV47);
		expect(qwen.encoding).toBe(Encoding.Qwen3);
		expect(generic.encoding).toBeNull();
	});
});

describe("countTokens modes", () => {
	test("uses byte estimation and upper bounds", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.countTokens("hello world", "approximate")).toBe(3);
		expect(tokenizer.countTokens("hello world", "upperbound")).toBe(11);
	});

	test("strict mode always uses native counting", () => {
		const generic = new Tokenizer();
		const claude = new Tokenizer({ tokenizer: "claude-v47" });
		expect(generic.countTokens("hello world", "strict")).toBe(2);
		expect(claude.countTokens("hello world", "strict")).toBeGreaterThan(0);
		expect(claude.countTokens("hello world", "strict")).not.toBe(generic.countTokens("hello world", "strict"));
	});
});
