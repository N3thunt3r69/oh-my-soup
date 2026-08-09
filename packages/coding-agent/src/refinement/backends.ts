/**
 * Entry-kind backends for the /refine continual harness.
 *
 * Each backend maps a {@link RefinementKind} onto an EXISTING oms store; none
 * of them introduce a parallel content store. All paths are injectable
 * (`cwd` + `agentDir`) so op application and reversal are testable on temp dirs.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectAgentDir, isEnoent } from "@oh-my-soup/pi-utils";
import {
	getManagedSkillsDir,
	sanitizeManagedDescription,
	sanitizeSkillName,
	toSkillFrontmatter,
} from "../autolearn/managed-skills";
import { encodeProjectPath, getMemoryRoot } from "../memories";
import type { RefinementEntrySnapshot, RefinementKind } from "./types";

/** Directory + cwd context every backend operation runs against. */
export interface RefinementStorePaths {
	cwd: string;
	agentDir: string;
}

export function resolveRefinementStorePaths(cwd: string, agentDir: string = getAgentDir()): RefinementStorePaths {
	return { cwd, agentDir };
}

/** Per-project refinement state dir (`~/.oms/agent/refinement/--<project>--`). */
export function getRefinementStateDir(paths: RefinementStorePaths): string {
	return path.join(paths.agentDir, "refinement", encodeProjectPath(paths.cwd));
}

export function getRefinementLogPath(paths: RefinementStorePaths): string {
	return path.join(getRefinementStateDir(paths), "refinements.jsonl");
}

export function getSubagentSpecsPath(paths: RefinementStorePaths): string {
	return path.join(getRefinementStateDir(paths), "subagent-specs.json");
}

/** Project supplemental instructions file oms's builtin discovery already reads. */
export function getPromptNotesPath(paths: RefinementStorePaths): string {
	return path.join(getProjectAgentDir(paths.cwd), "AGENTS.md");
}

/** Local memories learned-lessons file (`memory.backend: local` capture target). */
export function getMemoryNotesPath(paths: RefinementStorePaths): string {
	return path.join(getMemoryRoot(paths.agentDir, paths.cwd), "learned.md");
}

export function getSkillFilePath(paths: RefinementStorePaths, name: string): string {
	return path.join(getManagedSkillsDir(paths.agentDir), sanitizeSkillName(name), "SKILL.md");
}

