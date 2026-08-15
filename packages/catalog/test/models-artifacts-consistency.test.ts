import { describe, expect, it } from "bun:test";
import { type GeneratedProvider, getBundledModelIds, getBundledProviders } from "../src/models";
import { MODEL_CHUNKS } from "../src/models/chunks";
import MODELS from "../src/models.json" with { type: "json" };
import MODEL_INDEX from "../src/models-index.json";

// The runtime serves the bundled catalog from generated per-provider chunks
// (`src/models/<provider>.json.txt` via `chunks.ts`) plus the id index
// (`src/models-index.json`), while `src/models.json` remains the reviewable
// full snapshot and `./models.json` package export. All of them are emitted
// by one `bun run gen:models` run and must agree byte-for-byte.
//
// Failure here means the artifacts drifted — someone hand-edited one of them
// or committed a partial regen. Re-run `bun run gen:models` and commit
// `models.json`, `models-index.json`, and `src/models/` together.
describe("generated catalog artifacts consistency (regression)", () => {
	const snapshot = MODELS as Record<string, Record<string, unknown>>;
	const providers = Object.keys(snapshot);

	it("chunk map and index carry exactly the snapshot's providers, in order", () => {
		expect(Object.keys(MODEL_CHUNKS)).toEqual(providers);
		expect(Object.keys(MODEL_INDEX)).toEqual(providers);
		expect(getBundledProviders() as string[]).toEqual(providers);
	});

	it("every provider chunk parses to the snapshot's provider body", () => {
		for (const provider of providers) {
			expect(JSON.parse(MODEL_CHUNKS[provider]), `chunk mismatch for ${provider}`).toEqual(snapshot[provider]);
		}
	});

	it("index id lists match the snapshot's model ids, in order", () => {
		for (const provider of providers) {
			expect(
				getBundledModelIds(provider as GeneratedProvider) as string[],
				`id list mismatch for ${provider}`,
			).toEqual(Object.keys(snapshot[provider]));
		}
	});
});
