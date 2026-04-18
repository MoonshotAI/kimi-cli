/**
 * Wire 2.1 event data payload types.
 *
 * Each interface here corresponds to the `data` field of a WireMessage
 * with `type: "event"`. The `method` field on the envelope determines
 * which payload type applies.
 *
 * Field naming uses snake_case to match the JSON wire format.
 */

// ── Lifecycle Events ────────────────────────────────────────────────

/** method: "turn.begin" */
export interface TurnBeginData {
  turn_id: string;
  user_input: string;
  input_kind: 'user' | 'system_trigger';
  trigger_source?: string | undefined;
}

/** method: "turn.end" */
export interface TurnEndData {
  turn_id: string;
  reason: 'done' | 'cancelled' | 'error';
  success: boolean;
  usage?: TurnUsage | undefined;
}

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number | undefined;
  cache_write_tokens?: number | undefined;
  cost_usd?: number | undefined;
}

/** method: "step.begin" */
export interface StepBeginData {
  step: number;
}

/** method: "step.end" */
export interface StepEndData {}

/** method: "step.interrupted" */
export interface StepInterruptedData {
  step: number;
  reason: string;
}

// ── Content Events ──────────────────────────────────────────────────

/** method: "content.delta" */
export interface ContentDeltaData {
  type: 'text' | 'think' | 'image_url' | 'audio_url' | 'video_url';
  text?: string | undefined;
  think?: string | undefined;
  image_url?: { url: string } | undefined;
  audio_url?: { url: string } | undefined;
  video_url?: { url: string } | undefined;
}

// ── Tool Events ─────────────────────────────────────────────────────

/** method: "tool.call" (event, not RPC) */
export interface ToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string | undefined;
}

/** method: "tool.call.delta" */
export interface ToolCallDeltaData {
  args_part: string;
}

/** method: "tool.progress" */
export interface ToolProgressData {
  tool_call_id: string;
  update: unknown;
}

/** method: "tool.result" */
export interface ToolResultData {
  tool_call_id: string;
  output: string;
  is_error?: boolean | undefined;
}

// ── Status Events ───────────────────────────────────────────────────

/**
 * Phase 18 §A.14 froze `context_usage` as an object with `{used, total,
 * percent}`. `percent` is 0-100 (integer-ish). The TUI converts to a
 * 0-1 ratio at the consumer. See `WireHandler.status.update`.
 */
export interface ContextUsage {
  used: number;
  total: number;
  percent: number;
}

/** method: "status.update" */
export interface StatusUpdateData {
  context_usage?: ContextUsage | undefined;
  context_tokens?: number | undefined;
  max_context_tokens?: number | undefined;
  token_usage?: TokenUsage | undefined;
  plan_mode?: boolean | undefined;
  model?: string | undefined;
  mcp_status?: MCPStatus | undefined;
}

export interface TokenUsage {
  input_other: number;
  output: number;
  input_cache_read: number;
  input_cache_creation: number;
}

export interface MCPStatus {
  loading: boolean;
  connected: number;
  total: number;
  tools: number;
}

/**
 * method: "session_meta.changed" — Phase 16 / 决策 #113 wire-truth patch.
 *
 * Only wire-truth fields (title / tags / description / archived / color)
 * travel on this channel; derived fields update via other channels (e.g.
 * model.changed / status.update). The `patch` shape is kept open so
 * forward-compatible fields arrive transparently.
 */
export interface SessionMetaChangedData {
  patch: {
    title?: string | undefined;
    tags?: readonly string[] | undefined;
    description?: string | undefined;
    archived?: boolean | undefined;
    color?: string | undefined;
  };
  source: 'user' | 'auto' | 'system';
}

// ── Notification Events ─────────────────────────────────────────────

/** method: "notification" */
export interface NotificationData {
  id: string;
  category: string;
  type: string;
  title: string;
  body: string;
  severity: string;
  targets: string[];
  dedupe_key?: string | undefined;
}

// ── Approval / Hook / MCP / Plan / Error ────────────────────────────

/** method: "approval.request" (Core -> Client request, data field) */
export interface ApprovalRequestData {
  id: string;
  tool_call_id: string;
  tool_name: string;
  action: string;
  description: string;
  display: DisplayBlock[];
}

/** method: "question.request" (Core -> Client request, data field) */
export interface QuestionRequestData {
  id: string;
  tool_call_id: string;
  questions: QuestionRequestItem[];
}

export interface QuestionRequestItem {
  question: string;
  header?: string | undefined;
  multi_select: boolean;
  options: QuestionRequestOption[];
}

export interface QuestionRequestOption {
  label: string;
  description?: string | undefined;
}

/** method: "session.error" */
export interface SessionErrorData {
  error: string;
  error_type?:
    | 'rate_limit'
    | 'context_overflow'
    | 'api_error'
    | 'auth_error'
    | 'tool_error'
    | 'internal'
    | undefined;
  retry_after_ms?: number | undefined;
  details?: unknown;
}

/** method: "compaction.begin" */
export interface CompactionBeginData {}

/** method: "compaction.end" */
export interface CompactionEndData {
  tokens_before?: number | undefined;
  tokens_after?: number | undefined;
}

/** method: "mcp.loading" */
export interface MCPLoadingData {
  status: 'loading' | 'loaded' | 'error';
  server_name?: string | undefined;
  error?: string | undefined;
}

/** method: "hook.triggered" */
export interface HookTriggeredData {
  event: string;
  target: string;
  hook_count: number;
}

/** method: "hook.resolved" */
export interface HookResolvedData {
  event: string;
  target: string;
  action: 'allow' | 'block' | 'warn';
  reason: string;
  duration_ms: number;
}

/** method: "plan.display" */
export interface PlanDisplayData {
  content: string;
  file_path: string;
}

/** method: "subagent.event" */
export interface SubagentEventData {
  parent_tool_call_id: string;
  agent_id: string;
  agent_name?: string | undefined;
  sub_event: unknown;
}

// ── Display Blocks ──────────────────────────────────────────────────

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

export interface TodoDisplayItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface TodoDisplayBlock {
  type: 'todo';
  items: TodoDisplayItem[];
}

export interface BackgroundTaskDisplayBlock {
  type: 'background_task';
  task_id: string;
  kind: string;
  status: string;
  description: string;
}

export type DisplayBlock =
  | BriefDisplayBlock
  | DiffDisplayBlock
  | ShellDisplayBlock
  | TodoDisplayBlock
  | BackgroundTaskDisplayBlock;

// ── Event Method Literal Union ──────────────────────────────────────

/** All valid event method strings. */
export type WireEventMethod =
  | 'turn.begin'
  | 'turn.end'
  | 'step.begin'
  | 'step.end'
  | 'step.interrupted'
  | 'content.delta'
  | 'tool.call'
  | 'tool.call.delta'
  | 'tool.progress'
  | 'tool.result'
  | 'status.update'
  | 'notification'
  | 'compaction.begin'
  | 'compaction.end'
  | 'mcp.loading'
  | 'hook.triggered'
  | 'hook.resolved'
  | 'plan.display'
  | 'subagent.event'
  | 'session.error'
  | 'team_mail'
  | 'skill.invoked'
  | 'skill.completed'
  | 'model.changed'
  | 'thinking.changed'
  | 'system_prompt.changed'
  | 'session_meta.changed';
