/**
 * Media file type detection and tag wrapping — corresponds to Python utils/media_tags.py
 */

import type { ContentPart } from "../types.ts";

interface TextPartLiteral {
	type: "text";
	text: string;
}

function formatTag(
	tag: string,
	attrs?: Record<string, string | null | undefined>,
): string {
	if (!attrs) return `<${tag}>`;
	const rendered: string[] = [];
	for (const key of Object.keys(attrs).sort()) {
		const value = attrs[key];
		if (!value) continue;
		const escaped = value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
		rendered.push(`${key}="${escaped}"`);
	}
	if (rendered.length === 0) return `<${tag}>`;
	return `<${tag} ${rendered.join(" ")}>`;
}

/**
 * Wrap a content part in XML-like tags.
 */
export function wrapMediaPart(
	part: ContentPart,
	options: { tag: string; attrs?: Record<string, string | null | undefined> },
): ContentPart[] {
	const openTag: TextPartLiteral = {
		type: "text",
		text: formatTag(options.tag, options.attrs),
	};
	const closeTag: TextPartLiteral = { type: "text", text: `</${options.tag}>` };
	return [openTag, part, closeTag];
}
