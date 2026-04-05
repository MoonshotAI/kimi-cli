/**
 * Patch writer — converts cell-level diff into optimized ANSI output.
 *
 * Given two screens and the viewport, produces a single string containing
 * all the ANSI sequences needed to update the terminal from prev → next.
 *
 * Optimizations (inspired by Claude Code's log-update.ts):
 * - Only writes changed cells (not entire changed lines)
 * - Uses relative cursor movement between changed cells
 * - Caches style transitions (from → to) to minimize SGR bytes
 * - Uses carriage return (\r) when cheaper than CUB
 * - Skips SpacerTail cells (terminal auto-advances for wide chars)
 * - Wraps entire output in BSU/ESU for atomic terminal paint
 */

import {
	type Screen,
	type Viewport,
	CellWidth,
	STYLE_SHIFT,
	WIDTH_MASK,
} from "./types.ts";
import { type ChangedCell, computeDiff } from "./diff.ts";
import {
	cursorMove,
	cursorTo,
	ERASE_END_LINE,
	SGR_RESET,
	CR,
	LF,
	HIDE_CURSOR,
	SHOW_CURSOR,
} from "./csi.ts";
import { BSU, ESU, SYNC_SUPPORTED } from "./terminal-detect.ts";

// ── Style Transition Cache ──────────────────────────────

/**
 * Cache for style transition strings. Key = (fromId << 16 | toId).
 * Avoids recomputing SGR diffs for the same style pair every frame.
 */
const transitionCache = new Map<number, string>();

/**
 * Compute the SGR sequence to transition from one style to another.
 *
 * Strategy: We use the simplest approach — if styles differ, emit a reset
 * followed by the target style. This is slightly more bytes than a minimal
 * SGR diff but is always correct and avoids complex SGR state tracking.
 */
function styleTransition(screen: Screen, fromId: number, toId: number): string {
	if (fromId === toId) return "";

	const key = (fromId << 16) | toId;
	let cached = transitionCache.get(key);
	if (cached !== undefined) return cached;

	const toStyle = screen.stylePool[toId] ?? "";

	if (toId === 0) {
		// Target is no style — just reset
		cached = SGR_RESET;
	} else if (fromId === 0) {
		// From no style — just emit target
		cached = toStyle;
	} else {
		// From one style to another — reset then apply target
		// This is conservative; a smarter approach would diff the SGR attributes.
		cached = SGR_RESET + toStyle;
	}

	transitionCache.set(key, cached);
	return cached;
}

// ── Patch Builder ───────────────────────────────────────

/**
 * Build the optimized ANSI patch string to update the terminal from prev → next.
 *
 * @param prev Previous frame's screen buffer
 * @param next Current frame's screen buffer
 * @param viewport Terminal viewport dimensions
 * @param prevCursorY The row where the cursor was left after the previous render
 * @returns Object with the ANSI string to write and the new cursor Y position
 */
