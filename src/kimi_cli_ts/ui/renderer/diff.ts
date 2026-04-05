/**
 * Cell-level diff engine.
 *
 * Compares two Screen buffers at the cell level and produces a list of
 * changed cell coordinates. The patch-writer then converts these into
 * an optimized ANSI sequence.
 *
 * Key insight from Claude Code: by comparing packed Int32 values, we can
 * detect cell changes with 2 integer comparisons per cell (charId + packed
 * styleId|width) — no string comparison or object allocation needed.
 */

import { type Screen, STYLE_SHIFT, WIDTH_MASK, CellWidth } from "./types.ts";

// ── Changed Cell ────────────────────────────────────────

export type ChangedCell = {
	x: number;
	y: number;
	/** charId in the NEXT screen's pool. */
	charId: number;
	/** styleId in the NEXT screen's pool. */
	styleId: number;
	/** Cell width. */
	width: number;
	/** True if this cell should be cleared (exists in prev but not next). */
	clear: boolean;
};

// ── Diff ────────────────────────────────────────────────

/**
 * Compute the diff between two screens.
 *
 * Returns an array of changed cells, sorted in reading order (row-major).
 * Cells that exist in prev but not in next (due to shrinking) are marked
 * with `clear: true`. The caller must handle erasing those cells.
 *
 * For performance, both screens share the same char/style pools (via copyPools),
 * so charId and styleId can be compared directly as integers.
 */
export function computeDiff(prev: Screen, next: Screen): ChangedCell[] {
	const changes: ChangedCell[] = [];

	const pw = prev.width;
	const nw = next.width;
	const ph = prev.height;
	const nh = next.height;
	const minH = Math.min(ph, nh);
	const minW = Math.min(pw, nw);

	const pc = prev.cells;
	const nc = next.cells;

	// ── Compare overlapping region ──
	for (let y = 0; y < minH; y++) {
		const pRowBase = y * pw * 2;
		const nRowBase = y * nw * 2;

		for (let x = 0; x < minW; x++) {
			const pi = pRowBase + x * 2;
			const ni = nRowBase + x * 2;

			if (pc[pi] !== nc[ni] || pc[pi + 1] !== nc[ni + 1]) {
				const w1 = nc[ni + 1]!;
				changes.push({
					x,
					y,
					charId: nc[ni]!,
					styleId: w1 >>> STYLE_SHIFT,
					width: w1 & WIDTH_MASK,
					clear: false,
				});
			}
		}

		// ── Cells added (next wider than prev) ──
		for (let x = minW; x < nw; x++) {
			const ni = nRowBase + x * 2;
			if (nc[ni] !== 0 || nc[ni + 1] !== 0) {
				const w1 = nc[ni + 1]!;
				changes.push({
					x,
					y,
					charId: nc[ni]!,
					styleId: w1 >>> STYLE_SHIFT,
					width: w1 & WIDTH_MASK,
					clear: false,
				});
			}
		}

		// ── Cells removed (prev wider than next) ──
		for (let x = minW; x < pw; x++) {
			const pi = pRowBase + x * 2;
			if (pc[pi] !== 0 || pc[pi + 1] !== 0) {
				changes.push({
					x,
					y,
					charId: 0,
					styleId: 0,
					width: CellWidth.Narrow,
					clear: true,
				});
			}
		}
	}

	// ── Rows only in next (added) ──
	for (let y = minH; y < nh; y++) {
		const nRowBase = y * nw * 2;
		for (let x = 0; x < nw; x++) {
			const ni = nRowBase + x * 2;
			if (nc[ni] !== 0 || nc[ni + 1] !== 0) {
				const w1 = nc[ni + 1]!;
				changes.push({
					x,
					y,
					charId: nc[ni]!,
					styleId: w1 >>> STYLE_SHIFT,
					width: w1 & WIDTH_MASK,
					clear: false,
				});
			}
		}
	}

	// ── Rows only in prev (removed) ──
	for (let y = minH; y < ph; y++) {
		const pRowBase = y * pw * 2;
		for (let x = 0; x < pw; x++) {
			const pi = pRowBase + x * 2;
			if (pc[pi] !== 0 || pc[pi + 1] !== 0) {
				changes.push({
					x,
					y,
					charId: 0,
					styleId: 0,
					width: CellWidth.Narrow,
					clear: true,
				});
			}
		}
	}

	return changes;
}

/**
 * Quick check: are the two screens identical?
 * Returns true if no cells differ. Used to short-circuit rendering.
 */
export function screensEqual(prev: Screen, next: Screen): boolean {
	if (prev.width !== next.width || prev.height !== next.height) return false;

	const len = prev.cells.length;
	const pc = prev.cells;
	const nc = next.cells;

	for (let i = 0; i < len; i++) {
		if (pc[i] !== nc[i]) return false;
	}

	return true;
}
