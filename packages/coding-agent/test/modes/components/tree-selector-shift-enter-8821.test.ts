import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-soup/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-soup/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-soup/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-soup/pi-coding-agent/session/session-entries";

function chain(entries: SessionEntry[]): SessionTreeNode {
	const [head, ...rest] = entries.map(entry => ({ entry, children: [] }));
	let tail = head as SessionTreeNode;
	for (const next of rest) {
		tail.children.push(next);
		tail = next;
	}
	return head as SessionTreeNode;
}

const userEntry: SessionEntry = {
	id: "u1",
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	type: "message",
	message: { role: "user", content: "start", timestamp: 0 } as AgentMessage,
} as SessionEntry;

const responseEntry: SessionEntry = {
	id: "r1",
	parentId: "u1",
	timestamp: "2026-01-01T00:00:00.000Z",
	type: "message",
	message: { role: "assistant", content: "response", timestamp: 1 } as unknown as AgentMessage,
} as SessionEntry;

interface SelectRecord {
	entryId: string;
	options: { summarize: boolean };
}

function selectorWithOnSelect(entries: SessionEntry[], records: SelectRecord[]): TreeSelectorComponent {
	const onSelect = (entryId: string, options: { summarize: boolean }) => {
		records.push({ entryId, options });
	};
	return new TreeSelectorComponent([chain(entries)], entries.at(-1)?.id ?? null, 40, onSelect, () => {});
}

describe("tree selector Shift+Enter fallback (issue #8821)", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("treats a bare LF as Shift+Enter (summarize-and-switch)", () => {
		const records: SelectRecord[] = [];
		selectorWithOnSelect([userEntry, responseEntry], records).handleInput("\n");
		expect(records).toEqual([{ entryId: responseEntry.id, options: { summarize: true } }]);
	});

	it("keeps plain CR as plain Enter (plain switch, no summary)", () => {
		const records: SelectRecord[] = [];
		selectorWithOnSelect([userEntry, responseEntry], records).handleInput("\r");
		expect(records).toEqual([{ entryId: responseEntry.id, options: { summarize: false } }]);
	});

	it("recognizes the kitty CSI-u Shift+Enter encoding", () => {
		const records: SelectRecord[] = [];
		selectorWithOnSelect([userEntry, responseEntry], records).handleInput("\u001b[13;2u");
		expect(records).toEqual([{ entryId: responseEntry.id, options: { summarize: true } }]);
	});

	it("recognizes the legacy CSI-tilde Shift+Enter encoding", () => {
		const records: SelectRecord[] = [];
		selectorWithOnSelect([userEntry, responseEntry], records).handleInput("\u001b[13;2~");
		expect(records).toEqual([{ entryId: responseEntry.id, options: { summarize: true } }]);
	});
});
