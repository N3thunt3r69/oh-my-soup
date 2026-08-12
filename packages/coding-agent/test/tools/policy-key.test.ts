import { describe, expect, it } from "bun:test";
import type { AgentTool, ToolApproval } from "@oh-my-soup/pi-agent-core";
import { requiresApproval, resolveApproval } from "@oh-my-soup/pi-coding-agent/tools/approval";

type ApprovalTool = Pick<AgentTool, "name" | "approval" | "formatApprovalDetails">;

function tool(
	name: string,
	approval?: ToolApproval,
	formatApprovalDetails?: ApprovalTool["formatApprovalDetails"],
): ApprovalTool {
	return { name, approval, formatApprovalDetails };
}

describe("decision policyKey scopes user policy to a sub-tool", () => {
	// The write tool reports this decision for an `xd://knowledge_search` dispatch:
	// the tier comes from the mounted tool, and the policyKey makes the user
	// override key on the device instead of the invoking `write` tool (#7923).
	const dispatch = tool("write", { tier: "exec", policyKey: "knowledge_search" });

	it("consults tools.approval.<policyKey> for the user override", () => {
		expect(resolveApproval(dispatch, {}, "always-ask", { knowledge_search: "allow" })).toMatchObject({
			policy: "allow",
			source: "user",
			policyKey: "knowledge_search",
		});
		expect(resolveApproval(dispatch, {}, "always-ask", { knowledge_search: "prompt" }).policy).toBe("prompt");
		expect(resolveApproval(dispatch, {}, "always-ask", { knowledge_search: "deny" }).policy).toBe("deny");
	});

	it("falls back to the invoking tool's own policy when the keyed one is unset", () => {
		expect(resolveApproval(dispatch, {}, "always-ask", { write: "allow" }).policy).toBe("allow");
		expect(resolveApproval(dispatch, {}, "always-ask", { write: "prompt" }).policy).toBe("prompt");
		expect(resolveApproval(dispatch, {}, "always-ask", { write: "deny" }).policy).toBe("deny");
	});

	it("device policy wins over the invoking tool's policy", () => {
		expect(resolveApproval(dispatch, {}, "always-ask", { write: "prompt", knowledge_search: "allow" }).policy).toBe(
			"allow",
		);
		expect(resolveApproval(dispatch, {}, "always-ask", { write: "allow", knowledge_search: "deny" }).policy).toBe(
			"deny",
		);
	});

	it("names the policy key in user-deny refusals", () => {
		expect(() => requiresApproval(dispatch, {}, "always-ask", { knowledge_search: "deny" })).toThrow(
			'Tool "knowledge_search" is blocked by user policy',
		);
		expect(() => requiresApproval(dispatch, {}, "always-ask", { knowledge_search: "deny" })).toThrow(
			'remove "tools.approval.knowledge_search: deny"',
		);
		expect(() => requiresApproval(dispatch, {}, "always-ask", { write: "deny" })).toThrow(
			'remove "tools.approval.write: deny"',
		);
	});

	it("does not change resolution for tools without a policyKey", () => {
		const plain = tool("write", "exec");
		expect(resolveApproval(plain, {}, "always-ask", { write: "allow" }).policy).toBe("allow");
		expect(resolveApproval(plain, {}, "always-ask", { knowledge_search: "allow" }).policy).toBe("prompt");
	});
});

describe("WriteTool xd:// device policy key integration", () => {
	it("returns tier+policyKey for real mounted devices", () => {
		// Build a minimal apropos tool and WriteTool without loading the full
		// toolchain (which needs the native addon) — the approval function
		// only reads from `this.session.xdev` and basic session props.
		const device: AgentTool = {
			name: "knowledge_search",
			label: "Knowledge Search",
			description: "device without a tier declaration",
			parameters: { type: "object", properties: { q: { type: "string" } } } as any,
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const xdev = {
			tools: new Map([[device.name, device]]),
			mountedNames: new Set([device.name]),
			builtInNames: new Set([device.name]),
			isActive: () => false,
		};
		const session = {
			cwd: "/tmp",
			hasUI: false,
			xdev,
			settings: {
				get: () => undefined,
			},
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};

		// Use dynamic import to avoid loading the WriteTool module at parse time
		// (it chains into native addon code during module init).
		return import("@oh-my-soup/pi-coding-agent/tools/write").then(({ WriteTool }) => {
			const write = new WriteTool(session as any);
			const approvalFn = write.approval;
			expect(typeof approvalFn).toBe("function");
			if (typeof approvalFn !== "function") throw new Error("expected function");
			const result = approvalFn({
				path: "xd://knowledge_search",
				content: JSON.stringify({ q: "x" }),
			});
			expect(result).toEqual({ tier: "exec", policyKey: "knowledge_search" });
		});
	});
});
