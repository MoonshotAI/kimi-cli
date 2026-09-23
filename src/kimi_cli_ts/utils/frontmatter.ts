/**
 * YAML frontmatter parsing — corresponds to Python utils/frontmatter.py
 */

import * as yaml from "./yaml.ts";

/**
 * Parse YAML frontmatter from a text blob.
 * Returns null if no frontmatter found.
 * Throws if the frontmatter YAML is invalid.
 */
export function parseFrontmatter(text: string): Record<string, unknown> | null {
	const lines = text.split("\n");
	if (lines.length === 0 || lines[0]!.trim() !== "---") {
		return null;
	}

	const frontmatterLines: string[] = [];
	let foundEnd = false;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]!.trim() === "---") {
			foundEnd = true;
			break;
		}
		frontmatterLines.push(lines[i]!);
	}

	if (!foundEnd) return null;

	const frontmatter = frontmatterLines.join("\n").trim();
	if (!frontmatter) return null;

	try {
		const rawData = yaml.parse(frontmatter);
		if (
			typeof rawData !== "object" ||
			rawData === null ||
			Array.isArray(rawData)
		) {
			throw new Error("Frontmatter YAML must be a mapping.");
		}
		return rawData as Record<string, unknown>;
	} catch (err) {
		throw new Error(`Invalid frontmatter YAML: ${err}`);
	}
}

/**
 * Read the YAML frontmatter at the start of a file.
 */
export async function readFrontmatter(
	path: string,
): Promise<Record<string, unknown> | null> {
	const text = await Bun.file(path).text();
	return parseFrontmatter(text);
}
