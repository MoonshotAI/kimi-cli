/**
 * Web store sessions — corresponds to Python web/store/sessions.py
 * Session listing, caching, pagination, auto-archive.
 */

import { join, resolve } from "node:path";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { getShareDir } from "../../config.ts";
import {
	loadMetadata,
	getSessionsDir,
	type Metadata,
	type WorkDirMeta,
} from "../../metadata.ts";
import {
	loadSessionState,
	saveSessionState,
	type SessionState,
} from "../../session_state.ts";
import type { WebSession } from "../models.ts";
import { logger } from "../../utils/logging.ts";

// ── Constants ────────────────────────────────────────────

const CACHE_TTL = 5.0; // seconds
const AUTO_ARCHIVE_DAYS = 15;
const AUTO_ARCHIVE_INTERVAL = 300; // seconds

// ── Cache state (module-level) ───────────────────────────

let _sessionsCache: WebSession[] | null = null;
let _cacheTimestamp = 0;

let _sessionsIndexCache: SessionIndexEntry[] | null = null;
let _indexCacheTimestamp = 0;

let _lastAutoArchiveTime = 0;

export function invalidateSessionsCache(): void {
	_sessionsCache = null;
	_cacheTimestamp = 0;
	_sessionsIndexCache = null;
	_indexCacheTimestamp = 0;
}

// ── Index entry ──────────────────────────────────────────

export interface SessionIndexEntry {
	sessionId: string;
	sessionDir: string;
	contextFile: string;
	workDir: string;
	workDirMeta: WorkDirMeta;
	lastUpdated: number; // epoch seconds
	title: string;
	state: SessionState;
}

// ── Title derivation ─────────────────────────────────────

function deriveTitleFromWire(sessionDir: string): string | null {
	const wireFile = join(sessionDir, "wire.jsonl");
	if (!existsSync(wireFile)) return null;

	try {
		const text = readFileSync(wireFile, "utf-8");
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const record = JSON.parse(trimmed);
				if (record.type === "turn_begin" && record.user_input) {
					const raw =
						typeof record.user_input === "string"
							? record.user_input
							: JSON.stringify(record.user_input);
					return raw.slice(0, 50);
				}
			} catch {
				continue;
			}
		}
	} catch {
		// ignore
	}
	return null;
}

function ensureTitle(entry: SessionIndexEntry): void {
	if (entry.state.custom_title) {
		entry.title = entry.state.custom_title;
		return;
	}
	const wireTitle = deriveTitleFromWire(entry.sessionDir);
	if (wireTitle) {
		entry.title = wireTitle;
	}
}

// ── Session dir iteration ────────────────────────────────

