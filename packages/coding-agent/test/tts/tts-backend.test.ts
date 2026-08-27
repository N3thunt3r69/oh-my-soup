import { describe, expect, test } from "bun:test";
import { resolveTtsBackend } from "@oh-my-soup/pi-coding-agent/tools/tts";

describe("resolveTtsBackend", () => {
	test("honors an explicit DeepInfra preference without changing auto routing", () => {
		expect(resolveTtsBackend({ preference: "deepinfra", wantsMp3: true, hasXaiCreds: true })).toBe("deepinfra");
		expect(resolveTtsBackend({ preference: "deepinfra", wantsMp3: false, hasXaiCreds: false })).toBe("deepinfra");
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: true, hasXaiCreds: true })).toBe("xai");
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: false, hasXaiCreds: true })).toBe("local");
	});
});
