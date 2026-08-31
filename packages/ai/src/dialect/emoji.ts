import { parseJsonWithRepair } from "@oh-my-soup/pi-utils";
import type { Message, ToolCall } from "../types";
import { mintToolCallId } from "./coercion";
import dialectPrompt from "./emoji.md" with { type: "text" };
import { renderLegacyTextTranscript, stringifyJson } from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";

const CALL_MARKER = "🔧";
const THINKING_OPEN = "<think>";
const THINKING_CLOSE = "</think>";
const RESULT_OPEN = "📦result ";
const ERROR_OPEN = "📦error ";
const RESULT_CLOSE = "📬";
const MAX_CALL_LINE_LENGTH = 1_000_000;
const CALL_LINE = /^🔧\s*(\S+)\s+(.+?)\s*$/u;
const RESULT_HEADER = /^📦(?:result|error)\s+(\S+)\s+(?:📬)+\s*$/u;

interface Fence {
	readonly marker: "`" | "~";
	readonly length: number;
}

interface ParsedCall {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/**
 * Incremental scanner for the compact emoji line protocol. It buffers at most
 * one physical line so call JSON wins over tag-like string contents, while
 * thinking, Markdown fences, and example blocks remain inert contexts.
 */
export class EmojiInbandScanner implements InbandScanner {
	#buffer = "";
	#plainLine = false;
	#thinking = false;
	#thinkingText = "";
	#fence: Fence | undefined;
	#exampleDepth = 0;
	#stopped = false;
	readonly #parseThinking: boolean;
	readonly #toolNames: ReadonlySet<string> | undefined;

	constructor(options: InbandScannerOptions = {}) {
		this.#parseThinking = options.parseThinking !== false;
		this.#toolNames = options.tools === undefined ? undefined : new Set(options.tools.map(tool => tool.name));
	}

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0 || this.#stopped) return [];
		this.#buffer += text;
		return this.#drain(false);
	}

	flush(): InbandScanEvent[] {
		return this.#stopped ? [] : this.#drain(true);
	}

	#drain(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		while (this.#buffer.length > 0) {
			if (this.#plainLine) {
				const newline = this.#buffer.indexOf("\n");
				if (newline === -1) {
					this.#emitCurrent(this.#buffer, events);
					this.#buffer = "";
					break;
				}
				this.#emitCurrent(this.#buffer.slice(0, newline + 1), events);
				this.#buffer = this.#buffer.slice(newline + 1);
				this.#plainLine = false;
				continue;
			}

			const newline = this.#buffer.indexOf("\n");
			if (newline !== -1) {
				const line = this.#buffer.slice(0, newline + 1);
				this.#buffer = this.#buffer.slice(newline + 1);
				this.#consumeLine(line, events);
				if (this.#stopped) this.#buffer = "";
				continue;
			}
			if (final) {
				const line = this.#buffer;
				this.#buffer = "";
				this.#consumeLine(line, events);
				continue;
			}
			const normalizedLength = this.#buffer.endsWith("\r") ? this.#buffer.length - 1 : this.#buffer.length;
			if (normalizedLength <= MAX_CALL_LINE_LENGTH) break;

			this.#emitCurrent(this.#buffer, events);
			this.#buffer = "";
			this.#plainLine = true;
		}
		if (final && this.#thinking) this.#finishThinking(events);
		return events;
	}

	#consumeLine(rawLine: string, events: InbandScanEvent[]): void {
		const withoutNewline = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
		const line = withoutNewline.endsWith("\r") ? withoutNewline.slice(0, -1) : withoutNewline;
		const lineEnding = rawLine.slice(line.length);
		const boundaryLine = line.trim();

