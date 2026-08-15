// Light, pure selector helpers shared by the main-process browser tool and the
// tab worker. Kept separate from `aria-snapshot.ts` so eager importers (cmux
// tab, tool barrel) don't pull the generated Playwright ARIA bundle — that
// module loads lazily on the first `tab.observe()`/`tab.ariaSnapshot()`.
import { ToolError } from "../../tool-errors";

export interface AriaSnapshotOptions {
	/** Maximum tree depth to render. */
	depth?: number;
	/** Append `[box=x,y,w,h]` bounding boxes to each node. */
	boxes?: boolean;
}

const ARIA_REF_PREFIXES = ["aria-ref=", "aria-ref/", "ariaref/"];

/**
 * Guard the selector funnels: `tab.click`/`type`/`fill`/`waitFor*`/`scrollIntoView`
 * take string selectors only, but user `run` code routinely passes the ElementHandle
 * from `tab.id(n)`/`tab.ref(...)` (or an un-awaited Promise of one) straight in.
 * Without this the value reaches `.trim()`/`.startsWith()` and throws the opaque,
 * minified `A.trim is not a function` instead of a recovery-naming ToolError.
 */
export function assertSelectorString(selector: unknown): asserts selector is string {
	if (typeof selector === "string") return;
	let kind: string;
	if (selector !== null && typeof selector === "object") {
		kind =
			"then" in selector && typeof selector.then === "function" ? "a Promise (missing await?)" : "an ElementHandle";
	} else {
		kind = `a ${typeof selector}`;
	}
	throw new ToolError(
		`Browser selector must be a string; got ${kind}. ` +
			"tab.click/type/fill/waitFor take string selectors only — " +
			'call the handle method directly (e.g. (await tab.id(n)).click()) or pass a string like "aria-ref=eN".',
	);
}

/**
 * Recognize a snapshot-ref selector and return the bare ref id, else null.
 * Accepts `aria-ref=e5` (Playwright-MCP style), `aria-ref/e5`, `ariaref/e5`,
 * and bare `e5`/`@e5`: agents copy ids straight out of the snapshot YAML
 * (`[ref=e5]`), so `tab.click("e5")` must act on the ref instead of falling
 * through to a CSS tag selector that can never match. Bare ids are safe to
 * claim here — an eN tag name is not real HTML, and the tab-worker backend's
 * observe ids are numeric (`tab.id(7)`), so refs are its only eN namespace.
 * (The cmux backend parses selectors itself and routes bare `eN` to its own
 * observe ids; either way `eN` means "the id from the last page dump".)
 */
export function parseAriaRefSelector(selector: string): string | null {
	assertSelectorString(selector);
	const trimmed = selector.trim();
	for (const prefix of ARIA_REF_PREFIXES) {
		if (trimmed.startsWith(prefix)) {
			const id = trimmed.slice(prefix.length).trim();
			return /^e\d+$/.test(id) ? id : null;
		}
	}
	const bare = /^@?(e\d+)$/.exec(trimmed);
	return bare ? bare[1]! : null;
}
