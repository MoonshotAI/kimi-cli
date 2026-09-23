/**
 * Share directory — corresponds to Python share.py
 * Returns the path to the global Kimi share directory (~/.kimi/).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Get the share directory path.
 * Creates the directory if it doesn't exist (matches Python behavior).
 */
export function getShareDir(): string {
	const dir = process.env.KIMI_SHARE_DIR ?? join(homedir(), ".kimi");
	mkdirSync(dir, { recursive: true });
	return dir;
}