export async function readFileOrNull(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/** Write `content`, or delete the file when `content` is null (empty-store contraction). */
async function writeOrDelete(filePath: string, content: string | null): Promise<void> {
	if (content === null) {
		await fs.rm(filePath, { force: true });
		return;
	}
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf8");
}

export function slugifyEntryId(raw: string, fallback: string): string {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return normalized || fallback;
}

// ---------------------------------------------------------------------------
// promptNote — managed block inside the project `.oms/AGENTS.md`
// ---------------------------------------------------------------------------

const NOTES_BEGIN = "<!-- oms-refine:notes:begin -->";
const NOTES_END = "<!-- oms-refine:notes:end -->";
const NOTE_MARKER = /^<!-- oms-refine:note:([a-z0-9-]+) -->$/;

function renderPromptNote(note: RefinementEntrySnapshot): string {
	const title = note.title?.trim() || note.id;
	return `<!-- oms-refine:note:${note.id} -->\n### ${title}\n\n${note.content.trim()}`;
}

function renderNotesBlock(notes: RefinementEntrySnapshot[]): string {
	const sorted = [...notes].sort((a, b) => a.id.localeCompare(b.id));
	return `${NOTES_BEGIN}\n\n${sorted.map(renderPromptNote).join("\n\n")}\n\n${NOTES_END}`;
}

function parseNotesBlock(text: string): RefinementEntrySnapshot[] {
	const begin = text.indexOf(NOTES_BEGIN);
	const end = text.indexOf(NOTES_END);
	if (begin === -1 || end === -1 || end < begin) return [];
	const inner = text.slice(begin + NOTES_BEGIN.length, end);
	const notes: RefinementEntrySnapshot[] = [];
	let current: { id: string; title?: string; lines: string[] } | undefined;
	const flush = () => {
		if (!current) return;
		notes.push({ id: current.id, title: current.title, content: current.lines.join("\n").trim() });
		current = undefined;
	};
	for (const line of inner.split("\n")) {
		const marker = line.match(NOTE_MARKER);
		if (marker) {
			flush();
			current = { id: marker[1], lines: [] };
			continue;
		}
		if (!current) continue;
		if (current.title === undefined && line.startsWith("### ")) {
			current.title = line.slice(4).trim();
			continue;
		}
		current.lines.push(line);
	}
	flush();
	return notes;
}

/** Replace (or insert/remove) the managed notes block, leaving user content untouched. */
function withNotesBlock(existing: string | null, notes: RefinementEntrySnapshot[]): string | null {
	if (notes.length === 0) {
		if (existing === null) return null;
		const begin = existing.indexOf(NOTES_BEGIN);
		const end = existing.indexOf(NOTES_END);
		if (begin === -1 || end === -1) return existing;
		const stripped =
			existing.slice(0, begin).replace(/\n+$/, "\n") + existing.slice(end + NOTES_END.length).replace(/^\n+/, "");
		return stripped.trim().length === 0 ? null : stripped;
	}
	const block = renderNotesBlock(notes);
	if (existing === null) return `${block}\n`;
	const begin = existing.indexOf(NOTES_BEGIN);
	const end = existing.indexOf(NOTES_END);
	if (begin !== -1 && end !== -1 && end >= begin) {
		return existing.slice(0, begin) + block + existing.slice(end + NOTES_END.length);
	}
	return `${existing.replace(/\s+$/, "")}\n\n${block}\n`;
}

// ---------------------------------------------------------------------------
// memory — tagged lesson lines inside the local memories `learned.md`
// ---------------------------------------------------------------------------

const MEMORY_LINE = /^- (.*) _\(context: refine:([a-z0-9-]+)\)_$/;

function renderMemoryLine(entry: RefinementEntrySnapshot): string {
	const flat = entry.content.replace(/\s+/g, " ").trim();
	return `- ${flat} _(context: refine:${entry.id})_`;
}

function parseMemoryLines(text: string): Map<string, RefinementEntrySnapshot> {
	const entries = new Map<string, RefinementEntrySnapshot>();
	for (const line of text.split("\n")) {
		const match = line.match(MEMORY_LINE);
		if (match) entries.set(match[2], { id: match[2], content: match[1] });
	}
	return entries;
}

// ---------------------------------------------------------------------------
// skillDescription — managed skill SKILL.md frontmatter + body
// ---------------------------------------------------------------------------

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

function parseSkillFile(text: string, fallbackName: string): RefinementEntrySnapshot {
	const match = text.match(FRONTMATTER);
	let description: string | undefined;
	let name = fallbackName;
	if (match) {
		for (const line of match[1].split("\n")) {
			const kv = line.match(/^(name|description):\s*(.*)$/);
			if (!kv) continue;
			const value = kv[2].trim().replace(/^["']|["']$/g, "");
			if (kv[1] === "name") name = value;
			else description = value;
		}
	}
	const body = match ? text.slice(match[0].length).replace(/^\n/, "") : text;
	return { id: name, title: description, content: body.trim() };
}

/** Same final shape `writeManagedSkill` produces: frontmatter + blank line + body. */
function renderSkillFile(entry: RefinementEntrySnapshot): string {
	const description = sanitizeManagedDescription(entry.title ?? "");
	return `${toSkillFrontmatter(entry.id, description)}\n${entry.content.trim()}\n`;
}

// ---------------------------------------------------------------------------
// subagentSpec — `<state>/subagent-specs.json`
// ---------------------------------------------------------------------------

export interface SubagentSpec {
	name: string;
	description: string;
	prompt: string;
	model?: string;
}

interface SubagentSpecsFile {
	schema: number;
	specs: Record<string, SubagentSpec>;
}

function parseSpecsFile(text: string | null): SubagentSpecsFile {
	if (text === null) return { schema: 1, specs: {} };
	try {
		const parsed = JSON.parse(text) as Partial<SubagentSpecsFile>;
		if (typeof parsed !== "object" || parsed === null || typeof parsed.specs !== "object" || parsed.specs === null) {
			return { schema: 1, specs: {} };
		}
		return { schema: typeof parsed.schema === "number" ? parsed.schema : 1, specs: parsed.specs };
	} catch {
		// Corrupt store degrades to empty; the next write rewrites it cleanly.
		return { schema: 1, specs: {} };
	}
}

function renderSpecsFile(file: SubagentSpecsFile): string | null {
	if (Object.keys(file.specs).length === 0) return null;
	const ordered: SubagentSpecsFile = { schema: file.schema, specs: {} };
	for (const name of Object.keys(file.specs).sort()) ordered.specs[name] = file.specs[name];
	return `${JSON.stringify(ordered, null, "\t")}\n`;
}

function specToEntry(spec: SubagentSpec): RefinementEntrySnapshot {
	return { id: spec.name, title: spec.description, content: spec.prompt, model: spec.model };
}

/** List stored subagent specs (task-template roster) for the current project. */
export async function listSubagentSpecs(paths: RefinementStorePaths): Promise<SubagentSpec[]> {
	const file = parseSpecsFile(await readFileOrNull(getSubagentSpecsPath(paths)));
	return Object.values(file.specs).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Unified backend surface
// ---------------------------------------------------------------------------

export interface KindBackend {
	/** Absolute file an op on `id` touches (for byte-exact pass snapshots). */
	filesFor(paths: RefinementStorePaths, id: string): string[];
	list(paths: RefinementStorePaths): Promise<RefinementEntrySnapshot[]>;
	read(paths: RefinementStorePaths, id: string): Promise<RefinementEntrySnapshot | undefined>;
	/** Insert or replace the entry with id `entry.id`. */
	write(paths: RefinementStorePaths, entry: RefinementEntrySnapshot): Promise<void>;
	remove(paths: RefinementStorePaths, id: string): Promise<void>;
	/** Normalize/validate an id for this kind; throws on invalid ids. */
	normalizeId(raw: string): string;
}

const promptNoteBackend: KindBackend = {
	filesFor: paths => [getPromptNotesPath(paths)],
	async list(paths) {
		const text = await readFileOrNull(getPromptNotesPath(paths));
		return text === null ? [] : parseNotesBlock(text);
	},
	async read(paths, id) {
		return (await this.list(paths)).find(note => note.id === id);
	},
	async write(paths, entry) {
		const filePath = getPromptNotesPath(paths);
		const existing = await readFileOrNull(filePath);
		const notes = existing === null ? [] : parseNotesBlock(existing);
		const next = notes.filter(note => note.id !== entry.id);
		next.push(entry);
		await writeOrDelete(filePath, withNotesBlock(existing, next));
	},
	async remove(paths, id) {
		const filePath = getPromptNotesPath(paths);
		const existing = await readFileOrNull(filePath);
		const notes = existing === null ? [] : parseNotesBlock(existing);
		await writeOrDelete(
			filePath,
			withNotesBlock(
				existing,
				notes.filter(note => note.id !== id),
			),
		);
	},
	normalizeId: raw => slugifyEntryId(raw, "note"),
};

const memoryBackend: KindBackend = {
	filesFor: paths => [getMemoryNotesPath(paths)],
	async list(paths) {
		const text = await readFileOrNull(getMemoryNotesPath(paths));
		return text === null ? [] : [...parseMemoryLines(text).values()];
	},
	async read(paths, id) {
		const text = await readFileOrNull(getMemoryNotesPath(paths));
		return text === null ? undefined : parseMemoryLines(text).get(id);
	},
	async write(paths, entry) {
		const filePath = getMemoryNotesPath(paths);
		const existing = await readFileOrNull(filePath);
		const line = renderMemoryLine(entry);
		if (existing === null) {
			await writeOrDelete(filePath, `${line}\n`);
			return;
		}
		const lines = existing.split("\n");
		const index = lines.findIndex(l => {
			const match = l.match(MEMORY_LINE);
			return match?.[2] === entry.id;
		});
		if (index >= 0) lines[index] = line;
		else lines.unshift(line); // newest-first, matching the `learn` tool's convention
		await writeOrDelete(filePath, lines.join("\n"));
	},
	async remove(paths, id) {
		const filePath = getMemoryNotesPath(paths);
		const existing = await readFileOrNull(filePath);
		if (existing === null) return;
		const lines = existing.split("\n").filter(l => l.match(MEMORY_LINE)?.[2] !== id);
		const next = lines.join("\n");
		await writeOrDelete(filePath, next.trim().length === 0 ? null : next);
	},
	normalizeId: raw => slugifyEntryId(raw, "memory"),
};

const skillDescriptionBackend: KindBackend = {
	filesFor: (paths, id) => [getSkillFilePath(paths, id)],
	async list(paths) {
		const root = getManagedSkillsDir(paths.agentDir);
		let names: string[] = [];
		try {
			names = (await fs.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		const entries: RefinementEntrySnapshot[] = [];
		for (const name of names.sort()) {
			const text = await readFileOrNull(path.join(root, name, "SKILL.md"));
			if (text !== null) entries.push(parseSkillFile(text, name));
		}
		return entries;
	},
	async read(paths, id) {
		const text = await readFileOrNull(getSkillFilePath(paths, id));
		return text === null ? undefined : parseSkillFile(text, id);
	},
	async write(paths, entry) {
		const filePath = getSkillFilePath(paths, entry.id);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, renderSkillFile(entry), "utf8");
	},
	async remove(paths, id) {
		const dir = path.dirname(getSkillFilePath(paths, id));
		await fs.rm(dir, { recursive: true, force: true });
	},
	normalizeId: raw => sanitizeSkillName(raw),
};

const subagentSpecBackend: KindBackend = {
	filesFor: paths => [getSubagentSpecsPath(paths)],
	async list(paths) {
		return (await listSubagentSpecs(paths)).map(specToEntry);
	},
	async read(paths, id) {
		const file = parseSpecsFile(await readFileOrNull(getSubagentSpecsPath(paths)));
		const spec = file.specs[id];
		return spec ? specToEntry(spec) : undefined;
	},
	async write(paths, entry) {
		const filePath = getSubagentSpecsPath(paths);
		const file = parseSpecsFile(await readFileOrNull(filePath));
		file.specs[entry.id] = {
			name: entry.id,
			description: entry.title ?? "",
			prompt: entry.content,
			...(entry.model ? { model: entry.model } : {}),
		};
		await writeOrDelete(filePath, renderSpecsFile(file));
	},
	async remove(paths, id) {
		const filePath = getSubagentSpecsPath(paths);
		const file = parseSpecsFile(await readFileOrNull(filePath));
		delete file.specs[id];
		await writeOrDelete(filePath, renderSpecsFile(file));
	},
	normalizeId: raw => slugifyEntryId(raw, "subagent"),
};

export const REFINEMENT_BACKENDS: Record<RefinementKind, KindBackend> = {
	promptNote: promptNoteBackend,
	memory: memoryBackend,
	skillDescription: skillDescriptionBackend,
	subagentSpec: subagentSpecBackend,
};
