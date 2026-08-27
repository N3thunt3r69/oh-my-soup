import { describe, expect, it } from "bun:test";
import { RelayBridge, type RelaySocket } from "@oh-my-soup/pi-coding-agent/tools/browser/relay/bridge";
import type {
	RelayRpcRequest,
	RelayToExtMessage,
	TabSnapshot,
} from "@oh-my-soup/pi-coding-agent/tools/browser/relay/protocol";

/** A relay→extension RPC narrowed to one op, tabIds/title/etc. included. */
type ExtRpc<Op extends RelayRpcRequest["op"]> = { t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>;

class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	readonly #acked = new Set<number>();
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {}
	rpcs<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.messages.filter((msg): msg is ExtRpc<Op> => msg.t === "rpc" && msg.op === op);
	}
	/** RPC requests of `op` not yet answered through {@link ack}. */
	pending<Op extends RelayRpcRequest["op"]>(op: Op): Array<ExtRpc<Op>> {
		return this.rpcs(op).filter(msg => !this.#acked.has(msg.id));
	}
	markAcked(id: number): void {
		this.#acked.add(id);
	}
}

/** Downstream puppeteer-side socket capturing bridge emissions. */
class FakeCdpSocket implements RelaySocket {
	readonly messages: Array<Record<string, unknown>> = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text) as Record<string, unknown>);
	}
	close(): void {}
	sessionFor(commandId: number): string | undefined {
		const msg = this.messages.find(m => m.id === commandId);
		const result = msg && "result" in msg && msg.result && typeof msg.result === "object" ? msg.result : undefined;
		return result && "sessionId" in result && typeof result.sessionId === "string" ? result.sessionId : undefined;
	}
}

function tab(overrides: Partial<TabSnapshot> & { tabId: number }): TabSnapshot {
	return {
		url: "https://example.com/",
		title: "Example",
		active: false,
		windowId: 1,
		pinned: false,
		groupId: -1,
		...overrides,
	};
}

function connect(bridge: RelayBridge, socket: FakeExtSocket, tabs: TabSnapshot[], attachedTabIds: number[] = []): void {
	bridge.extConnected(socket);
	bridge.extMessage(
		socket,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/151.0.0.0",
			tabs,
			attachedTabIds,
		}),
	);
}

/** Answer every unanswered extension RPC of `op` with `ok: true` and `result`. */
function ack(bridge: RelayBridge, socket: FakeExtSocket, op: RelayRpcRequest["op"], result: unknown = {}): void {
	for (const rpc of socket.pending(op)) {
		socket.markAcked(rpc.id);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: true, result }));
	}
}

/** Flush the rpc .then() microtask chains (no timers involved). */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

let msgSeq = 100;

/** Attach to a tab's page target and return the minted page session id. */
async function attachPage(
	bridge: RelayBridge,
	ext: FakeExtSocket,
	cdp: FakeCdpSocket,
	connId: number,
	tabId: number,
): Promise<string> {
	const attachId = ++msgSeq;
	bridge.cdpMessage(
		connId,
		JSON.stringify({
			id: attachId,
			method: "Target.attachToTarget",
			params: { targetId: `PAGE${tabId}`, flatten: true },
		}),
	);
	ack(bridge, ext, "attach");
	await flush();
	const sessionId = cdp.sessionFor(attachId);
	if (!sessionId) throw new Error(`attachToTarget for tab ${tabId} did not produce a session`);
	return sessionId;
}

/**
 * Emulate the oms tab worker adopting a tab: attach to its page target, then
 * claim it as this connection's drive target.
 */
async function claimTab(
	bridge: RelayBridge,
	ext: FakeExtSocket,
	cdp: FakeCdpSocket,
	connId: number,
	tabId: number,
): Promise<void> {
	const sessionId = await attachPage(bridge, ext, cdp, connId, tabId);
	bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "OMS.claimTarget" }));
	await flush();
}

