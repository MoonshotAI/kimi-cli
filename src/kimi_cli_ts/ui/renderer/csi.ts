/**
 * CSI (Control Sequence Introducer) escape sequence builders.
 *
 * Provides minimal ANSI/DEC sequence helpers for cursor movement,
 * line erasure, and cursor visibility. Ported from Claude Code's termio/csi.ts.
 */

const ESC = "\x1b";
const CSI = `${ESC}[`;

// ── Cursor Movement ─────────────────────────────────────

/**
 * Relative cursor move by (dx, dy).
 * Emits CUU/CUD for vertical, CUF/CUB for horizontal.
 * Returns empty string if no movement needed.
 */
export function cursorMove(dx: number, dy: number): string {
	let seq = "";
	if (dy < 0)
		seq += `${CSI}${-dy}A`; // CUU — cursor up
	else if (dy > 0) seq += `${CSI}${dy}B`; // CUD — cursor down
	if (dx > 0)
		seq += `${CSI}${dx}C`; // CUF — cursor forward
	else if (dx < 0) seq += `${CSI}${-dx}D`; // CUB — cursor back
	return seq;
}

/** Move cursor to column `col` (0-indexed). Uses CHA (CSI n G), 1-indexed. */
export function cursorTo(col: number): string {
	return `${CSI}${col + 1}G`;
}

/** Absolute cursor position (1-indexed row, col). CUP: CSI row;col H. */
export function cursorPosition(row: number, col: number): string {
	return `${CSI}${row};${col}H`;
}

// ── Erase ───────────────────────────────────────────────

/** Erase from cursor to end of line. CSI 0 K. */
export const ERASE_END_LINE = `${CSI}0K`;

/** Erase entire line. CSI 2 K. */
export const ERASE_LINE = `${CSI}2K`;

/** Erase entire screen. CSI 2 J. */
export const ERASE_SCREEN = `${CSI}2J`;

/**
 * Erase `count` lines: erase current line, then (move up + erase) × (count-1),
 * then move cursor to column 0. Matches ansi-escapes.eraseLines() exactly.
 */
export function eraseLines(count: number): string {
	if (count <= 0) return "";
	let seq = ERASE_LINE; // Erase current line
	for (let i = 1; i < count; i++) {
		seq += `${CSI}1A${ERASE_LINE}`; // Move up 1 + erase line
	}
	seq += `${CSI}G`; // CHA — move to column 1 (leftmost)
	return seq;
}

// ── Cursor Visibility ───────────────────────────────────

/** DECTCEM: hide cursor. */
export const HIDE_CURSOR = `${CSI}?25l`;

/** DECTCEM: show cursor. */
export const SHOW_CURSOR = `${CSI}?25h`;

// ── Home ────────────────────────────────────────────────

/** Move cursor to (1,1). CSI H. */
export const CURSOR_HOME = `${CSI}H`;

// ── SGR (Select Graphic Rendition) ──────────────────────

/** Reset all SGR attributes. */
export const SGR_RESET = `${CSI}0m`;

// ── Carriage Return / Newline ───────────────────────────

export const CR = "\r";
export const LF = "\n";
