/**
 * Web models — corresponds to Python web/models.py
 * Uses plain TS interfaces (no Zod needed for simple request/response shapes).
 *
 * NOTE: Python defines `SessionState` as a string literal type here, but TS
 * `session_state.ts` already exports a `SessionState` Zod schema, so we call
 * the web version `SessionRunState` to avoid the naming conflict.
 */

// ── Session run state (NOT the same as session_state.ts SessionState) ──

export type SessionRunState =
	| "stopped"
	| "idle"
	| "busy"
	| "restarting"
	| "error";

// ── Session status (real-time worker status) ──

export interface SessionStatus {
	session_id: string;
	state: SessionRunState;
	seq: number;
	worker_id: string | null;
	reason: string | null;
	detail: string | null;
	updated_at: string; // ISO datetime
}

// ── Session notice (sent to WebSocket clients) ──

export interface SessionNoticePayload {
	text: string;
	kind: "restart";
	reason: string | null;
	restart_ms: number | null;
}

export interface SessionNoticeEvent {
	type: "SessionNotice";
	payload: SessionNoticePayload;
}

// ── Git diff ──

export interface GitFileDiff {
	path: string;
	additions: number;
	deletions: number;
	status: "added" | "modified" | "deleted" | "renamed";
}

export interface GitDiffStats {
	is_git_repo: boolean;
	has_changes: boolean;
	total_additions: number;
	total_deletions: number;
	files: GitFileDiff[];
	error: string | null;
}

// ── Session (list / detail model) ──

export interface WebSession {
	session_id: string;
	title: string;
	last_updated: string; // ISO datetime
	is_running: boolean;
	status: SessionStatus | null;
	work_dir: string;
	session_dir: string;
	archived: boolean;
}

// ── Requests / Responses ──

export interface UpdateSessionRequest {
	title?: string; // 1-200 chars
	archived?: boolean;
}

export interface GenerateTitleRequest {
	user_message?: string;
	assistant_response?: string;
}

export interface GenerateTitleResponse {
	title: string;
}

export interface CreateSessionRequest {
	work_dir?: string;
	create_dir?: boolean;
}

export interface ForkSessionRequest {
	turn_index: number;
}

export interface UploadSessionFileResponse {
	filename: string;
	size: number;
	content_type: string;
	path: string;
}
