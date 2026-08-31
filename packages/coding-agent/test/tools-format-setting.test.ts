import { describe, expect, it } from "bun:test";
import { getDefault, getEnumValues } from "../src/config/settings-schema";

describe("tools.format", () => {
	it("defaults to the compact emoji dialect", () => {
		expect(getDefault("tools.format")).toBe("emoji");
		expect(getEnumValues("tools.format")).toContain("emoji");
	});
});
