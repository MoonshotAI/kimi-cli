/**
 * Wire 2.1 types for the mock module.
 *
 * This is a lightweight copy of the Wire 2.1 envelope and event payload
 * types, sufficient for the mock data source to construct events.
 * When packages/kimi-wire is ready, both CLI and mock will import from
 * there and this file will be removed.
 */

// ── Wire Error ──────────────────────────────────────────────────────

export interface WireError {
  code: number;
  message: string;
  details?: unknown;
}

// ── WireMessage ─────────────────────────────────────────────────────

export interface WireMessage {
  id: string;
  time: number;
  session_id: string;
  type: 'request' | 'response' | 'event';
  from: string;
  to: string;
  method?: string | undefined;
  request_id?: string | undefined;
  data?: unknown;
  error?: WireError | undefined;
  turn_id?: string | undefined;
  agent_type?: 'main' | 'sub' | 'independent' | undefined;
  seq?: number | undefined;
}

// ── ID Generator ────────────────────────────────────────────────────

let _counter = 0;

function nextId(prefix: string): string {
  _counter += 1;
  return `${prefix}_${_counter.toString(36)}`;
}

/** Reset the internal counter (for testing). */
export function _resetIdCounter(): void {
  _counter = 0;
}

// ── Factory Option Types ────────────────────────────────────────────

export interface EventOpts {
  session_id: string;
  from?: string | undefined;
  to?: string | undefined;
  turn_id?: string | undefined;
  agent_type?: 'main' | 'sub' | 'independent' | undefined;
  seq?: number | undefined;
}

export interface RequestOpts {
  session_id: string;
  from?: string | undefined;
  to?: string | undefined;
  turn_id?: string | undefined;
}

export interface ResponseOpts {
  session_id: string;
  from?: string | undefined;
  to?: string | undefined;
}

// ── Factory Functions ───────────────────────────────────────────────

/** Create an event message. */
export function createEvent(
  method: string,
  data: unknown,
  opts: EventOpts,
): WireMessage {
  return {
    id: nextId('evt'),
    time: Date.now(),
    session_id: opts.session_id,
    type: 'event',
    from: opts.from ?? 'core',
    to: opts.to ?? 'client',
    method,
    data,
    turn_id: opts.turn_id,
    agent_type: opts.agent_type,
    seq: opts.seq,
  };
}

/** Create a request message (Core -> Client, e.g. approval.request). */
export function createRequest(
  method: string,
  data: unknown,
  opts: RequestOpts,
): WireMessage {
  return {
    id: nextId('req'),
    time: Date.now(),
    session_id: opts.session_id,
    type: 'request',
    from: opts.from ?? 'core',
    to: opts.to ?? 'client',
    method,
    data,
    turn_id: opts.turn_id,
  };
}

/** Create a response message. */
export function createResponse(
  requestId: string,
  data: unknown,
  opts: ResponseOpts,
): WireMessage {
  return {
    id: nextId('res'),
    time: Date.now(),
    session_id: opts.session_id,
    type: 'response',
    from: opts.from ?? 'client',
    to: opts.to ?? 'core',
    request_id: requestId,
    data,
  };
}

// ── Event Data Payload Types (subset needed by mock) ────────────────

export interface TurnBeginData {
  turn_id: string;
  user_input: string;
  input_kind: 'user' | 'system_trigger';
  trigger_source?: string | undefined;
}

export interface TurnEndData {
  turn_id: string;
  reason: 'done' | 'cancelled' | 'error';
  success: boolean;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number | undefined;
    cache_write_tokens?: number | undefined;
    cost_usd?: number | undefined;
  } | undefined;
}

export interface StepBeginData {
  step: number;
}

export interface StepEndData {}

export interface StepInterruptedData {
  step: number;
  reason: string;
}

export interface ContentDeltaData {
  type: 'text' | 'think' | 'image_url' | 'audio_url' | 'video_url';
  text?: string | undefined;
  think?: string | undefined;
  image_url?: { url: string } | undefined;
  audio_url?: { url: string } | undefined;
  video_url?: { url: string } | undefined;
}

export interface ToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string | undefined;
}

export interface ToolResultData {
  tool_call_id: string;
  output: string;
  is_error?: boolean | undefined;
}

export interface StatusUpdateData {
  context_usage?: number | undefined;
  context_tokens?: number | undefined;
  max_context_tokens?: number | undefined;
  token_usage?: {
    input_other: number;
    output: number;
    input_cache_read: number;
    input_cache_creation: number;
  } | undefined;
  plan_mode?: boolean | undefined;
  model?: string | undefined;
}

export interface ApprovalRequestData {
  id: string;
  tool_call_id: string;
  tool_name: string;
  action: string;
  description: string;
  display: DisplayBlock[];
}

export interface BriefDisplayBlock {
  type: 'brief';
  text: string;
}

export interface DiffDisplayBlock {
  type: 'diff';
  path: string;
  old_text: string;
  new_text: string;
  old_start?: number | undefined;
  new_start?: number | undefined;
  is_summary?: boolean | undefined;
}

export interface ShellDisplayBlock {
  type: 'shell';
  language: string;
  command: string;
}

export type DisplayBlock =
  | BriefDisplayBlock
  | DiffDisplayBlock
  | ShellDisplayBlock;

export interface SessionInfo {
  id: string;
  work_dir: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  archived: boolean;
}
