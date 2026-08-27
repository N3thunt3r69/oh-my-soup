import { describe, expect, it } from "bun:test";
import { dedupeContainedContextFiles } from "@oh-my-soup/pi-coding-agent/system-prompt";

interface ContextFile {
	path: string;
	content: string;
	depth?: number;
}

function file(path: string, content: string, depth?: number): ContextFile {
	return { path, content, depth };
}

function paths(files: ContextFile[]): string[] {
	return files.map(contextFile => contextFile.path);
}

describe("dedupeContainedContextFiles", () => {
	it("keeps only the more authoritative file when two are byte-identical", () => {
		const content = "Rule one.\n\nRule two.\n\nRule three.";
		const files = [file("/home/user/.config/AGENTS.md", content, 5), file("/project/AGENTS.md", content, 0)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/project/AGENTS.md"]);
	});

	it("drops a file whose paragraphs appear contiguously in a more authoritative file", () => {
		const lessAuthoritative = "Shared rule A.\n\nShared rule B.\n\nShared rule C.";
		const moreAuthoritative = "Shared rule A.\n\nShared rule B.\n\nShared rule C.\n\nProject-specific rule.";
		const files = [
			file("/home/user/.config/AGENTS.md", lessAuthoritative, 5),
			file("/project/AGENTS.md", moreAuthoritative, 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/project/AGENTS.md"]);
	});

	it("keeps a file whose paragraphs appear non-contiguously", () => {
		const files = [
			file("/home/user/.config/AGENTS.md", "First.\n\nSecond.\n\nThird.", 5),
			file("/project/AGENTS.md", "First.\n\nInterleaved.\n\nSecond.\n\nThird.", 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/home/user/.config/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("keeps wording changes because containment is exact rather than fuzzy", () => {
		const files = [
			file("/home/user/.config/AGENTS.md", "Always use tabs.\n\nNever commit directly.", 5),
			file("/project/AGENTS.md", "Always use spaces.\n\nNever commit directly to main.", 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/home/user/.config/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("keeps all files when there is no containment", () => {
		const files = [
			file("/a/AGENTS.md", "Alpha rules.\n\nBeta rules.", 3),
			file("/b/AGENTS.md", "Gamma rules.\n\nDelta rules.", 2),
			file("/c/AGENTS.md", "Epsilon rules.\n\nZeta rules.", 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/a/AGENTS.md", "/b/AGENTS.md", "/c/AGENTS.md"]);
	});

	it("treats empty content as no blocks and never matches it", () => {
		const files = [file("/empty/AGENTS.md", "", 5), file("/project/AGENTS.md", "Real content.", 0)];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/empty/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("keeps only the most authoritative file in a transitive containment chain", () => {
		const files = [
			file("/level0/AGENTS.md", "Rule one.\n\nRule two.", 10),
			file("/level1/AGENTS.md", "Rule one.\n\nRule two.\n\nRule three.", 5),
			file("/level2/AGENTS.md", "Rule one.\n\nRule two.\n\nRule three.\n\nRule four.", 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/level2/AGENTS.md"]);
	});

	it("normalizes leading and trailing whitespace before comparing paragraphs", () => {
		const files = [
			file("/home/user/.config/AGENTS.md", "  Rule one.  \n\n  Rule two.  ", 5),
			file("/project/AGENTS.md", "Rule one.\n\nRule two.\n\nRule three.", 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/project/AGENTS.md"]);
	});

	it("uses depth rather than caller position to determine authority", () => {
		const files = [
			file("/project/AGENTS.md", "Shared rule.", 0),
			file("/home/user/.config/AGENTS.md", "Shared rule.\n\nFar-only rule.", 5),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/home/user/.config/AGENTS.md", "/project/AGENTS.md"]);
	});

	it("does not treat text inside a fenced code block as a contained instruction", () => {
		const files = [
			file("/home/user/.config/AGENTS.md", "Never delete user data.", 5),
			file("/project/AGENTS.md", "Example of a bad prompt:\n\n```\nNever delete user data.\n```", 0),
		];

		expect(paths(dedupeContainedContextFiles(files))).toEqual(["/home/user/.config/AGENTS.md", "/project/AGENTS.md"]);
	});
});
