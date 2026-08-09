/**
 * `crates/pi-builtins/BUILD.bazel` pins the crate's cargo features explicitly,
 * so a feature added to Cargo.toml's `default` closure silently vanishes from
 * every bazel-built artifact — the shipped native addon included.
 *
 * That drift shipped once: `utils` grew `util.rg` and the process-table
 * builtins (`ps`, `top`, `pgrep`, `pkill`, `pidwait`, `nohup`, `sleep`,
 * `timeout`) while the BUILD file kept the older list, so
 * `pi_builtins::process_builtins()` came back empty in every bazel build and
 * `//crates/pi-shell:pi-shell_test` failed the moment it was executed instead
 * of served from cache.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const cargoTomlPath = path.join(repoRoot, "crates", "pi-builtins", "Cargo.toml");
const buildBazelPath = path.join(repoRoot, "crates", "pi-builtins", "BUILD.bazel");

/** Parse the `[features]` table into `name -> directly implied features`. */
function parseCargoFeatures(toml: string): Map<string, string[]> {
	// No `m` flag: `$` must mean end-of-input so a trailing `[features]` table
	// still captures. Section boundaries are matched explicitly as `\n[`.
	const section = toml.match(/\n\[features\]\n([\s\S]*?)(?=\n\[|$)/)?.[1];
	if (!section) throw new Error("pi-builtins Cargo.toml has no [features] table");
	const features = new Map<string, string[]>();
	for (const entry of section.matchAll(/^"?([A-Za-z0-9_.-]+)"?\s*=\s*\[([\s\S]*?)\]/gm)) {
		features.set(
			entry[1],
			[...entry[2].matchAll(/"([^"]+)"/g)].map(m => m[1]),
		);
	}
	return features;
}

/** Everything cargo would enable for a default-features build. */
function resolveDefaultClosure(features: Map<string, string[]>): Set<string> {
	const enabled = new Set<string>();
	const queue = [...(features.get("default") ?? [])];
	while (queue.length > 0) {
		const name = queue.pop() as string;
		// `dep/feature` and `dep?/feature` enable a dependency's feature, not one
		// of this crate's — they never appear in `crate_features`.
		if (name.includes("/")) continue;
		if (enabled.has(name)) continue;
		enabled.add(name);
		queue.push(...(features.get(name) ?? []));
	}
	return enabled;
}

function parseBazelCrateFeatures(build: string): string[] {
	const list = build.match(/crate_features = \[([\s\S]*?)\n\s*\]/)?.[1];
	if (!list) throw new Error("pi-builtins BUILD.bazel has no crate_features list");
	return [...list.matchAll(/"([^"]+)"/g)].map(m => m[1]);
}

describe("pi-builtins bazel feature parity", () => {
	test("BUILD.bazel enables exactly cargo's default feature closure", async () => {
		const cargoFeatures = parseCargoFeatures(await Bun.file(cargoTomlPath).text());
		const expected = resolveDefaultClosure(cargoFeatures);
		const declared = parseBazelCrateFeatures(await Bun.file(buildBazelPath).text());

		// Sorted arrays, not sets: the assertion message then names the exact
		// features that drifted instead of reporting "sets differ".
		expect(declared).toEqual([...expected].sort());
	});

	test("the process builtins cargo ships are bazel-enabled", async () => {
		// The regression that motivated this file. `util.procs` alone (the shared
		// process-table snapshot) leaves every process builtin unregistered.
		const declared = new Set(parseBazelCrateFeatures(await Bun.file(buildBazelPath).text()));
		for (const feature of [
			"util.nohup",
			"util.pgrep",
			"util.pidwait",
			"util.pkill",
			"util.proc-match",
			"util.procs",
			"util.ps",
			"util.rg",
			"util.top",
		]) {
			expect(declared.has(feature), `${feature} missing from crate_features`).toBe(true);
		}
	});
});