		if (this.#fence) {
			this.#emitCurrent(rawLine, events);
			if (isFenceClose(line, this.#fence)) this.#fence = undefined;
			return;
		}

		if (this.#exampleDepth > 0) {
			this.#exampleDepth = scanExampleBoundaries(boundaryLine, this.#exampleDepth).depth;
			this.#emitCurrent(rawLine, events);
			return;
		}

		if (this.#thinking) {
			const close = line.indexOf(THINKING_CLOSE);
			if (close === -1) {
				this.#emitCurrent(rawLine, events);
				return;
			}
			this.#emitCurrent(line.slice(0, close), events);
			this.#finishThinking(events);
			this.#emitCurrent(`${line.slice(close + THINKING_CLOSE.length)}${lineEnding}`, events);
			return;
		}

		const fence = parseFenceOpen(line);
		if (fence) {
			this.#fence = fence;
			this.#emitCurrent(rawLine, events);
			return;
		}

		const resultHeader = RESULT_HEADER.exec(line);
		if (resultHeader && (!this.#toolNames || this.#toolNames.has(resultHeader[1]!))) {
			this.#stopped = true;
			events.push({ type: "fabricatedResult", rawBlock: line });
			return;
		}

		if (line.startsWith(CALL_MARKER)) {
			if (line.length <= MAX_CALL_LINE_LENGTH) {
				const call = this.#parseCall(line);
				if (call) {
					const id = mintToolCallId();
					events.push({ type: "toolStart", id, name: call.name });
					events.push({
						type: "toolEnd",
						id,
						name: call.name,
						arguments: call.arguments,
						rawBlock: line,
					});
					return;
				}
			}
			this.#emitCurrent(rawLine, events);
			return;
		}

		const example = scanExampleBoundaries(boundaryLine, 0);
		if (example.opened) {
			this.#exampleDepth = example.depth;
			this.#emitCurrent(rawLine, events);
			return;
		}

		const thinkingOpen = this.#parseThinking ? line.indexOf(THINKING_OPEN) : -1;
		if (thinkingOpen !== -1) {
			this.#emitCurrent(line.slice(0, thinkingOpen), events);
			this.#thinking = true;
			this.#thinkingText = "";
			events.push({ type: "thinkingStart" });
			const body = line.slice(thinkingOpen + THINKING_OPEN.length);
			const thinkingClose = body.indexOf(THINKING_CLOSE);
			if (thinkingClose === -1) {
				this.#emitCurrent(`${body}${lineEnding}`, events);
				return;
			}
			this.#emitCurrent(body.slice(0, thinkingClose), events);
			this.#finishThinking(events);
			this.#emitCurrent(`${body.slice(thinkingClose + THINKING_CLOSE.length)}${lineEnding}`, events);
			return;
		}

		this.#emitCurrent(rawLine, events);
	}

	#parseCall(line: string): ParsedCall | undefined {
		const match = CALL_LINE.exec(line);
		if (!match) return undefined;
		const name = match[1]!;
		if (this.#toolNames && !this.#toolNames.has(name)) return undefined;
		const rawArguments = match[2]!.trim();
		if (!hasSingleCompleteRootObject(rawArguments)) return undefined;
		try {
			const parsed = parseJsonWithRepair<unknown>(rawArguments);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
			return { name, arguments: parsed as Record<string, unknown> };
		} catch {
			return undefined;
		}
	}

	#emitCurrent(text: string, events: InbandScanEvent[]): void {
		if (text.length === 0) return;
		if (this.#thinking) {
			this.#thinkingText += text;
			events.push({ type: "thinkingDelta", delta: text });
		} else {
			events.push({ type: "text", text });
		}
	}

	#finishThinking(events: InbandScanEvent[]): void {
		events.push({ type: "thinkingEnd", thinking: this.#thinkingText });
		this.#thinking = false;
		this.#thinkingText = "";
	}
}

interface ExampleBoundaryScan {
	readonly depth: number;
	readonly opened: boolean;
}

interface ExampleBoundary {
	readonly change: -1 | 0 | 1;
	readonly end: number;
}

function scanExampleBoundaries(line: string, initialDepth: number): ExampleBoundaryScan {
	let depth = initialDepth;
	let opened = false;
	let cursor = 0;
	for (;;) {
		const nextIndex = line.indexOf("<", cursor);
		if (nextIndex === -1) break;
		const boundary = parseExampleBoundaryAt(line, nextIndex);
		if (!boundary) {
			cursor = nextIndex + 1;
			continue;
		}
		if (boundary.change > 0) opened = true;
		depth = Math.max(0, depth + boundary.change);
		cursor = boundary.end;
	}
	return { depth, opened };
}

function parseExampleBoundaryAt(line: string, start: number): ExampleBoundary | undefined {
	let cursor = start + 1;
	const closing = line[cursor] === "/";
	if (closing) cursor++;

	if (line.startsWith("examples", cursor)) cursor += "examples".length;
	else if (line.startsWith("example", cursor)) cursor += "example".length;
	else return undefined;

	const separator = line[cursor];
	if (separator !== ">" && separator !== "/" && !isAsciiWhitespace(separator)) return undefined;

	if (closing) {
		while (isAsciiWhitespace(line[cursor])) cursor++;
		return line[cursor] === ">" ? { change: -1, end: cursor + 1 } : undefined;
	}

	let quote = "";
	for (; cursor < line.length; cursor++) {
		const char = line[cursor]!;
		if (quote) {
			if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char !== ">") continue;

		let before = cursor - 1;
		while (before >= start && isAsciiWhitespace(line[before])) before--;
		return { change: line[before] === "/" ? 0 : 1, end: cursor + 1 };
	}
	return undefined;
}

function isAsciiWhitespace(char: string | undefined): boolean {
	return char === " " || char === "\t" || char === "\r" || char === "\n" || char === "\f";
}

function hasSingleCompleteRootObject(text: string): boolean {
	if (!text.startsWith("{")) return false;
	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) return false;
		if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") {
			depth--;
			if (depth === 0) return text.slice(index + 1).trim().length === 0;
			if (depth < 0) return false;
		}
	}
	return false;
}

