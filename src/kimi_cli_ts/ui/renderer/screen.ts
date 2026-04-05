/**
 * Screen buffer with packed Int32Array cell storage.
 *
 * Inspired by Claude Code's screen.ts — eliminates GC pressure by storing
 * cell data as packed integers instead of objects. Each cell uses 2 Int32:
 *   word0: charId (index into charPool)
 *   word1: (styleId << 2) | width
 *
 * CharPool and StylePool intern strings so diffing reduces to integer comparison.
 */

import {
	type Screen,
	type CellWidthType,
	CellWidth,
	STYLE_SHIFT,
	WIDTH_MASK,
} from "./types.ts";

// ── CharPool Defaults ───────────────────────────────────

const DEFAULT_CHAR = " ";
const DEFAULT_CHAR_ID = 0;

// ── Screen Factory ──────────────────────────────────────

/** Create a new screen buffer. All cells are initialized to empty (space, no style). */
export function createScreen(width: number, height: number): Screen {
	const size = width * height;
	return {
		width,
		height,
		// Zero-filled ArrayBuffer: word0=0 (space charId), word1=0 (styleId=0, width=Narrow)
		cells: new Int32Array(size * 2),
		charPool: [DEFAULT_CHAR], // index 0 = space
		charMap: new Map([[DEFAULT_CHAR, DEFAULT_CHAR_ID]]),
		stylePool: [""], // index 0 = no style (reset)
		styleMap: new Map([["", 0]]),
	};
}

/**
 * Reset an existing screen for reuse. Reallocates cells if dimensions changed,
 * otherwise zero-fills. Preserves pools across frames for stable IDs.
 */
export function resetScreen(
	screen: Screen,
	width: number,
	height: number,
): void {
	const size = width * height;
	const needed = size * 2;

	screen.width = width;
	screen.height = height;

	if (screen.cells.length !== needed) {
		screen.cells = new Int32Array(needed);
	} else {
		screen.cells.fill(0);
	}
}

// ── String Interning ────────────────────────────────────

/** Intern a character string and return its pool ID. */
export function internChar(screen: Screen, char: string): number {
	let id = screen.charMap.get(char);
	if (id !== undefined) return id;

	id = screen.charPool.length;
	screen.charPool.push(char);
	screen.charMap.set(char, id);
	return id;
}

/** Intern a SGR style string and return its pool ID. */
export function internStyle(screen: Screen, style: string): number {
	let id = screen.styleMap.get(style);
	if (id !== undefined) return id;

	id = screen.stylePool.length;
	screen.stylePool.push(style);
	screen.styleMap.set(style, id);
	return id;
}

// ── Cell Access ─────────────────────────────────────────

/** Pack styleId and width into word1. */
export function packWord1(styleId: number, width: CellWidthType): number {
	return (styleId << STYLE_SHIFT) | width;
}

/** Write a cell at (x, y). Bounds-checked; out-of-bounds writes are silently dropped. */
export function setCellAt(
	screen: Screen,
	x: number,
	y: number,
	charId: number,
	styleId: number,
	width: CellWidthType,
): void {
	if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return;

	const ci = (y * screen.width + x) * 2;
	screen.cells[ci] = charId;
	screen.cells[ci + 1] = packWord1(styleId, width);
}

/** Read a cell at (x, y). Returns charId, styleId, width. */
export function cellAt(
	screen: Screen,
	x: number,
	y: number,
): { charId: number; styleId: number; width: CellWidthType } {
	if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
		return { charId: DEFAULT_CHAR_ID, styleId: 0, width: CellWidth.Narrow };
	}

	const ci = (y * screen.width + x) * 2;
	const w0 = screen.cells[ci]!;
	const w1 = screen.cells[ci + 1]!;
	return {
		charId: w0,
		styleId: w1 >>> STYLE_SHIFT,
		width: (w1 & WIDTH_MASK) as CellWidthType,
	};
}

/** Check if a cell is empty (space, no style, narrow). */
export function isEmptyCell(screen: Screen, x: number, y: number): boolean {
	if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return true;
	const ci = (y * screen.width + x) * 2;
	return screen.cells[ci] === 0 && screen.cells[ci + 1] === 0;
}

/** Resolve a charId to its string. */
export function getChar(screen: Screen, charId: number): string {
	return screen.charPool[charId] ?? DEFAULT_CHAR;
}

/** Resolve a styleId to its SGR string. */
export function getStyle(screen: Screen, styleId: number): string {
	return screen.stylePool[styleId] ?? "";
}

// ── Diff Helper ─────────────────────────────────────────

/**
 * Iterate over cells that differ between prev and next screen.
 *
 * Callback receives (x, y) coordinates of each changed cell.
 * Both screens must have the same dimensions for meaningful comparison;
 * if dimensions differ, all cells in the overlapping region are compared
 * and cells outside the overlap are treated as "added" or "removed".
 *
 * Comparison is pure integer: two Int32 per cell, skip if both match.
 */
export function diffCells(
	prev: Screen,
	next: Screen,
	cb: (x: number, y: number) => boolean | void,
): void {
	const pw = prev.width;
	const nw = next.width;
	const ph = prev.height;
	const nh = next.height;
	const maxH = Math.max(ph, nh);
	const maxW = Math.max(pw, nw);
	const minH = Math.min(ph, nh);
	const minW = Math.min(pw, nw);

	const pc = prev.cells;
	const nc = next.cells;

	// Compare overlapping region
	for (let y = 0; y < minH; y++) {
		const pRowBase = y * pw * 2;
		const nRowBase = y * nw * 2;

		for (let x = 0; x < minW; x++) {
			const pi = pRowBase + x * 2;
			const ni = nRowBase + x * 2;
			// Fast: compare both int32 words
			if (pc[pi] !== nc[ni] || pc[pi + 1] !== nc[ni + 1]) {
				if (cb(x, y) === true) return;
			}
		}

		// Cells in next that extend beyond prev width (added)
		for (let x = minW; x < nw; x++) {
			const ni = nRowBase + x * 2;
			// Only emit if non-empty
			if (nc[ni] !== 0 || nc[ni + 1] !== 0) {
				if (cb(x, y) === true) return;
			}
		}

		// Cells in prev that extend beyond next width (removed)
		for (let x = minW; x < pw; x++) {
			const pi = pRowBase + x * 2;
			if (pc[pi] !== 0 || pc[pi + 1] !== 0) {
				if (cb(x, y) === true) return;
			}
		}
	}

	// Rows only in next (added)
	for (let y = minH; y < nh; y++) {
		const nRowBase = y * nw * 2;
		for (let x = 0; x < nw; x++) {
			const ni = nRowBase + x * 2;
			if (nc[ni] !== 0 || nc[ni + 1] !== 0) {
				if (cb(x, y) === true) return;
			}
		}
	}

	// Rows only in prev (removed) — these cells need to be cleared
	for (let y = minH; y < ph; y++) {
		const pRowBase = y * pw * 2;
		for (let x = 0; x < pw; x++) {
			const pi = pRowBase + x * 2;
			if (pc[pi] !== 0 || pc[pi + 1] !== 0) {
				if (cb(x, y) === true) return;
			}
		}
	}
}

/**
 * Copy pools from source screen to target screen.
 * Used so that charId/styleId from source are valid in target.
 */
export function copyPools(from: Screen, to: Screen): void {
	to.charPool = from.charPool;
	to.charMap = from.charMap;
	to.stylePool = from.stylePool;
	to.styleMap = from.styleMap;
}
