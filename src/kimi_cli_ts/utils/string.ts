/**
 * String utilities — corresponds to Python utils/string.py
 */

const NEWLINE_RE = /[\r\n]+/g;

/**
 * Shorten text to at most `width` characters.
 *
 * Normalises whitespace, then truncates — preferring a word boundary
 * when one exists near the cut point, but falling back to a hard cut
 * so that CJK text without spaces won't collapse to just the placeholder.
 */
export function shorten(
	text: string,
	options: { width: number; placeholder?: string },
): string {
	const { width, placeholder = "…" } = options;
	const normalized = text.split(/\s+/).filter(Boolean).join(" ");
	if (normalized.length <= width) return normalized;
	const cut = width - placeholder.length;
	if (cut <= 0) return normalized.slice(0, width);
	const space = normalized.lastIndexOf(" ", cut);
	const actualCut = space > 0 ? space : cut;
	return normalized.slice(0, actualCut).trimEnd() + placeholder;
}

/**
 * Shorten text by inserting ellipsis in the middle.
 */
export function shortenMiddle(
	text: string,
	width: number,
	removeNewline = true,
): string {
	if (text.length <= width) return text;
	let t = text;
	if (removeNewline) {
		t = t.replace(NEWLINE_RE, " ");
	}
	const half = Math.floor(width / 2);
	return t.slice(0, half) + "..." + t.slice(-half);
}

/**
 * Generate a random lowercase string of fixed length.
 */
export function randomString(length = 8): string {
	const letters = "abcdefghijklmnopqrstuvwxyz";
	let result = "";
	for (let i = 0; i < length; i++) {
		result += letters[Math.floor(Math.random() * letters.length)];
	}
	return result;
}
