/**
 * Bordered output container with optional header and sections.
 */
import type { Component } from "@oh-my-soup/pi-tui";
import { ImageProtocol, padding, TERMINAL, visibleWidth, wrapTextWithAnsi } from "@oh-my-soup/pi-tui";
import { getThemeEpoch, type Theme, type ThemeColor } from "../modes/theme/theme";
import { getSixelLineMask } from "../utils/sixel";
import type { State } from "./types";
import { getStateBgColor, padToWidth, truncateToWidth } from "./utils";

export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: readonly string[]; separator?: boolean }>;
	width: number;
	applyBg?: boolean;
	contentPaddingLeft?: number;
	contentPaddingRight?: number;
	/** Override the state-derived border color. Used for muted "legacy" tool
	 * frames that should not visually compete with framed-output tools. */
	borderColor?: ThemeColor;
}

const FRAMED_BLOCK_COMPONENT = Symbol("framedBlockComponent");

export type FramedBlockComponent = Component & { [FRAMED_BLOCK_COMPONENT]?: true };

export function markFramedBlockComponent<T extends Component>(component: T): T & FramedBlockComponent {
	(component as T & FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] = true;
	return component as T & FramedBlockComponent;
}

export function isFramedBlockComponent(component: Component): boolean {
	return (component as FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] === true;
}

type BlockRow =
	| { kind: "bar"; leftChar: string; rightChar: string; label?: string; meta?: string }
	| { kind: "bottom"; leftChar: string; rightChar: string }
	| { kind: "content"; inner: string }
	| { kind: "sixel"; raw: string };

function normalizeContentPaddingLeft(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 1;
	return Math.max(0, Math.floor(value));
}

/**
 * Inner content width that {@link renderOutputBlock} wraps its body to, for a
 * given outer `width`: both vertical borders plus symmetric content padding.
 * An explicit left padding of zero keeps legacy flush blocks flush on both
 * sides unless a right padding is provided separately.
 */
export function outputBlockContentWidth(
	width: number,
	contentPaddingLeft?: number,
	contentPaddingRight?: number,
): number {
	const left = normalizeContentPaddingLeft(contentPaddingLeft);
	const right = normalizeContentPaddingLeft(contentPaddingRight ?? left);
	return Math.max(1, width - 2 - left - right);
}

export function renderOutputBlock(options: OutputBlockOptions, theme: Theme): string[] {
	const { header, headerMeta, state, sections = [], width, applyBg = true } = options;
	const h = theme.boxRound.horizontal;
	const v = theme.boxRound.vertical;
	const cap = h.repeat(3);
	const lineWidth = Math.max(0, width);
	// Border colors: running/pending use accent, error/warning keep their state
	// colors, and neutral/success resting frames use borderMuted — the same
	// weight the editor frame carries.
	const borderColor: ThemeColor =
		options.borderColor ??
		(state === "error"
			? "error"
			: state === "warning"
				? "warning"
				: state === "running" || state === "pending"
					? "accent"
					: "borderMuted");
	const border = (text: string) => theme.fg(borderColor, text);
	const bgFn = (() => {
		if (!state || !applyBg) return undefined;
		const bgAnsi = theme.getBgAnsi(getStateBgColor(state));
		// Keep block background stable even if inner content contains SGR resets (e.g. "\x1b[0m"),
		// which would otherwise clear the outer background mid-line.
		return (text: string) => {
			const stabilized = text
				.replace(/\x1b\[(?:0)?m/g, m => `${m}${bgAnsi}`)
				.replace(/\x1b\[49m/g, m => `${m}${bgAnsi}`);
			return `${bgAnsi}${stabilized}\x1b[49m`;
		};
	})();

	const contentPaddingLeft = normalizeContentPaddingLeft(options.contentPaddingLeft);
	const contentPaddingRight = normalizeContentPaddingLeft(options.contentPaddingRight ?? contentPaddingLeft);
	const contentWidth = Math.max(
		0,
		lineWidth - visibleWidth(v) - contentPaddingLeft - contentPaddingRight - visibleWidth(v),
	);
	const contentLeftPadding = contentPaddingLeft > 0 ? padding(contentPaddingLeft) : "";
	const contentRightPadding = contentPaddingRight > 0 ? padding(contentPaddingRight) : "";

	// ── Layout pass: collect row descriptors before emitting the bordered lines. ──
	const rows: BlockRow[] = [];
	rows.push({
		kind: "bar",
		leftChar: theme.boxRound.topLeft,
		rightChar: theme.boxRound.topRight,
		label: header,
		meta: headerMeta,
	});

	const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
	for (let sectionIndex = 0; sectionIndex < normalizedSections.length; sectionIndex++) {
		const section = normalizedSections[sectionIndex]!;
		// A labeled section always draws its titled separator bar. A label-less
		// section can still request a plain divider via `separator`, but only
		// between sections — leading with one would just double the header bar.
		if (section.label) {
			rows.push({
				kind: "bar",
				leftChar: theme.boxRound.teeRight,
				rightChar: theme.boxRound.teeLeft,
				label: section.label,
			});
		} else if (section.separator && sectionIndex > 0) {
			rows.push({
				kind: "bar",
				leftChar: theme.boxRound.teeRight,
				rightChar: theme.boxRound.teeLeft,
			});
		}
		const allLines = section.lines.flatMap(l => l.split("\n"));
		const sixelLineMask = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
		for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
			const line = allLines[lineIndex]!;
			if (sixelLineMask?.[lineIndex]) {
				rows.push({ kind: "sixel", raw: line });
				continue;
			}
			const wrappedLines = wrapTextWithAnsi(line.trimEnd(), contentWidth);
			for (const wrappedLine of wrappedLines) {
				const innerPadding = padding(Math.max(0, contentWidth - visibleWidth(wrappedLine)));
				rows.push({ kind: "content", inner: `${wrappedLine}${innerPadding}` });
			}
		}
	}

	rows.push({ kind: "bottom", leftChar: theme.boxRound.bottomLeft, rightChar: theme.boxRound.bottomRight });

	const H = rows.length;

	const renderBar = (row: { leftChar: string; rightChar: string; label?: string; meta?: string }): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		if (lineWidth <= 0) return border(leftGlyphs) + border(rightGlyph);
		const labelText = [row.label, row.meta].filter(Boolean).join(theme.sep.dot);
		if (!labelText) {
			// No header: draw a clean, continuous top/separator bar (no 1-col gap).
			const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
			return `${border(leftGlyphs)}${border(h.repeat(fillCount))}${border(rightGlyph)}`;
		}
		const rawLabel = ` ${labelText} `;
		const leftWidth = visibleWidth(leftGlyphs);
		const rightWidth = visibleWidth(rightGlyph);
		const maxLabelWidth = Math.max(0, lineWidth - leftWidth - rightWidth);
		const trimmedLabel = truncateToWidth(rawLabel, maxLabelWidth);
		const labelWidth = visibleWidth(trimmedLabel);
		const fillCount = Math.max(0, lineWidth - leftWidth - labelWidth - rightWidth);
		const fillGlyphs = h.repeat(fillCount);
		return `${border(leftGlyphs)}${trimmedLabel}${border(fillGlyphs)}${border(rightGlyph)}`;
	};

	const renderBottom = (row: { leftChar: string; rightChar: string }): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
		const fillGlyphs = h.repeat(fillCount);
		return `${border(leftGlyphs)}${border(fillGlyphs)}${border(rightGlyph)}`;
	};

	const renderContent = (inner: string): string =>
		`${border(v)}${contentLeftPadding}${inner}${contentRightPadding}${border(v)}`;

	const lines: string[] = [];
	for (let r = 0; r < H; r++) {
		const row = rows[r]!;
		if (row.kind === "sixel") {
			lines.push(row.raw);
			continue;
		}
		const line =
			row.kind === "bar" ? renderBar(row) : row.kind === "bottom" ? renderBottom(row) : renderContent(row.inner);
		lines.push(padToWidth(line, lineWidth, bgFn));
	}

	return lines;
}

