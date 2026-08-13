import { afterEach, describe, expect, it, vi } from "bun:test";
import { getLatestRelease, runUpdateCommand } from "../../src/cli/update-cli";

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

describe("getLatestRelease rename pointers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubRegistry(manifests: Record<string, unknown>): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				let manifest: unknown;
				for (const pkg in manifests) {
					if (url.includes(pkg)) {
						manifest = manifests[pkg];
						break;
					}
				}
				if (!manifest) return new Response(null, { status: 404, statusText: "Not Found" });
				return Response.json(manifest);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("follows oms.rename to the new package and resolves version, dist, and names from its manifest", async () => {
		const urls = stubRegistry({
			"@new/oms": { version: "999.1.0", oms: { dist: "npm" } },
			"@oh-my-soup/pi-coding-agent": {
				version: "999.0.0",
				oms: { dist: "binary", rename: { package: "@new/oms", natives: "@new/natives" } },
			},
		});

		const release = await getLatestRelease();

		expect(release.version).toBe("999.1.0");
		expect(release.dist).toBe("npm");
		expect(release.packages).toEqual({ pkg: "@new/oms", natives: "@new/natives" });
		expect(urls).toEqual([
			"https://registry.npmjs.org/@oh-my-soup/pi-coding-agent/latest",
			"https://registry.npmjs.org/@new/oms/latest",
		]);
	});

	it("ignores a rename pointer that cycles back to an already-visited package", async () => {
		const urls = stubRegistry({
			"@oh-my-soup/pi-coding-agent": {
				version: "999.0.0",
				oms: { rename: { package: "@oh-my-soup/pi-coding-agent" } },
			},
		});

		const release = await getLatestRelease();

		expect(urls).toHaveLength(1);
		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@oh-my-soup/pi-coding-agent", natives: "@oh-my-soup/pi-natives" });
	});
});
