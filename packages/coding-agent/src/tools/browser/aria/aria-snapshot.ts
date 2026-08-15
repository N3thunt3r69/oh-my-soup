import type { ElementHandle, JSHandle, Page } from "puppeteer-core";
import ariaBundle from "./aria-snapshot.bundle.txt" with { type: "text" };
import type { AriaSnapshotOptions } from "./selectors";

// `aria-snapshot.bundle.txt` is a generated, committed artifact: Playwright's
// injected ARIA-snapshot sources (pinned, Apache-2.0) bundled to a CJS module.
// The upstream sources are NOT vendored — regenerate the bundle with:
//   bun scripts/generate-aria-snapshot.ts
// (fetches the pinned tag, bundles in a temp dir, rewrites the .txt artifact.)

export type { AriaSnapshotOptions } from "./selectors";
// The pure selector helpers live in `./selectors` so eager importers stay off
// this module's bundle; re-exported here because the tab worker consumes the
// helpers and the snapshot evaluators together.
export { assertSelectorString, parseAriaRefSelector } from "./selectors";

/**
 * Page-side evaluators built ONCE here in the worker — never inside the page, so
 * page CSP never applies. They run the generated Playwright ARIA-snapshot bundle
 * (CJS, see scripts/generate-aria-snapshot.ts) in a throwaway module scope.
 *
 * Puppeteer serializes these functions to a CDP `Runtime.evaluate` in the page's
 * MAIN world (the only world where the bundle's `_ariaRef` ref expandos live —
 * isolated-world locators/query-handlers cannot see them). Nothing is installed
 * on `window`; the only footprint is the `_ariaRef` markers the snapshot writes,
 * which are the price of actionable `[ref=eN]` ids.
 */
function buildEvaluator(params: string, call: string): (...args: unknown[]) => unknown {
	return new Function(
		...params.split(",").map(p => p.trim()),
		`var module = { exports: {} };\n${ariaBundle}\nreturn module.exports.${call};`,
	) as unknown as (...args: unknown[]) => unknown;
}

// Handles (root) must stay top-level args: Puppeteer only unwraps JSHandles
// passed positionally to page.evaluate, never ones nested inside an object.
const evaluateAriaSnapshot = buildEvaluator("root, request", "ariaSnapshot(root, request)");
const evaluateResolveRef = buildEvaluator("ref", "resolveAriaRef(ref)");

/**
 * Capture a Playwright-format ARIA snapshot of `root` (or the whole document when
 * null). Always runs in `ai` mode so every node carries a `[ref=eN]` id; resolve
 * those to elements with {@link resolveAriaRefHandle}. Ids are renumbered from e1
 * on each call and remain valid until the next snapshot.
 */
export async function captureAriaSnapshot(
	page: Page,
	root: ElementHandle | null,
	options: AriaSnapshotOptions = {},
): Promise<string> {
	const request = { depth: options.depth, boxes: options.boxes };
	return (await page.evaluate(evaluateAriaSnapshot as never, root as never, request as never)) as string;
}

/**
 * Resolve a `[ref=eN]` id from the latest snapshot to a live `ElementHandle`, or
 * null when the ref no longer matches any element. Runs in the main world so it
 * sees the `_ariaRef` expandos the snapshot wrote.
 */
export async function resolveAriaRefHandle(page: Page, ref: string): Promise<ElementHandle | null> {
	const handle = (await page.evaluateHandle(evaluateResolveRef as never, ref as never)) as JSHandle;
	const element = handle.asElement();
	if (!element) {
		await handle.dispose().catch(() => undefined);
		return null;
	}
	return element as ElementHandle;
}

/**
 * Build a self-contained expression script that runs the vendored bundle in the
 * page and returns the ARIA snapshot YAML. Used by the cmux backend, whose
 * `browser.eval` RPC takes a script string and returns the completion value (it
 * has no ElementHandle to pass in). The script resolves `selector` via
 * `document.querySelector` in-page (CSS selectors only) or falls back to the
 * whole document. Like the puppeteer path it installs nothing on `window`.
 */
export function buildAriaSnapshotScript(selector: string | undefined, options: AriaSnapshotOptions = {}): string {
	const request = { depth: options.depth, boxes: options.boxes };
	const sel = selector ? JSON.stringify(selector) : "null";
	return `(function(){var module={exports:{}};\n${ariaBundle}\nvar __sel=${sel};var __root=__sel?document.querySelector(__sel):null;if(__sel&&!__root)throw new Error("tab.ariaSnapshot: selector "+__sel+" matched no element");return module.exports.ariaSnapshot(__root,${JSON.stringify(request)});})()`;
}
