/**
 * Session state — corresponds to Python session_state.py
 * Defines the per-session state schema and persistence.
 */

import { z } from "zod/v4";
import { join } from "node:path";
import { logger } from "./utils/logging.ts";

export const STATE_FILE_NAME = "state.json";

// ── Schemas ────────────────────────────────────────────

export const ApprovalStateData = z.object({
	yolo: z.boolean().default(false),
	auto_approve_actions: z.array(z.string()).default([]),
});
export type ApprovalStateData = z.infer<typeof ApprovalStateData>;

export const TodoItemState = z.object({
	title: z.string(),
	status: z.enum(["pending", "in_progress", "done"]),
});
export type TodoItemState = z.infer<typeof TodoItemState>;

export const SessionState = z.object({
	version: z.number().int().default(1),
	approval: ApprovalStateData.default({} as any),
	additional_dirs: z.array(z.string()).default([]),
	custom_title: z.string().nullable().default(null),
	title_generated: z.boolean().default(false),
	title_generate_attempts: z.number().int().default(0),
	plan_mode: z.boolean().default(false),
	plan_session_id: z.string().nullable().default(null),
	plan_slug: z.string().nullable().default(null),
	// Archive state (previously in metadata.json)
	wire_mtime: z.number().nullable().default(null),
	archived: z.boolean().default(false),
	archived_at: z.number().nullable().default(null),
	auto_archive_exempt: z.boolean().default(false),
	// Todo list state
	todos: z.array(TodoItemState).default([]),
});
export type SessionState = z.infer<typeof SessionState>;

// ── Legacy metadata migration ──────────────────────────

const LEGACY_METADATA_FILENAME = "metadata.json";

type MigrationResult = "migrated" | "no_change" | "skip";

/**
 * Migrate fields from legacy metadata.json into SessionState.
 * Returns "migrated" if fields were merged, "no_change" if parsed but nothing needed,
 * "skip" if the file is missing or unreadable.
 */
async function migrateLegacyMetadata(
	sessionDir: string,
	state: SessionState,
): Promise<MigrationResult> {
	const metadataFile = join(sessionDir, LEGACY_METADATA_FILENAME);
	const file = Bun.file(metadataFile);
	if (!(await file.exists())) return "skip";

	let data: Record<string, unknown>;
	try {
		data = await file.json();
	} catch {
		return "skip";
	}

	let changed = false;

	// Migrate title fields (only if state has defaults)
	if (state.custom_title === null && data.title && data.title !== "Untitled") {
		state.custom_title = data.title as string;
		changed = true;
	}
	if (!state.title_generated && data.title_generated) {
		state.title_generated = true;
		changed = true;
	}
	if (
		state.title_generate_attempts === 0 &&
		typeof data.title_generate_attempts === "number" &&
		data.title_generate_attempts > 0
	) {
		state.title_generate_attempts = data.title_generate_attempts;
		changed = true;
	}

	// Migrate archive fields
	if (!state.archived && data.archived) {
		state.archived = true;
		changed = true;
	}
	if (state.archived_at === null && data.archived_at != null) {
		state.archived_at = data.archived_at as number;
		changed = true;
	}
	if (!state.auto_archive_exempt && data.auto_archive_exempt) {
		state.auto_archive_exempt = true;
		changed = true;
	}

	// Migrate wire_mtime
	if (state.wire_mtime === null && data.wire_mtime != null) {
		state.wire_mtime = data.wire_mtime as number;
		changed = true;
	}

	return changed ? "migrated" : "no_change";
}

// ── Load / Save ────────────────────────────────────────

export async function loadSessionState(
	sessionDir: string,
): Promise<SessionState> {
	const stateFile = join(sessionDir, STATE_FILE_NAME);
	const file = Bun.file(stateFile);
	let state: SessionState;

	if (!(await file.exists())) {
		state = SessionState.parse({});
	} else {
		try {
			const data = await file.json();
			state = SessionState.parse(data);
		} catch {
			logger.warn(`Corrupted state file, using defaults: ${stateFile}`);
			state = SessionState.parse({});
		}
	}

	// One-time migration from legacy metadata.json (best-effort)
	const migration = await migrateLegacyMetadata(sessionDir, state);
	if (migration === "migrated" || migration === "no_change") {
		try {
			if (migration === "migrated") {
				await saveSessionState(state, sessionDir);
			}
			const legacyFile = join(sessionDir, LEGACY_METADATA_FILENAME);
			await Bun.$`rm -f ${legacyFile}`.quiet();
		} catch {
			logger.warn(
				`Failed to persist migration for ${sessionDir}, will retry next load`,
			);
		}
	}

	return state;
}

export async function saveSessionState(
	state: SessionState,
	sessionDir: string,
): Promise<void> {
	const stateFile = join(sessionDir, STATE_FILE_NAME);
	await Bun.write(stateFile, JSON.stringify(state, null, 2));
}
