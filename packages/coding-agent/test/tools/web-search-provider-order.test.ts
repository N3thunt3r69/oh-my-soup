import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-soup/pi-ai";
import { runSearchQuery } from "@oh-my-soup/pi-coding-agent/web/search";
import {
	resolveProviderCandidates,
	setExcludedSearchProviders,
	setSearchProviderOrder,
} from "@oh-my-soup/pi-coding-agent/web/search/provider";
import { DuckDuckGoProvider } from "@oh-my-soup/pi-coding-agent/web/search/providers/duckduckgo";
import { GoogleProvider } from "@oh-my-soup/pi-coding-agent/web/search/providers/google";
import { SearchProviderError } from "@oh-my-soup/pi-coding-agent/web/search/types";

const authStorage = {} as AuthStorage;

beforeEach(() => {
	setSearchProviderOrder([]);
	setExcludedSearchProviders([]);
});

afterEach(() => {
	vi.restoreAllMocks();
	setSearchProviderOrder([]);
	setExcludedSearchProviders([]);
});

describe("default web search provider order", () => {
	it("starts with Google and DuckDuckGo while preserving explicit overrides", () => {
		expect(resolveProviderCandidates().slice(0, 2)).toEqual([
			{ id: "google", explicit: false },
			{ id: "duckduckgo", explicit: false },
		]);

		setSearchProviderOrder(["exa"]);
		expect(resolveProviderCandidates().slice(0, 3)).toEqual([
			{ id: "exa", explicit: true },
			{ id: "google", explicit: false },
			{ id: "duckduckgo", explicit: false },
		]);
	});

	it("falls back to DuckDuckGo when Google fails", async () => {
		const calls: string[] = [];
		vi.spyOn(GoogleProvider.prototype, "search").mockImplementation(async () => {
			calls.push("google");
			throw new SearchProviderError("google", "Google unavailable", 503);
		});
		vi.spyOn(DuckDuckGoProvider.prototype, "search").mockImplementation(async () => {
			calls.push("duckduckgo");
			return {
				provider: "duckduckgo",
				sources: [{ title: "Fallback result", url: "https://example.com", snippet: "DuckDuckGo result" }],
			};
		});

		const result = await runSearchQuery({ query: "fallback contract" }, { authStorage });

		expect(calls).toEqual(["google", "google", "google", "duckduckgo"]);
		expect(result.details.response.provider).toBe("duckduckgo");
		expect(result.content[0]?.text).toContain("Fallback result");
	});
});