describe("RelayBridge tab grouping", () => {
	it("groups nothing on hello or tab lifecycle events — only claimed tabs join the oms group", () => {
		const bridge = new RelayBridge({ group: { title: "oms", color: "cyan" } });
		const socket = new FakeExtSocket();
		connect(bridge, socket, [tab({ tabId: 1 }), tab({ tabId: 2 }), tab({ tabId: 3, url: "about:blank" })]);
		bridge.extMessage(socket, JSON.stringify({ t: "tabCreated", tab: tab({ tabId: 9 }) }));
		expect(socket.rpcs("group")).toHaveLength(0);
	});

	it("never groups from command traffic: a discovery scan sending page commands to every tab is not driving", async () => {
		const bridge = new RelayBridge({ group: { title: "oms", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		// pickElectronTarget materializes every discovered page, which makes
		// puppeteer send Page.enable/Page.getFrameTree to all of them.
		for (const tabId of [1, 2]) {
			const sessionId = await attachPage(bridge, ext, cdp, connId, tabId);
			bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Page.enable" }));
			bridge.cdpMessage(connId, JSON.stringify({ id: ++msgSeq, sessionId, method: "Page.getFrameTree" }));
		}
		await flush();
		expect(ext.rpcs("group")).toHaveLength(0);
	});

	it("groups exactly the tab a client claims", async () => {
		const bridge = new RelayBridge({ group: { title: "oms", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		const groups = ext.rpcs("group");
		expect(groups).toHaveLength(1);
		expect(groups[0]!.tabIds).toEqual([1]);
		expect(groups[0]!.title).toBe("oms");
		expect(groups[0]!.color).toBe("cyan");
	});

	it("never groups pinned tabs or tabs in a user group, even when claimed", async () => {
		const bridge = new RelayBridge({ group: { title: "oms", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 3, pinned: true }), tab({ tabId: 4, groupId: 77 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 3);
		await claimTab(bridge, ext, cdp, connId, 4);
		expect(ext.rpcs("group")).toHaveLength(0);
	});

	it("does not issue group RPCs when grouping is disabled", async () => {
		const bridge = new RelayBridge({});
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		expect(ext.rpcs("group")).toHaveLength(0);
	});

	it("auto-claims a tab created through Target.createTarget", async () => {
		const bridge = new RelayBridge({ group: { title: "oms", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, []);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: ++msgSeq, method: "Target.createTarget", params: { url: "https://example.com/" } }),
		);
		ack(bridge, ext, "createTab", { tab: tab({ tabId: 9 }) });
		await flush();
		const groups = ext.rpcs("group");
		expect(groups).toHaveLength(1);
		expect(groups[0]!.tabIds).toEqual([9]);
	});

	it("never re-groups a tab the user pulled out of the oms group", async () => {
		const bridge = new RelayBridge({ group: { title: "oms", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		// Chrome reports the grouping we just made — no opt-out.
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: 42 }) }));
		// The user drags the tab out of the group.
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: -1 }) }));
		// A later navigation on the still-claimed tab must not re-group it.
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "tabUpdated", tab: tab({ tabId: 1, groupId: -1, url: "https://example.com/other" }) }),
		);
		expect(ext.rpcs("group")).toHaveLength(1);
	});

	it("ungroups when the claiming client disconnects, even while another connection still holds sessions", async () => {
		const bridge = new RelayBridge({ group: { title: "oms", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		// Long-lived registry connection: holds a session on the tab, never claims it.
		const registry = new FakeCdpSocket();
		const registryConn = bridge.cdpConnected(registry);
		await attachPage(bridge, ext, registry, registryConn, 1);
		// Worker connection: claims the tab.
		const worker = new FakeCdpSocket();
		const workerConn = bridge.cdpConnected(worker);
		await claimTab(bridge, ext, worker, workerConn, 1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		bridge.cdpClosed(workerConn);
		const ungroups = ext.rpcs("ungroup");
		expect(ungroups).toHaveLength(1);
		expect(ungroups[0]!.tabIds).toEqual([1]);
	});

	it("never overlaps group RPCs: a tab claimed mid-flight waits for the pending group", async () => {
		const bridge = new RelayBridge({ group: { title: "oms", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 }), tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		expect(ext.rpcs("group")).toHaveLength(1);
		// Concurrent group RPCs race Chrome's non-atomic query→create→set-title
		// and mint duplicate "oms" groups; the second request must queue.
		await claimTab(bridge, ext, cdp, connId, 2);
		expect(ext.rpcs("group")).toHaveLength(1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		const groups = ext.rpcs("group");
		expect(groups).toHaveLength(2);
		expect(groups[1]!.tabIds).toEqual([2]);
	});

	it("regroups claimed tabs after an extension reconnect instead of treating the dissolve as user opt-out", async () => {
		const bridge = new RelayBridge({ group: { title: "oms", color: "cyan" } });
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await claimTab(bridge, ext, cdp, connId, 1);
		ack(bridge, ext, "group", { grouped: { "1": 42 } });
		await flush();
		// Relay/extension link drops: the extension dissolves the oms group on
		// disconnect, so the next hello reports groupId -1 for every tab.
		bridge.extClosed(ext);
		const ext2 = new FakeExtSocket();
		connect(bridge, ext2, [tab({ tabId: 1, groupId: -1 })]);
		const groups = ext2.rpcs("group");
		expect(groups).toHaveLength(1);
		expect(groups[0]!.tabIds).toEqual([1]);
	});
});

describe("RelayBridge Runtime virtualization", () => {
	it("fans out by default, honors disable, and replays cached contexts on enable", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 1 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 1);

		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: { context: { id: 10 } },
			}),
		);
		expect(cdp.messages.filter(message => message.method === "Runtime.executionContextCreated")).toHaveLength(1);

		bridge.cdpMessage(connId, JSON.stringify({ id: 201, sessionId, method: "Runtime.disable" }));
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 1,
				method: "Runtime.executionContextCreated",
				params: { context: { id: 11 } },
			}),
		);
		expect(cdp.messages.filter(message => message.method === "Runtime.executionContextCreated")).toHaveLength(1);

		bridge.cdpMessage(connId, JSON.stringify({ id: 202, sessionId, method: "Runtime.enable" }));
		expect(ext.pending("send").map(request => request.method)).toEqual(["Runtime.disable"]);
		ack(bridge, ext, "send");
		await flush();
		expect(ext.pending("send").map(request => request.method)).toEqual(["Runtime.enable"]);
		ack(bridge, ext, "send");
		await flush();

		const contexts = cdp.messages
			.filter(message => message.method === "Runtime.executionContextCreated")
			.map(message => {
				const params = message.params;
				if (!params || typeof params !== "object" || !("context" in params)) throw new Error("missing context");
				const context = params.context;
				if (!context || typeof context !== "object" || !("id" in context) || typeof context.id !== "number") {
					throw new Error("missing context id");
				}
				return context.id;
			});
		expect(contexts).toEqual([10, 10, 11]);
		expect(cdp.messages.find(message => message.id === 202)).toMatchObject({ result: {} });
	});

	it("joins duplicate enables and preserves a newer disable when the shared cycle fails", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 2 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 2);

		bridge.cdpMessage(connId, JSON.stringify({ id: 210, sessionId, method: "Runtime.enable" }));
		bridge.cdpMessage(connId, JSON.stringify({ id: 211, sessionId, method: "Runtime.enable" }));
		expect(ext.pending("send")).toHaveLength(1);
		const rootDisable = ext.pending("send")[0]!;
		ext.markAcked(rootDisable.id);
		bridge.extMessage(ext, JSON.stringify({ t: "rpcResult", id: rootDisable.id, ok: false, error: "denied" }));
		await flush();

		expect(ext.rpcs("send")).toHaveLength(1);
		expect(cdp.messages.find(message => message.id === 210)).toMatchObject({ error: { message: "denied" } });
		expect(cdp.messages.find(message => message.id === 211)).toMatchObject({ error: { message: "denied" } });

		bridge.cdpMessage(connId, JSON.stringify({ id: 212, sessionId, method: "Runtime.enable" }));
		bridge.cdpMessage(connId, JSON.stringify({ id: 213, sessionId, method: "Runtime.disable" }));
		const retry = ext.pending("send")[0]!;
		ext.markAcked(retry.id);
		bridge.extMessage(ext, JSON.stringify({ t: "rpcResult", id: retry.id, ok: false, error: "still denied" }));
		await flush();
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 2,
				method: "Runtime.executionContextCreated",
				params: { context: { id: 20 } },
			}),
		);
		expect(cdp.messages.filter(message => message.method === "Runtime.executionContextCreated")).toHaveLength(0);
	});

	it("restores enabled Runtime sessions and clears context dedupe across reconnect", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 3 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, ext, cdp, connId, 3);
		bridge.cdpMessage(connId, JSON.stringify({ id: 220, sessionId, method: "Runtime.enable" }));
		ack(bridge, ext, "send");
		await flush();
		ack(bridge, ext, "send");
		await flush();
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 3,
				method: "Runtime.executionContextCreated",
				params: { context: { id: 30 } },
			}),
		);

		bridge.extClosed(ext);
		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 3 })]);
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		expect(replacement.pending("send").map(request => request.method)).toEqual(["Runtime.disable"]);
		ack(bridge, replacement, "send");
		await flush();
		expect(replacement.pending("send").map(request => request.method)).toEqual(["Runtime.enable"]);
		ack(bridge, replacement, "send");
		await flush();

		bridge.extMessage(
			replacement,
			JSON.stringify({
				t: "cdpEvent",
				tabId: 3,
				method: "Runtime.executionContextCreated",
				params: { context: { id: 30 } },
			}),
		);
		expect(cdp.messages.filter(message => message.method === "Runtime.executionContextCreated")).toHaveLength(2);
	});
});

