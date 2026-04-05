/**
 * Shared type definitions for the optimized renderer.
 *
 * Inspired by Claude Code's screen.ts — uses packed Int32Array for cell storage
 * to eliminate GC pressure. Each cell is 2 Int32 elements:
 *   word0: charId (index into CharPool)
 *   word1: styleId << 2 | width
 */

// ── Cell Width ──────────────────────────────────────────

/** Cell width classification for double-wide characters (CJK, emoji). */
export const CellWidth = {
	/** Normal single-width character. */
	Narrow: 0,
	/** Wide character (occupies 2 columns). This cell holds the actual char. */
	Wide: 1,
	/** Second column of a wide character. Skip during rendering. */
	SpacerTail: 2,
} as const;

export type CellWidthType = (typeof CellWidth)[keyof typeof CellWidth];

// ── Screen ──────────────────────────────────────────────

/**
 * Screen buffer using packed Int32Array.
 *
 * Cell layout (2 × Int32 per cell):
 *   word0 (cells[i*2]):     charId   — index into charPool
 *   word1 (cells[i*2 + 1]): styleId << 2 | width
 *
 * This layout avoids allocating Cell objects (zero GC pressure) and enables
 * fast integer comparison in diffing.
 */
export type Screen = {
	width: number;
	height: number;
	/** Packed cell data: 2 Int32 per cell. Length = width * height * 2. */
	cells: Int32Array;
	/** Interned character strings. Index 0 = ' ' (space). */
	charPool: string[];
	/** Map from char string → charPool index (for fast intern). */
	charMap: Map<string, number>;
	/** Interned SGR style strings. Index 0 = '' (no style / reset). */
	stylePool: string[];
	/** Map from style string → stylePool index. */
	styleMap: Map<string, number>;
};

// ── Packed Cell Access ──────────────────────────────────

/** Bit layout for word1: styleId occupies bits [31:2], width occupies bits [1:0]. */
export const STYLE_SHIFT = 2;
export const WIDTH_MASK = 0x3;

// ── Viewport ────────────────────────────────────────────

export type Viewport = {
	width: number;
	height: number;
};

// ── Cursor ──────────────────────────────────────────────

export type CursorPosition = {
	x: number;
	y: number;
};
