/**
 * Tool utilities — shared helpers for tool implementations.
 * Corresponds to Python tools/utils.py (partial).
 */

/**
 * Load a tool description from a file and perform simple `${VAR}` substitution.
 *
 * Variables in the template use `${VARIABLE_NAME}` syntax. Any variable not
 * present in the context map is left as-is (mirrors Python's
 * _KeepPlaceholderUndefined behaviour).
 */
export function loadDesc(
	path: string,
	context?: Record<string, string>,
): string {
	const file = Bun.file(path);
	// Bun.file().text() is async; use the sync node:fs fallback for simplicity
	// since this is only called at init time.
	const fs = require("node:fs") as typeof import("node:fs");
	let text = fs.readFileSync(path, "utf-8");

	if (context) {
		for (const [key, value] of Object.entries(context)) {
			text = text.replaceAll(`\${${key}}`, value);
		}
	}

	return text;
}