function iterSessionDirs(workDirMeta: WorkDirMeta): SessionIndexEntry[] {
	const sessionsDir = getSessionsDir(workDirMeta);
	if (!existsSync(sessionsDir)) return [];

	const entries: SessionIndexEntry[] = [];
	let dirEntries: string[];
	try {
		dirEntries = readdirSync(sessionsDir);
	} catch {
		return [];
	}

	for (const name of dirEntries) {
		const sessionDir = join(sessionsDir, name);
		const contextFile = join(sessionDir, "context.jsonl");

		// Check if it's a valid session directory
		if (!existsSync(contextFile)) continue;

		let lastUpdated = 0;
		try {
			const stat = statSync(contextFile);
			lastUpdated = stat.mtimeMs / 1000;
		} catch {
			// ignore
		}

		// Load state synchronously for index building (best-effort)
		let state: SessionState;
		try {
			const stateFile = join(sessionDir, "state.json");
			if (existsSync(stateFile)) {
				const data = JSON.parse(
					require("node:fs").readFileSync(stateFile, "utf-8"),
				);
				// Minimal parse — just grab what we need
				state = {
					version: data.version ?? 1,
					approval: data.approval ?? { yolo: false, auto_approve_actions: [] },
					additional_dirs: data.additional_dirs ?? [],
					custom_title: data.custom_title ?? null,
					title_generated: data.title_generated ?? false,
					title_generate_attempts: data.title_generate_attempts ?? 0,
					plan_mode: data.plan_mode ?? false,
					plan_session_id: data.plan_session_id ?? null,
					plan_slug: data.plan_slug ?? null,
					wire_mtime: data.wire_mtime ?? null,
					archived: data.archived ?? false,
					archived_at: data.archived_at ?? null,
					auto_archive_exempt: data.auto_archive_exempt ?? false,
					todos: data.todos ?? [],
				};
			} else {
				state = {
					version: 1,
					approval: { yolo: false, auto_approve_actions: [] },
					additional_dirs: [],
					custom_title: null,
					title_generated: false,
					title_generate_attempts: 0,
					plan_mode: false,
					plan_session_id: null,
					plan_slug: null,
					wire_mtime: null,
					archived: false,
					archived_at: null,
					auto_archive_exempt: false,
					todos: [],
				};
			}
		} catch {
			state = {
				version: 1,
				approval: { yolo: false, auto_approve_actions: [] },
				additional_dirs: [],
				custom_title: null,
				title_generated: false,
				title_generate_attempts: 0,
				plan_mode: false,
				plan_session_id: null,
				plan_slug: null,
				wire_mtime: null,
				archived: false,
				archived_at: null,
				auto_archive_exempt: false,
				todos: [],
			};
		}

		const entry: SessionIndexEntry = {
			sessionId: name,
			sessionDir,
			contextFile,
			workDir: workDirMeta.path,
			workDirMeta,
			lastUpdated,
			title: "Untitled",
			state,
		};

		ensureTitle(entry);
		entries.push(entry);
	}

	return entries;
}

// ── Auto-archive ─────────────────────────────────────────

function shouldAutoArchive(lastUpdated: number, state: SessionState): boolean {
	if (state.archived) return false;
	if (state.auto_archive_exempt) return false;
	const ageDays = (Date.now() / 1000 - lastUpdated) / 86400;
	return ageDays >= AUTO_ARCHIVE_DAYS;
}

export async function runAutoArchive(): Promise<void> {
	const now = Date.now() / 1000;
	if (now - _lastAutoArchiveTime < AUTO_ARCHIVE_INTERVAL) return;
	_lastAutoArchiveTime = now;

	const index = buildSessionsIndex();
	for (const entry of index) {
		if (shouldAutoArchive(entry.lastUpdated, entry.state)) {
			entry.state.archived = true;
			entry.state.archived_at = now;
			try {
				await saveSessionState(entry.state, entry.sessionDir);
			} catch (err) {
				logger.warn(
					`Failed to auto-archive session ${entry.sessionId}: ${err}`,
				);
			}
		}
	}

	invalidateSessionsCache();
}

// ── Index building ───────────────────────────────────────

function buildSessionsIndex(): SessionIndexEntry[] {
	const now = Date.now() / 1000;
	if (_sessionsIndexCache && now - _indexCacheTimestamp < CACHE_TTL) {
		return _sessionsIndexCache;
	}

	let metadata: Metadata;
	try {
		// Use sync metadata loading for index building
		const metadataFile = join(getShareDir(), "kimi.json");
		if (!existsSync(metadataFile)) {
			metadata = { workDirs: [] };
		} else {
			const data = JSON.parse(
				require("node:fs").readFileSync(metadataFile, "utf-8"),
			);
			const workDirs = (data.work_dirs ?? data.workDirs ?? []).map(
				(wd: any) => ({
					path: wd.path ?? "",
					kaos: wd.kaos ?? "local",
					lastSessionId: wd.last_session_id ?? wd.lastSessionId ?? null,
				}),
			);
			metadata = { workDirs };
		}
	} catch {
		metadata = { workDirs: [] };
	}

	const allEntries: SessionIndexEntry[] = [];
	for (const wdMeta of metadata.workDirs) {
		const entries = iterSessionDirs(wdMeta);
		allEntries.push(...entries);
	}

	// Sort by last_updated descending
	allEntries.sort((a, b) => b.lastUpdated - a.lastUpdated);

	_sessionsIndexCache = allEntries;
	_indexCacheTimestamp = now;
	return allEntries;
}

