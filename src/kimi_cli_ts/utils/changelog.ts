/**
 * Changelog data — corresponds to Python utils/changelog.py
 */

export interface ChangelogEntry {
	description: string;
	entries: string[];
}

export const CHANGELOG: Record<string, ChangelogEntry> = {
	"2.0.0": {
		description: "TypeScript rewrite",
		entries: [
			"Complete rewrite in TypeScript with Bun runtime",
			"New Ink-based terminal UI",
			"Improved performance and startup time",
		],
	},
};
