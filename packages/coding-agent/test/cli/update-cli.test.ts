import { afterEach, describe, expect, it, vi } from "bun:test";
import { runUpdateCommand } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		let requestUrl: string | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		// The version probe reads the `releases/latest` redirect, so the stub has
		// to answer with the 302 that carries the tag — a body-only response would
		// look like a repository with no releases.
		const fetchStub = Object.assign(
			async (input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				requestUrl = String(input);
				return new Response(null, {
					status: 302,
					headers: { location: "https://github.com/pickpocket/oh-my-soup/releases/tag/v999.0.0" },
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestUrl).toBe("https://github.com/pickpocket/oh-my-soup/releases/latest");
		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});