export function buildPatch(
	prev: Screen,
	next: Screen,
	viewport: Viewport,
	prevCursorY: number,
): { output: string; cursorY: number } {
	const changes = computeDiff(prev, next);

	if (changes.length === 0) {
		return { output: "", cursorY: prevCursorY };
	}

	// Cursor starts at (0, prevCursorY) — the position left by the previous frame.
	// In main-screen mode, cursor is at the line AFTER content (content height).
	let curX = 0;
	let curY = prevCursorY;
	let curStyleId = 0; // Tracks the active SGR state

	const parts: string[] = [];

	// ── Handle height changes ──

	const heightDelta = next.height - prev.height;
	const shrinking = heightDelta < 0;
	const growing = heightDelta > 0;

	// For growing: we'll need to emit newlines later to create new rows.
	// For shrinking: we need to erase extra lines.
	if (shrinking) {
		// Move cursor to the first line that needs to be erased
		// prev.height lines exist, next.height lines will remain
		// Erase from next.height to prev.height-1
		const linesToClear = prev.height - next.height;
		// Move to the last content line (prev.height - 1), then erase downward
		// Actually, simpler: after writing all changes, erase the extra lines.
		// We'll handle this at the end.
	}

	// ── Write changed cells ──

	// Changes are already in reading order (row-major from the diff).
	// We need to track whether we've "reached" each row. For rows in the
	// overlapping region, we use cursor movement. For new rows (growing),
	// we emit newlines.

	let lastEmittedRow = -1;

	for (const change of changes) {
		const { x, y, charId, styleId, width, clear } = change;

		// Skip SpacerTail — the terminal auto-advances when writing a wide char
		if (width === CellWidth.SpacerTail) continue;

		// For cells beyond the viewport, we can't reach them with cursor moves.
		// In main-screen mode, rows above viewport.height from the bottom are
		// in scrollback. We skip these and accept the flicker for edge cases.
		// (Claude Code also does this with fullResetSequence_CAUSES_FLICKER.)

		// ── Position cursor at (x, y) ──

		if (y !== curY || x !== curX) {
			// Vertical movement
			const dy = y - curY;

			if (dy > 0 && y >= prev.height) {
				// Need to create new rows — can only do this from the bottom of content
				// First, go to end of current content
				if (curY < prev.height) {
					const moveToEnd = prev.height - curY;
					if (moveToEnd > 0) {
						parts.push(CR);
						if (moveToEnd > 1) parts.push(cursorMove(0, moveToEnd - 1));
						curX = 0;
						curY = prev.height - 1;
					}
				}
				// Emit newlines to create rows up to y
				while (curY < y) {
					parts.push(LF);
					curY++;
				}
				curX = 0;
			} else if (dy !== 0) {
				// Normal cursor movement (up or down within existing content)
				parts.push(cursorMove(0, dy));
				curY = y;
				// Horizontal position is unknown after vertical move in some terminals,
				// but cursorMove only emits vertical codes. curX stays the same.
			}

			// Horizontal movement
			if (x !== curX) {
				if (x === 0) {
					parts.push(CR);
				} else if (curY !== y) {
					// After vertical move, use absolute column
					parts.push(cursorTo(x));
				} else {
					// Same row, use relative
					const dx = x - curX;
					parts.push(cursorMove(dx, 0));
				}
				curX = x;
			}
		}

		// ── Write the cell content ──

		if (clear) {
			// This cell needs to be cleared
			if (curStyleId !== 0) {
				parts.push(SGR_RESET);
				curStyleId = 0;
			}
			parts.push(" ");
			curX++;
		} else {
			// Apply style transition
			const transition = styleTransition(next, curStyleId, styleId);
			if (transition) {
				parts.push(transition);
				curStyleId = styleId;
			}

			// Write the character
			const char = next.charPool[charId] ?? " ";
			parts.push(char);

			// Advance cursor
			if (width === CellWidth.Wide) {
				curX += 2; // Wide char advances 2 columns
			} else {
				curX += 1;
			}
		}
	}

	// ── Handle shrinking: erase extra rows ──

	if (shrinking) {
		// Reset styles first
		if (curStyleId !== 0) {
			parts.push(SGR_RESET);
			curStyleId = 0;
		}

		// Move to the first row that needs clearing
		const firstClearRow = next.height;
		if (curY !== firstClearRow) {
			const dy = firstClearRow - curY;
			parts.push(cursorMove(0, dy));
			curY = firstClearRow;
		}

		// Erase each extra row
		for (let r = firstClearRow; r < prev.height; r++) {
			parts.push(CR + ERASE_END_LINE);
			if (r < prev.height - 1) {
				parts.push(cursorMove(0, 1));
				curY++;
			}
		}
	}

	// ── Reset style at end ──

	if (curStyleId !== 0) {
		parts.push(SGR_RESET);
		curStyleId = 0;
	}

	// ── Position cursor below content ──
	// In main-screen mode, cursor should be at (0, next.height) — one line
	// below the last content line. This is where Ink expects it.

	const targetCursorY = next.height;
	if (curY !== targetCursorY || curX !== 0) {
		if (curY < targetCursorY) {
			// Need to go down. If we're at or past the last content row,
			// use newlines to potentially create the row.
			parts.push(CR);
			const dy = targetCursorY - curY;
			for (let i = 0; i < dy; i++) {
				parts.push(LF);
			}
		} else if (curY > targetCursorY) {
			parts.push(CR);
			parts.push(cursorMove(0, targetCursorY - curY));
		} else {
			parts.push(CR);
		}
		curX = 0;
		curY = targetCursorY;
	}

	const output = parts.join("");
	return { output, cursorY: targetCursorY };
}

/**
 * Build the complete output for a frame, including BSU/ESU wrapping and
 * cursor hide/show.
 */
export function buildFrameOutput(
	prev: Screen,
	next: Screen,
	viewport: Viewport,
	prevCursorY: number,
	showCursor: boolean,
): { output: string; cursorY: number } {
	const { output: patch, cursorY } = buildPatch(
		prev,
		next,
		viewport,
		prevCursorY,
	);

	if (patch.length === 0) {
		return { output: "", cursorY };
	}

	let output = "";

	// Wrap in synchronized update if supported
	if (SYNC_SUPPORTED) output += BSU;

	// Hide cursor during update to prevent flicker
	if (!showCursor) output += HIDE_CURSOR;

	output += patch;

	if (!showCursor) output += SHOW_CURSOR;

	if (SYNC_SUPPORTED) output += ESU;

	return { output, cursorY };
}
