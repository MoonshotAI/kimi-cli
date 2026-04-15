/**
 * Wire 2.1 request/response data payload types.
 *
 * Each interface corresponds to the `data` field of a WireMessage with
 * `type: "request"` or `type: "response"`. The `method` field on the
 * envelope determines which payload type applies.
 *
 * Field naming uses snake_case to match the JSON wire format.
 */

// ── Initialize ──────────────────────────────────────────────────────

export interface InitializeParams {
  protocol_version: string;
  client_info?: { name: string; version: string } | undefined;
  capabilities?: Record<string, unknown> | undefined;
}

export interface InitializeResult {
  protocol_version: string;
  capabilities: Record<string, unknown>;
}

// ── Session ─────────────────────────────────────────────────────────

export interface SessionCreateParams {
  work_dir: string;
}

export interface SessionCreateResult {
  session_id: string;
}

export interface SessionInfo {
  id: string;
  work_dir: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  archived: boolean;
}

export interface SessionListResult {
  sessions: SessionInfo[];
}

export interface SessionForkParams {
  session_id: string;
  at_turn?: number | undefined;
}

export interface SessionForkResult {
  session_id: string;
}

export interface SessionRenameParams {
  session_id: string;
  title: string;
}

// ── Prompt / Steer / Cancel / Resume ────────────────────────────────

export interface SessionPromptParams {
  input: string;
  images?: string[] | undefined;
}

export interface SessionPromptResult {
  turn_id: string;
  status: 'started';
}

export interface SessionSteerParams {
  input: string;
}

export interface SessionCancelParams {}

export interface SessionResumeParams {}

// ── Status / Usage ──────────────────────────────────────────────────

export interface SessionStatusResult {
  state: string;
  current_turn?: string | undefined;
}

export interface SessionUsageResult {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_cost_usd: number;
}

// ── Configuration ───────────────────────────────────────────────────

export interface SetModelParams {
  model: string;
}

export interface SetThinkingParams {
  level: string;
}

export interface SetPlanModeParams {
  enabled: boolean;
}

export interface SetYoloParams {
  enabled: boolean;
}

// ── Core -> Client RPC Response Types ───────────────────────────────

export interface ApprovalResponseData {
  response: 'approved' | 'approved_for_session' | 'rejected' | 'cancelled';
  feedback?: string | undefined;
}

export interface QuestionResponseData {
  answers: string[];
}

export interface HookResponseData {
  action: 'allow' | 'block';
  reason?: string | undefined;
}
