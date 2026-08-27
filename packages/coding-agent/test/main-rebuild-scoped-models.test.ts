import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-soup/pi-agent-core";
import type { Api, Model } from "@oh-my-soup/pi-ai";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import { parseArgs } from "@oh-my-soup/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { resolveModelScope } from "@oh-my-soup/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import {
	buildSessionOptions,
	rebuildScopedModelsAfterDiscovery,
	resolveScopedModels,
	type ScopedModelSink,
	toSessionScopedModels,
} from "@oh-my-soup/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-soup/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-soup/pi-coding-agent/session/session-manager";

function model(id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "prov",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

class FakeRegistry {
	available: Model<Api>[];
	discoverableProviders = ["prov"];
	refreshCalls = 0;
	onRefresh: (() => void) | undefined;

	constructor(initial: Model<Api>[], onRefresh?: () => void) {
		this.available = initial;
		this.onRefresh = onRefresh;
	}

	getAvailable(): Model<Api>[] {
		return this.available;
	}

	getDiscoverableProviders(): string[] {
		return this.discoverableProviders;
	}

	async refresh(): Promise<void> {
		this.refreshCalls += 1;
		this.onRefresh?.();
	}

	async awaitBackgroundRefresh(): Promise<void> {
		this.onRefresh?.();
	}
}

class FakeSession implements ScopedModelSink {
	isDisposed = false;
	scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	setCalls = 0;

	constructor(initial: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>) {
		this.scopedModels = initial;
	}

	setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void {
		this.setCalls += 1;
		this.scopedModels = scopedModels;
	}
}

async function startupScope(
	patterns: string[],
	registry: FakeRegistry,
	settings: Settings,
): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
	return toSessionScopedModels(await resolveModelScope(patterns, registry, undefined, settings), settings);
}

describe("rebuildScopedModelsAfterDiscovery", () => {
	it("adds an enabled model that materializes after background discovery", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/a", "prov/b"] });
		const registry = new FakeRegistry([model("a")]);
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));

		registry.available = [model("a"), model("b")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		expect(session.setCalls).toBe(1);
		expect(session.scopedModels.map(entry => entry.model.id)).toEqual(["a", "b"]);
	});

	it("activates a scope that initially resolved empty", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/b"] });
		const registry = new FakeRegistry([model("a")]);
		const session = new FakeSession(await startupScope(["prov/b"], registry, settings));

		registry.available = [model("a"), model("b")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		expect(session.setCalls).toBe(1);
		expect(session.scopedModels.map(entry => entry.model.id)).toEqual(["b"]);
	});

	it("leaves the scope untouched when discovery adds no matching model", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/a", "prov/b"] });
		const registry = new FakeRegistry([model("a"), model("b")]);
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));
		const before = session.scopedModels;

		registry.available = [model("a"), model("b"), model("c")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		expect(session.setCalls).toBe(0);
		expect(session.scopedModels).toBe(before);
	});

	it("re-resolves an explicit --models scope", async () => {
		const settings = Settings.isolated();
		const registry = new FakeRegistry([model("a")]);
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));

		registry.available = [model("a"), model("b")];
		await rebuildScopedModelsAfterDiscovery(session, parseArgs(["--models", "prov/a,prov/b"]), registry, settings);

		expect(session.scopedModels.map(entry => entry.model.id)).toEqual(["a", "b"]);
	});

	it("skips a disposed session", async () => {
		const settings = Settings.isolated({ enabledModels: ["prov/a", "prov/b"] });
		const registry = new FakeRegistry([model("a")]);
		const session = new FakeSession(await startupScope(["prov/a", "prov/b"], registry, settings));
		session.isDisposed = true;
		registry.available = [model("a"), model("b")];

		await rebuildScopedModelsAfterDiscovery(session, parseArgs([]), registry, settings);

		expect(session.setCalls).toBe(0);
		expect(session.scopedModels.map(entry => entry.model.id)).toEqual(["a"]);
	});
});

describe("resolveScopedModels", () => {
	it("refreshes a collapsed discovery-backed scope before session selection", async () => {
		const settings = Settings.isolated();
		const registry = new FakeRegistry([], () => {
			registry.available = [model("b")];
		});

		const scoped = await resolveScopedModels(parseArgs(["--models", "prov/b"]), registry, settings);

		expect(registry.refreshCalls).toBe(1);
		expect(scoped.map(entry => entry.model.id)).toEqual(["b"]);
	});
});

describe("buildSessionOptions --models scope selection", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "main-rebuild-scoped-models-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterAll(async () => {
		authStorage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function registry(): ModelRegistry {
		return new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	}

	it("defers an empty --models scope to SDK modelPattern resolution", async () => {
		const parsed = parseArgs(["--models", "extprov/model-x,extprov/model-y"]);
		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), registry(), Settings.isolated());

		expect(options.model).toBeUndefined();
		expect(options.modelPattern).toEqual(["extprov/model-x", "extprov/model-y"]);
		expect(options.scopedModels).toBeUndefined();
	});

	it("pins the first model when the scope resolves", async () => {
		const parsed = parseArgs(["--models", "prov/a"]);
		const scoped = await resolveModelScope(["prov/a"], { getAvailable: () => [model("a")] }, undefined);
		const options = await buildSessionOptions(
			parsed,
			scoped,
			SessionManager.inMemory(),
			registry(),
			Settings.isolated(),
		);

		expect(options.modelPattern).toBeUndefined();
		expect(options.model?.id).toBe("a");
		expect(options.scopedModels?.map(entry => entry.model.id)).toEqual(["a"]);
	});
});