describe("RelayBridge detach and replacement lifecycle", () => {
	it("serializes explicit final-session detach before replacement attachment", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 4 })]);
		const firstCdp = new FakeCdpSocket();
		const firstConn = bridge.cdpConnected(firstCdp);
		const firstSession = await attachPage(bridge, ext, firstCdp, firstConn, 4);

		bridge.cdpMessage(
			firstConn,
			JSON.stringify({ id: 230, method: "Target.detachFromTarget", params: { sessionId: firstSession } }),
		);
		expect(ext.pending("detach")).toHaveLength(1);

		const secondCdp = new FakeCdpSocket();
		const secondConn = bridge.cdpConnected(secondCdp);
		bridge.cdpMessage(
			secondConn,
			JSON.stringify({ id: 231, method: "Target.attachToTarget", params: { targetId: "PAGE4", flatten: true } }),
		);
		await flush();
		expect(ext.pending("attach")).toHaveLength(0);

		bridge.extMessage(
			ext,
			JSON.stringify({ t: "detached", tabId: 4, reason: "target_closed", relayInitiated: true }),
		);
		ack(bridge, ext, "detach");
		await flush();
		expect(ext.pending("attach")).toHaveLength(1);
		ack(bridge, ext, "attach");
		await flush();
		expect(secondCdp.sessionFor(231)).toBeDefined();
	});

	it("clears old RPC waits on socket replacement without permanently banning the tab", async () => {
		const bridge = new RelayBridge();
		const oldExt = new FakeExtSocket();

		connect(bridge, oldExt, [tab({ tabId: 5 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: 240, method: "Target.attachToTarget", params: { targetId: "PAGE5", flatten: true } }),
		);
		expect(oldExt.pending("attach")).toHaveLength(1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 5 })]);
		await flush();
		expect(cdp.messages.find(message => message.id === 240)).toMatchObject({
			error: { message: "Cannot attach to tab 5 (https://example.com/)" },
		});

		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: 241, method: "Target.attachToTarget", params: { targetId: "PAGE5", flatten: true } }),
		);
		ack(bridge, replacement, "attach");
		await flush();
		expect(cdp.sessionFor(241)).toBeDefined();
	});
	it("correlates a delayed relay detach echo delivered through a replacement socket", async () => {
		const bridge = new RelayBridge();
		const oldExt = new FakeExtSocket();
		connect(bridge, oldExt, [tab({ tabId: 7 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		const sessionId = await attachPage(bridge, oldExt, cdp, connId, 7);
		bridge.cdpMessage(connId, JSON.stringify({ id: 235, method: "Target.detachFromTarget", params: { sessionId } }));
		expect(oldExt.pending("detach")).toHaveLength(1);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 7 })], [7]);
		bridge.extMessage(
			replacement,
			JSON.stringify({ t: "detached", tabId: 7, reason: "target_closed", relayInitiated: true }),
		);
		await flush();

		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: 236, method: "Target.attachToTarget", params: { targetId: "PAGE7", flatten: true } }),
		);
		expect(replacement.pending("attach")).toHaveLength(1);
		ack(bridge, replacement, "attach");
		await flush();
		expect(cdp.sessionFor(236)).toBeDefined();
	});

	it("treats failed reattachment as a real detach, not a relay echo", async () => {
		const bridge = new RelayBridge();
		const ext = new FakeExtSocket();
		connect(bridge, ext, [tab({ tabId: 6 })]);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		await attachPage(bridge, ext, cdp, connId, 6);

		const replacement = new FakeExtSocket();
		connect(bridge, replacement, [tab({ tabId: 6 })]);
		const reattach = replacement.pending("attach")[0]!;
		replacement.markAcked(reattach.id);
		bridge.extMessage(
			replacement,
			JSON.stringify({ t: "rpcResult", id: reattach.id, ok: false, error: "another debugger" }),
		);
		await flush();

		expect(cdp.messages.some(message => message.method === "Target.detachedFromTarget")).toBe(true);
		expect(cdp.messages.some(message => message.method === "Target.targetDestroyed")).toBe(false);
	});
});