// ── Public API ───────────────────────────────────────────

function entryToWebSession(
	entry: SessionIndexEntry,
	isRunning = false,
): WebSession {
	return {
		session_id: entry.sessionId,
		title: entry.title,
		last_updated: new Date(entry.lastUpdated * 1000).toISOString(),
		is_running: isRunning,
		status: null,
		work_dir: entry.workDir,
		session_dir: entry.sessionDir,
		archived: entry.state.archived,
	};
}

export function loadAllSessions(): WebSession[] {
	const index = buildSessionsIndex();
	return index.map((e) => entryToWebSession(e));
}

export function loadAllSessionsCached(): WebSession[] {
	const now = Date.now() / 1000;
	if (_sessionsCache && now - _cacheTimestamp < CACHE_TTL) {
		return _sessionsCache;
	}
	const sessions = loadAllSessions();
	_sessionsCache = sessions;
	_cacheTimestamp = now;
	return sessions;
}

export interface LoadSessionsPageResult {
	items: WebSession[];
	total: number;
	limit: number;
	offset: number;
}

export function loadSessionsPage(
	limit = 50,
	offset = 0,
	query?: string,
	archived?: boolean,
): LoadSessionsPageResult {
	let index = buildSessionsIndex();

	// Filter by archived status
	if (archived !== undefined) {
		index = index.filter((e) => e.state.archived === archived);
	}

	// Filter by query
	if (query) {
		const lowerQuery = query.toLowerCase();
		index = index.filter(
			(e) =>
				e.title.toLowerCase().includes(lowerQuery) ||
				e.workDir.toLowerCase().includes(lowerQuery) ||
				e.sessionId.toLowerCase().includes(lowerQuery),
		);
	}

	const total = index.length;
	const page = index.slice(offset, offset + limit);

	return {
		items: page.map((e) => entryToWebSession(e)),
		total,
		limit,
		offset,
	};
}

export function loadSessionById(sessionId: string): WebSession | null {
	const index = buildSessionsIndex();
	const entry = index.find((e) => e.sessionId === sessionId);
	if (!entry) return null;
	return entryToWebSession(entry);
}

export function getSessionIndexEntry(
	sessionId: string,
): SessionIndexEntry | null {
	const index = buildSessionsIndex();
	return index.find((e) => e.sessionId === sessionId) ?? null;
}

// ── Work dirs listing ────────────────────────────────────

let _workDirsCache: string[] | null = null;
let _workDirsCacheTimestamp = 0;
const WORK_DIRS_CACHE_TTL = 30;

export function listWorkDirs(): string[] {
	const now = Date.now() / 1000;
	if (_workDirsCache && now - _workDirsCacheTimestamp < WORK_DIRS_CACHE_TTL) {
		return _workDirsCache;
	}

	let metadata: Metadata;
	try {
		const metadataFile = join(getShareDir(), "kimi.json");
		if (!existsSync(metadataFile)) {
			metadata = { workDirs: [] };
		} else {
			const data = JSON.parse(
				require("node:fs").readFileSync(metadataFile, "utf-8"),
			);
			const workDirs = (data.work_dirs ?? data.workDirs ?? []).map(
				(wd: any) => ({
					path: wd.path ?? "",
					kaos: wd.kaos ?? "local",
					lastSessionId: wd.last_session_id ?? wd.lastSessionId ?? null,
				}),
			);
			metadata = { workDirs };
		}
	} catch {
		metadata = { workDirs: [] };
	}

	const dirs = metadata.workDirs
		.map((wd) => wd.path)
		.filter((p) => existsSync(p));

	_workDirsCache = dirs;
	_workDirsCacheTimestamp = now;
	return dirs;
}
