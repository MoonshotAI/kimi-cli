// Python session schema — the shapes we read from disk. These are
// tolerant `unknown`-friendly pass-throughs (we validate structurally,
// not with zod) because Python's side is the authoritative producer and
// future Python versions may add unknown fields we must silently ignore.

export interface PythonToolCallFunctionBody {
  readonly name: string;
  readonly arguments: string | null;
}

export interface PythonToolCall {
  readonly type?: 'function' | undefined;
  readonly id: string;
  readonly function: PythonToolCallFunctionBody;
  readonly extras?: Record<string, unknown> | null | undefined;
}

export interface PythonTextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface PythonThinkPart {
  readonly type: 'think';
  readonly think: string;
  readonly encrypted?: string | null | undefined;
}

export interface PythonImageURLPart {
  readonly type: 'image_url';
  readonly image_url: { readonly url: string; readonly id?: string | null | undefined };
}

export interface PythonAudioURLPart {
  readonly type: 'audio_url';
  readonly audio_url: { readonly url: string; readonly id?: string | null | undefined };
}

export interface PythonVideoURLPart {
  readonly type: 'video_url';
  readonly video_url: { readonly url: string; readonly id?: string | null | undefined };
}

export type PythonContentPart =
  | PythonTextPart
  | PythonThinkPart
  | PythonImageURLPart
  | PythonAudioURLPart
  | PythonVideoURLPart
  | { readonly type: string; readonly [k: string]: unknown };

export type PythonMessageContent = string | readonly PythonContentPart[];

export type PythonRole = 'system' | 'user' | 'assistant' | 'tool';

export interface PythonMessage {
  readonly role: PythonRole;
  readonly name?: string | null | undefined;
  readonly content: PythonMessageContent;
  readonly tool_calls?: readonly PythonToolCall[] | null | undefined;
  readonly tool_call_id?: string | null | undefined;
  readonly partial?: boolean | null | undefined;
}

/** Any line from context.jsonl — either a real Message or a pseudo-role record. */
export type PythonContextEntry =
  | PythonMessage
  | { readonly role: '_system_prompt'; readonly content: string }
  | { readonly role: '_checkpoint'; readonly id: number }
  | { readonly role: '_usage'; readonly token_count: number };

// ── wire.jsonl envelopes ───────────────────────────────────────────────

export interface PythonWireMetadata {
  readonly type: 'metadata';
  readonly protocol_version: string;
}

export interface PythonWireMessageEnvelope {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface PythonWireRecord {
  readonly timestamp: number;
  readonly message: PythonWireMessageEnvelope;
}

// ── state.json ────────────────────────────────────────────────────────

export interface PythonApprovalStateData {
  readonly yolo?: boolean | undefined;
  readonly auto_approve_actions?: readonly string[] | undefined;
}

export interface PythonTodoItemState {
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'done';
}

export interface PythonSessionState {
  readonly version?: number | undefined;
  readonly approval?: PythonApprovalStateData | undefined;
  readonly additional_dirs?: readonly string[] | undefined;
  readonly custom_title?: string | null | undefined;
  readonly title_generated?: boolean | undefined;
  readonly title_generate_attempts?: number | undefined;
  readonly plan_mode?: boolean | undefined;
  readonly plan_session_id?: string | null | undefined;
  readonly plan_slug?: string | null | undefined;
  readonly wire_mtime?: number | null | undefined;
  readonly archived?: boolean | undefined;
  readonly archived_at?: number | null | undefined;
  readonly auto_archive_exempt?: boolean | undefined;
  readonly todos?: readonly PythonTodoItemState[] | undefined;
}

// ── Python TokenUsage ─────────────────────────────────────────────────

export interface PythonTokenUsage {
  readonly input_other: number;
  readonly output: number;
  readonly input_cache_read?: number | undefined;
  readonly input_cache_creation?: number | undefined;
}