function parseFenceOpen(line: string): Fence | undefined {
	const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
	const run = match?.[1];
	if (!run) return undefined;
	return { marker: run[0] as Fence["marker"], length: run.length };
}

function isFenceClose(line: string, fence: Fence): boolean {
	let index = 0;
	while (index < line.length && index < 3 && line[index] === " ") index++;
	if (line[index] === " ") return false;
	let run = 0;
	while (index + run < line.length && line[index + run] === fence.marker) run++;
	return run >= fence.length && /^[\t ]*$/.test(line.slice(index + run));
}

function renderToolCall(call: ToolCall): string {
	return `${CALL_MARKER}${call.name} ${stringifyJson(call.arguments)}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[]): string {
	return calls.map(renderToolCall).join("\n");
}

function renderToolResults(results: readonly DialectToolResult[]): string {
	return results
		.map(result => {
			const open = result.isError ? ERROR_OPEN : RESULT_OPEN;
			const name = /\s/u.test(result.name) ? stringifyJson(result.name) : result.name;
			const body = result.text.endsWith("\n") ? result.text : `${result.text}\n`;
			const close = resultFence(body);
			return `${open}${name} ${close}\n${body}${close}`;
		})
		.join("\n");
}

function resultFence(text: string): string {
	let length = 1;
	for (const line of text.split(/\r?\n/)) {
		if (!/^(?:📬)+$/u.test(line)) continue;
		length = Math.max(length, line.length / RESULT_CLOSE.length + 1);
	}
	return RESULT_CLOSE.repeat(length);
}

function renderThinking(text: string): string {
	if (!text) return "";
	const body = text.endsWith("\n") ? text : `${text}\n`;
	return `${THINKING_OPEN}\n${body}${THINKING_CLOSE}`;
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	return renderLegacyTextTranscript(messages, options, {
		renderThinking: text => (text.length === 0 ? "" : `${renderThinking(text)}\n`),
		renderCalls: calls => (calls.length === 0 ? "" : `\n${renderAssistantToolCalls(calls)}`),
		renderResults: renderToolResults,
	});
}

const definition: DialectDefinition = {
	dialect: "emoji",
	prompt: dialectPrompt,
	createScanner: options => new EmojiInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
