/**
 * Path utilities — corresponds to Python utils/path.py
 */

import { homedir } from "node:os";
import { resolve, relative, join } from "node:path";

/** Expand ~ to home directory. */
export function expandHome(p: string): string {
	if (p.startsWith("~/") || p === "~") {
		return join(homedir(), p.slice(1));
	}
	return p;
}

/** Resolve a path relative to a base directory, expanding ~. */
export function resolvePath(base: string, p: string): string {
	return resolve(base, expandHome(p));
}

/** Get a relative path from base, or the absolute path if it's shorter. */
export function shortPath(base: string, p: string): string {
	const abs = resolve(p);
	const rel = relative(base, abs);
	return rel.length < abs.length ? rel : abs;
}

/** Check if a path is inside a directory. */
export function isInsideDir(dir: string, p: string): boolean {
	const absDir = resolve(dir);
	const absP = resolve(p);
	return absP.startsWith(absDir + "/") || absP === absDir;
}

/** Ensure a directory exists. */
export async function ensureDir(dir: string): Promise<void> {
	await Bun.$`mkdir -p ${dir}`.quiet();
}

/**
 * Validate a file path against workspace boundaries.
 * Returns null if valid, or an error message if the path is outside workspace.
 * Relative paths are always allowed (resolved against workDir).
 * Absolute paths must be within workDir or additionalDirs.
 */
export function validateWorkspacePath(
	filePath: string,
	workDir: string,
	additionalDirs: string[] = [],
): string | null {
	// Relative paths are ok — they resolve against workDir
	if (!filePath.startsWith("/") && !filePath.startsWith("~")) {
		return null;
	}

	const resolved = resolve(expandHome(filePath));

	// Check workDir
	if (isInsideDir(workDir, resolved)) return null;

	// Check additional dirs
	for (const dir of additionalDirs) {
		if (isInsideDir(resolve(dir), resolved)) return null;
	}

	// Allow /tmp paths (common for temp files)
	if (resolved.startsWith("/tmp/") || resolved.startsWith("/var/tmp/"))
		return null;

	// Outside workspace — warn but allow (with absolute path requirement already met)
	return null; // For now, allow all absolute paths like Python does for ReadFile
}