/**
 * Cached wrapper around `renderOutputBlock`.
 *
 * Output blocks are re-rendered on every frame (via `render(width)` closures),
 * but their content only changes when the hosting tool block is rebuilt — the
 * transcript recreates renderer components whenever a display input changes
 * (result version, expanded, spinner frame, theme epoch, …). The cache is
 * keyed on `(width, revision, theme epoch)`: the caller bumps `revision` for
 * any content mutation that can happen *without* a rebuild, and the `build`
 * thunk (options construction included) is skipped entirely on a hit.
 */
export class CachedOutputBlock {
	#cache?: { width: number; revision: number | string; epoch: number; lines: readonly string[] };

	/**
	 * Render with caching. Returns the cached (shared, caller-immutable) lines —
	 * without invoking `build` — while `(width, revision, theme epoch)` is
	 * unchanged.
	 */
	render(width: number, revision: number | string, build: () => OutputBlockOptions, theme: Theme): readonly string[] {
		const epoch = getThemeEpoch();
		const cache = this.#cache;
		if (cache !== undefined && cache.width === width && cache.revision === revision && cache.epoch === epoch) {
			return cache.lines;
		}
		const lines = renderOutputBlock(build(), theme);
		this.#cache = { width, revision, epoch, lines };
		return lines;
	}

	/** Invalidate the cache, forcing a rebuild on next render. */
	invalidate(): void {
		this.#cache = undefined;
	}
}

/**
 * Build a self-framing tool component backed by a cached output block. The
 * `build` callback returns the block options for a given width; the cache
 * dedupes re-renders and skips `build` entirely while `(width, revision,
 * theme epoch)` is unchanged. Closures whose output can change without the
 * hosting tool block being rebuilt (live clocks, module-level providers) must
 * supply a `revision` that changes alongside those inputs; everything else
 * is static per component instance. Pass `borderColor: "borderMuted"` for the
 * dim "legacy" look that does not compete with the state-colored framed tools.
 */
export function framedBlock(
	theme: Theme,
	build: (width: number) => OutputBlockOptions,
	revision?: () => number | string,
): Component {
	const block = new CachedOutputBlock();
	// Marked so the tool-execution container treats it as self-framing (renders
	// flush, no extra padding/background) the same way `markFramedBlockComponent`
	// blocks are treated.
	return markFramedBlockComponent({
		render: (width: number): readonly string[] =>
			block.render(width, revision === undefined ? 0 : revision(), () => build(width), theme),
		invalidate: () => block.invalidate(),
	});
}
