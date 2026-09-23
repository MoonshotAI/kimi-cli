/**
 * Metadata module — corresponds to Python metadata.py
 * Tracks work directories and their sessions using MD5 hashes for directory names.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { getShareDir } from "./config.ts";
import { logger } from "./utils/logging.ts";

// ── Metadata file ────────────────────────────────────────

export function getMetadataFile(): string {
	return join(getShareDir(), "kimi.json");
}

// ── WorkDirMeta ──────────────────────────────────────────

export interface WorkDirMeta {
	/** The full path of the work directory. */
	path: string;
	/** The name of the KAOS where the work directory is located. */
	kaos: string;
	/** Last session ID of this work directory. */
	lastSessionId: string | null;
}

/** Compute the sessions directory for a work directory using MD5 hash (compatible with Python). */
export function getSessionsDir(workDirMeta: WorkDirMeta): string {
	const pathMd5 = createHash("md5")
		.update(workDirMeta.path, "utf-8")
		.digest("hex");
	// For local kaos, just use the MD5 hash; otherwise prefix with kaos name
	const localKaos = "local";
	const dirBasename =
		workDirMeta.kaos === localKaos ? pathMd5 : `${workDirMeta.kaos}_${pathMd5}`;
	return join(getShareDir(), "sessions", dirBasename);
}

// ── Metadata ─────────────────────────────────────────────

export interface Metadata {
	workDirs: WorkDirMeta[];
}

/** Get the metadata for a work directory. */
export function getWorkDirMeta(
	metadata: Metadata,
	path: string,
	kaos = "local",
): WorkDirMeta | null {
	for (const wd of metadata.workDirs) {
		if (wd.path === path && wd.kaos === kaos) {
			return wd;
		}
	}
	return null;
}

/** Create a new work directory metadata entry. */
export function newWorkDirMeta(
	metadata: Metadata,
	path: string,
	kaos = "local",
): WorkDirMeta {
	const wdMeta: WorkDirMeta = {
		path,
		kaos,
		lastSessionId: null,
	};
	metadata.workDirs.push(wdMeta);
	return wdMeta;
}

// ── Load / Save ──────────────────────────────────────────

export async function loadMetadata(): Promise<Metadata> {
	const metadataFile = getMetadataFile();
	logger.debug(`Loading metadata from file: ${metadataFile}`);
	const file = Bun.file(metadataFile);
	if (!(await file.exists())) {
		logger.debug("No metadata file found, creating empty metadata");
		return { workDirs: [] };
	}
	try {
		const data = await file.json();
		// Map Python-style snake_case to camelCase
		const workDirs: WorkDirMeta[] = (data.work_dirs ?? data.workDirs ?? []).map(
			(wd: any) => ({
				path: wd.path ?? "",
				kaos: wd.kaos ?? "local",
				lastSessionId: wd.last_session_id ?? wd.lastSessionId ?? null,
			}),
		);
		return { workDirs };
	} catch (err) {
		logger.warn(`Failed to load metadata: ${err}`);
		return { workDirs: [] };
	}
}

export async function saveMetadata(metadata: Metadata): Promise<void> {
	const metadataFile = getMetadataFile();
	logger.debug(`Saving metadata to file: ${metadataFile}`);
	const dir = metadataFile.substring(0, metadataFile.lastIndexOf("/"));
	await Bun.$`mkdir -p ${dir}`.quiet();
	// Save in Python-compatible snake_case format
	const data = {
		work_dirs: metadata.workDirs.map((wd) => ({
			path: wd.path,
			kaos: wd.kaos,
			last_session_id: wd.lastSessionId,
		})),
	};
	await Bun.write(metadataFile, JSON.stringify(data, null, 2));
}
