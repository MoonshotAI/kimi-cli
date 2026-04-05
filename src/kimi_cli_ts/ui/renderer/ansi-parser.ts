/**
 * ANSI string → Screen buffer parser.
 *
 * Takes an ANSI-formatted string (as produced by Ink's renderer) and populates
 * a Screen buffer at the cell level. Handles:
 *
 * - SGR sequences (colors, bold, italic, etc.)
 * - Cursor movement within the string (newlines, carriage returns)
 * - Wide characters (CJK, emoji) via string-width detection
 * - Hyperlink OSC sequences (stripped, not stored)
 *
 * This is the bridge between Ink's string-based output and our cell-level
 * screen buffer, enabling cell-level diffing without forking Ink's internals.
 */

import { type Screen, CellWidth } from "./types.ts";
import { setCellAt, internChar, internStyle } from "./screen.ts";

// ── Character Width ─────────────────────────────────────

/**
 * Fast character width detection.
 * Returns 2 for wide chars (CJK, certain emoji), 1 for normal, 0 for zero-width.
 */
function charWidth(codePoint: number): number {
	// Zero-width characters
	if (codePoint === 0x200b || codePoint === 0xfeff) return 0;
	// Combining marks (general range)
	if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0;

	// East Asian Wide ranges (CJK Unified Ideographs, etc.)
	if (
		(codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
		(codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK Radicals, Kangxi
		(codePoint >= 0x3040 && codePoint <= 0x33bf) || // Hiragana, Katakana, CJK Compat
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Unified Ideographs Ext A
		(codePoint >= 0x4e00 && codePoint <= 0xa4cf) || // CJK Unified Ideographs
		(codePoint >= 0xa960 && codePoint <= 0xa97c) || // Hangul Jamo Extended-A
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul Syllables
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compat Ideographs
		(codePoint >= 0xfe10 && codePoint <= 0xfe6f) || // CJK Compat Forms, Small Form Variants
		(codePoint >= 0xff01 && codePoint <= 0xff60) || // Fullwidth Forms
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) || // Fullwidth Signs
		(codePoint >= 0x1f000 && codePoint <= 0x1fbff) || // Misc Symbols, Emoticons, etc.
		(codePoint >= 0x20000 && codePoint <= 0x2ffff) || // CJK Unified Ideographs Ext B-F
		(codePoint >= 0x30000 && codePoint <= 0x3ffff) // CJK Unified Ideographs Ext G+
	) {
		return 2;
	}

	// Regional indicators (flag emoji) — each indicator is width 1,
	// but a pair of them forms a flag emoji that is typically width 2.
	// For simplicity, treat individual indicators as width 1.
	// Full emoji width calculation would need grapheme cluster analysis.

	return 1;
}

// ── SGR Parser ──────────────────────────────────────────

/**
 * State machine for tracking accumulated SGR (Select Graphic Rendition) state.
 *
 * Instead of parsing SGR into semantic objects, we track the raw ANSI string
 * that represents the current style. This is simpler and sufficient for our
 * use case: we just need to know if two cells have the same style.
 */

// ── Main Parser ─────────────────────────────────────────

/**
 * Parse an ANSI-formatted string into a Screen buffer.
 *
 * @param ansi The full ANSI string output from Ink
 * @param screen Target screen buffer (must be created with sufficient dimensions)
 * @param width Terminal width for line wrapping
 */
export function parseAnsiToScreen(
	ansi: string,
	screen: Screen,
	width: number,
): void {
	let col = 0;
	let row = 0;
	// Accumulated SGR state as raw ANSI string. We track the last SGR
	// sequence(s) emitted so cells get the correct style ID.
	let currentStyle = "";
	let currentStyleId = 0; // Always starts as 0 (empty style)

	const len = ansi.length;
	let i = 0;

	while (i < len) {
		const ch = ansi.charCodeAt(i);

		// ── ESC sequence ──
		if (ch === 0x1b) {
			// CSI: ESC [
			if (i + 1 < len && ansi.charCodeAt(i + 1) === 0x5b) {
				// Parse CSI parameters
				let j = i + 2;
				const paramStart = j;
				// Collect digits, semicolons, and intermediate bytes (0x20-0x3f)
				while (j < len) {
					const b = ansi.charCodeAt(j);
					if (b >= 0x40 && b <= 0x7e) break; // Final byte
					j++;
				}

				if (j < len) {
					const finalByte = ansi.charCodeAt(j);
					const paramStr = ansi.slice(paramStart, j);

					if (finalByte === 0x6d) {
						// 'm' — SGR (Select Graphic Rendition)
						const sgrSeq = `\x1b[${paramStr}m`;
						if (paramStr === "" || paramStr === "0") {
							// Reset
							currentStyle = "";
							currentStyleId = 0;
						} else {
							// Accumulate style. For simplicity, we concatenate SGR sequences.
							// This produces a unique string per visual style combination.
							currentStyle = currentStyle + sgrSeq;
							currentStyleId = internStyle(screen, currentStyle);
						}
						i = j + 1;
						continue;
					}

					// Other CSI sequences (cursor movement, etc.) — skip
					// We don't need to handle cursor CSI here because Ink's renderer
					// output uses newlines for positioning, not CSI cursor moves.
					i = j + 1;
					continue;
				}
				// Incomplete CSI — skip ESC
				i++;
				continue;
			}

			// OSC: ESC ]
			if (i + 1 < len && ansi.charCodeAt(i + 1) === 0x5d) {
				// Skip until ST (ESC \ or BEL)
				let j = i + 2;
				while (j < len) {
					if (ansi.charCodeAt(j) === 0x07) {
						// BEL
						j++;
						break;
					}
					if (
						ansi.charCodeAt(j) === 0x1b &&
						j + 1 < len &&
						ansi.charCodeAt(j + 1) === 0x5c
					) {
						// ESC backslash (ST)
						j += 2;
						break;
					}
					j++;
				}
				i = j;
				continue;
			}

			// Other ESC sequences — skip 2 bytes
			i += 2;
			continue;
		}

		// ── Newline ──
		if (ch === 0x0a) {
			row++;
			col = 0;
			i++;
			continue;
		}

		// ── Carriage return ──
		if (ch === 0x0d) {
			col = 0;
			i++;
			continue;
		}

		// ── Tab ──
		if (ch === 0x09) {
			const nextTab = ((col >> 3) + 1) << 3; // Next 8-column tab stop
			while (col < nextTab && col < width) {
				setCellAt(
					screen,
					col,
					row,
					internChar(screen, " "),
					currentStyleId,
					CellWidth.Narrow,
				);
				col++;
			}
			i++;
			continue;
		}

		// ── Other control chars ──
		if (ch < 0x20) {
			i++;
			continue;
		}

		// ── Printable character ──
		// Extract the full character (handle surrogate pairs)
		let codePoint: number;
		let charLen: number;
		if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < len) {
			// Surrogate pair
			const lo = ansi.charCodeAt(i + 1);
			codePoint = (ch - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
			charLen = 2;
		} else {
			codePoint = ch;
			charLen = 1;
		}

		const char = ansi.slice(i, i + charLen);
		const w = charWidth(codePoint);

		if (w === 0) {
			// Zero-width character — skip (combining mark, ZWS, etc.)
			i += charLen;
			continue;
		}

		// Soft wrap: if we'd overflow, move to next line
		if (col >= width) {
			row++;
			col = 0;
		}

		// Wide char that would split across line boundary
		if (w === 2 && col + 1 >= width) {
			// Leave a space at end of line, wrap to next line
			setCellAt(
				screen,
				col,
				row,
				internChar(screen, " "),
				currentStyleId,
				CellWidth.Narrow,
			);
			row++;
			col = 0;
		}

		if (row >= screen.height) {
			// Beyond screen buffer — stop
			break;
		}

		// Write the character cell
		const charId = internChar(screen, char);
		if (w === 2) {
			setCellAt(screen, col, row, charId, currentStyleId, CellWidth.Wide);
			col++;
			// Write spacer tail for the second column
			setCellAt(
				screen,
				col,
				row,
				0, // space charId
				currentStyleId,
				CellWidth.SpacerTail,
			);
			col++;
		} else {
			setCellAt(screen, col, row, charId, currentStyleId, CellWidth.Narrow);
			col++;
		}

		i += charLen;
	}
}
