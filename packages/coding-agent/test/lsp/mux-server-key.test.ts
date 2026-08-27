import { describe, expect, it } from "bun:test";
import { type MuxConnectParams, muxServerKey } from "@oh-my-soup/pi-coding-agent/lsp/mux/protocol";

const BASE_PARAMS: MuxConnectParams = {
	command: "typescript-language-server",
	args: ["--stdio"],
	cwd: "/workspace/project",
	configurationIdentity: "sha256:base-configuration",
};

describe("muxServerKey", () => {
	it("is stable across equal-by-value handshake parameters", () => {
		expect(muxServerKey({ ...BASE_PARAMS })).toBe(muxServerKey({ ...BASE_PARAMS, args: [...BASE_PARAMS.args] }));
	});

	it("separates servers by command and cwd", () => {
		expect(muxServerKey({ ...BASE_PARAMS, command: "rust-analyzer" })).not.toBe(muxServerKey(BASE_PARAMS));
		expect(muxServerKey({ ...BASE_PARAMS, cwd: "/workspace/other" })).not.toBe(muxServerKey(BASE_PARAMS));
	});

	it("separates servers that differ only in args", () => {
		const verbose = muxServerKey({ ...BASE_PARAMS, args: ["--stdio", "--log-level", "4"] });
		expect(verbose).not.toBe(muxServerKey(BASE_PARAMS));
	});

	it("keeps split and joined arguments distinct", () => {
		const split = muxServerKey({ ...BASE_PARAMS, args: ["--log-level", "4"] });
		const joined = muxServerKey({ ...BASE_PARAMS, args: ["--log-level 4"] });
		expect(split).not.toBe(joined);
	});

	it("separates servers that differ only in env", () => {
		const tuned = muxServerKey({ ...BASE_PARAMS, env: { NODE_OPTIONS: "--max-old-space-size=8192" } });
		expect(tuned).not.toBe(muxServerKey(BASE_PARAMS));
	});

	it("separates servers that differ only in initialization identity", () => {
		const tuned = muxServerKey({
			...BASE_PARAMS,
			configurationIdentity: "sha256:different-configuration",
		});
		expect(tuned).not.toBe(muxServerKey(BASE_PARAMS));
	});

	it("does not expose environment values in the externally visible key", () => {
		const secret = "secret-language-server-token";
		const key = muxServerKey({ ...BASE_PARAMS, env: { LANGUAGE_SERVER_TOKEN: secret } });
		expect(key).not.toContain(secret);
		expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("treats env key order as irrelevant", () => {
		const forward = muxServerKey({ ...BASE_PARAMS, env: { A: "1", B: "2" } });
		const reverse = muxServerKey({ ...BASE_PARAMS, env: { B: "2", A: "1" } });
		expect(forward).toBe(reverse);
	});

	it("treats an absent env as an empty env", () => {
		expect(muxServerKey({ ...BASE_PARAMS, env: {} })).toBe(muxServerKey(BASE_PARAMS));
	});
});
