/**
 * I/O utilities — corresponds to Python utils/io.py
 * Atomic file write operations.
 */

import { dirname, join } from "node:path";
import { renameSync, unlinkSync } from "node:fs";

/**
 * Write JSON data to a file atomically using tmp-file + rename.
 *
 * This prevents data corruption if the process crashes mid-write: either the
 * old file is kept intact or the new file is fully committed.
 */
export async function atomicJsonWrite(
	data: unknown,
	path: string,
): Promise<void> {
	const dir = dirname(path);
	const tmpPath = join(
		dir,
		`.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	try {
		const content = JSON.stringify(data, null, 2);
		await Bun.write(tmpPath, content);
		renameSync(tmpPath, path);
	} catch (err) {
		try {
			unlinkSync(tmpPath);
		} catch {
			// Ignore cleanup errors
		}
		throw err;
	}
}
