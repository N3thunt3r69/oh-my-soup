import { describe, expect, it } from "bun:test";
import { getDefault, getEnumValues } from "../src/config/settings-schema";

describe("tools.format", () => {
	it("defaults to model-compatible automatic selection", () => {
		expect(getDefault("tools.format")).toBe("auto");
		expect(getEnumValues("tools.format")).toContain("emoji");
	});
});
