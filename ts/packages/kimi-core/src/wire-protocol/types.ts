/**
 * Wire protocol 2.1 — type definitions (Slice 5 scope, §3).
 *
 * Defines the unified message envelope (`WireMessage`), wire error shape,
 * and all request method / event method string literals.
 *
 * Uses the three-stage pattern for zod schema exports:
 *   1. Private `_raw*Schema` — zod-inferred type
 *   2. Public `*Schema: z.ZodType<T>` — explicit interface as type param
 *   3. `AssertEqual` drift guard
 */

import { z } from 'zod';

// ── Drift-guard utility ──────────────────────────────────────────────────

type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

// ── Wire error shape (§3.1) ──────────────────────────────────────────────

export interface WireError {
  code: number;
  message: string;
  details?: unknown;
}

// ── Wire message envelope (§3.1 — "极繁主义") ────────────────────────────

export interface WireMessage {
  // === Required fields ===
  id: string;
  time: number;
  session_id: string;
  type: 'request' | 'response' | 'event';
  from: string;
  to: string;

  // === Conditional on type ===
  method?: string | undefined;
  request_id?: string | undefined;
  data?: unknown;
  error?: WireError | undefined;

  // === Optional fields ===
  turn_id?: string | undefined;
  agent_type?: 'main' | 'sub' | 'independent' | undefined;
  seq?: number | undefined;
}

// ── Narrowed message types (discriminated on `type`) ─────────────────────

export interface WireRequest extends WireMessage {
  type: 'request';
  method: string;
}

export interface WireResponse extends WireMessage {
  type: 'response';
  request_id: string;
}

export interface WireEvent extends WireMessage {
  type: 'event';
  method: string;
  seq: number;
}

// ── Protocol version (§3.4) ──────────────────────────────────────────────

export const WIRE_PROTOCOL_VERSION = '2.1' as const;

// ── Process session ID (§3.5) ────────────────────────────────────────────

export const PROCESS_SESSION_ID = '__process__' as const;

// ── Request method literals (§3.5) ───────────────────────────────────────

// Process-level methods (session_id = "__process__")
export type ProcessMethod =
  | 'initialize'
  | 'shutdown'
  | 'session.create'
  | 'session.list'
  | 'session.destroy'
  | 'config.getModels'
  | 'config.get';

// Conversation channel (long-running, session-scoped)
export type ConversationMethod =
  | 'session.prompt'
  | 'session.steer'
  | 'session.cancel'
  | 'session.resume';

// Management channel (instant, session-scoped)
export type ManagementMethod =
  | 'session.fork'
  | 'session.rename'
  | 'session.getStatus'
  | 'session.getHistory'
  | 'session.getTurnEvents'
  | 'session.getUsage'
  | 'session.compact'
  | 'session.subscribe'
  | 'session.unsubscribe'
  | 'session.attach'
  // Phase 16 / 决策 #113 — sessionMeta wire methods.
  | 'session.getMeta'
  | 'session.setTags'
  // Phase 18 §E.3-E.5 + §F — subagent persistence + slash core.
  | 'session.getBackgroundTasks'
  | 'session.stopBackgroundTask'
  | 'session.getBackgroundTaskOutput'
  | 'session.rollback'
  | 'session.listSkills'
  | 'session.activateSkill';

// Config channel (instant, session-scoped)
export type ConfigMethod =
  | 'session.setModel'
  | 'session.setThinking'
  | 'session.setSystemPrompt'
  | 'session.setPlanMode'
  | 'session.setYolo'
  | 'session.addSystemReminder';

// Tools channel (instant, session-scoped)
export type ToolsMethod =
  | 'session.registerTool'
  | 'session.removeTool'
  | 'session.listTools'
  | 'session.setActiveTools';

// Core → Client reverse RPC methods
export type ReverseRpcMethod = 'approval.request' | 'question.ask' | 'tool.call' | 'hook.request';

// Slice 7.2 (决策 #100) — MCP request methods. Phase 7 only registers the
// names; the router returns NotImplemented until later slices land.
export type McpMethod =
  | 'mcp.list'
  | 'mcp.connect'
  | 'mcp.disconnect'
  | 'mcp.refresh'
  | 'mcp.listResources'
  | 'mcp.readResource'
  | 'mcp.listPrompts'
  | 'mcp.getPrompt'
  | 'mcp.startAuth'
  | 'mcp.resetAuth';

// All wire methods
export type WireMethod =
  | ProcessMethod
  | ConversationMethod
  | ManagementMethod
  | ConfigMethod
  | ToolsMethod
  | ReverseRpcMethod
  | McpMethod;

// ── Event method literals (§3.6) ─────────────────────────────────────────

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
  | 'compaction.begin'
  | 'compaction.end'
  | 'notification'
  | 'subagent.event'
  | 'hook.triggered'
  | 'hook.resolved'
  | 'session.error'
  | 'session.ownership_lost'
  | 'system_prompt.changed'
  | 'model.changed'
  | 'thinking.changed'
  | 'plan.display'
  // Phase 17 §A.5 — session.replay chunked streaming. Client keys
  // these off the originating request via `request_id` on the event
  // envelope; `seq` is populated by `createWireEvent` so playback
  // ordering is deterministic.
  | 'session.replay.chunk'
  | 'session.replay.end'
  // Slice 7.2 (决策 #100) — MCP lifecycle events.
  | 'mcp.connected'
  | 'mcp.disconnected'
  | 'mcp.error'
  | 'mcp.tools_changed'
  | 'mcp.resources_changed'
  | 'mcp.auth_required'
  // Phase 16 / 决策 #113 — sessionMeta patch event.
  | 'session_meta.changed';

// ── Channel type (§6.1) ─────────────────────────────────────────────────

export type ChannelType = 'conversation' | 'management' | 'config' | 'tools' | 'process';

// ── Initialize handshake data (§3.5) ────────────────────────────────────

/**
 * v2-update §3.5 InitializeRequest — sent by the client right after the
 * transport connects. Narrow structural fields (hooks / capabilities) are
 * hoisted out of the open-ended `client_capabilities` bag so TS callers can
 * construct them without an `as unknown as` cast.
 */
export interface InitializeRequestData {
  protocol_version?: string | undefined;
  capabilities?:
    | {
        hooks?: boolean | undefined;
        approval?: boolean | undefined;
        streaming?: boolean | undefined;
      }
    | undefined;
  hooks?: ReadonlyArray<{ event: string; matcher?: unknown }> | undefined;
  /** Open-ended bag for forward-compatible extensions. */
  client_capabilities?: Record<string, unknown> | undefined;
}

/**
 * v2-update §3.5 InitializeResponse — the server advertises which wire
 * events and methods it supports. `session_id` is optional: the server
 * includes it when initialize implicitly binds to an existing session
 * (e.g. `--continue`). Additional capability flags land inside
 * `capabilities` alongside `events` / `methods`.
 */
export interface InitializeResponseData {
  protocol_version: string;
  capabilities: {
    events?: readonly string[] | undefined;
    methods?: readonly string[] | undefined;
  } & Record<string, unknown>;
  session_id?: string | undefined;
}

// ── Session create data (§3.5) ───────────────────────────────────────────

export interface SessionCreateRequestData {
  session_id?: string | undefined;
  model?: string | undefined;
  system_prompt?: string | undefined;
}

export interface SessionCreateResponseData {
  session_id: string;
}

// ── Session prompt data (§3.5 — non-blocking) ───────────────────────────

// Phase 14 §3.5 — user-input parts (multi-modal).
export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImageURLPart {
  type: 'image_url';
  image_url: { url: string };
}
export interface VideoURLPart {
  type: 'video_url';
  video_url: { url: string };
}
export type UserInputPart = TextPart | ImageURLPart | VideoURLPart;

/** Coerce a legacy string input into the canonical part array form. */
export function normalizeUserInput(
  input: string | readonly UserInputPart[],
): readonly UserInputPart[] {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input }];
  }
  return input;
}

export interface SessionPromptRequestData {
  input: string | readonly UserInputPart[];
  input_kind?: 'user' | 'system_trigger' | undefined;
  trigger_source?: string | undefined;
}

export interface SessionPromptResponseData {
  turn_id: string;
  status: 'started';
}

// ── Session steer data ──────────────────────────────────────────────────

export interface SessionSteerRequestData {
  input: string;
}

export interface SessionSteerResponseData {
  // Phase 17 §E.2 — runtime returns `{ok: true}` via DispatchResponse;
  // the type was drifting with `{queued: true}` from the design note.
  // Align on `ok` so `session.steer` round-trip type-checks.
  ok: true;
}

// ── Session cancel data ─────────────────────────────────────────────────

export interface SessionCancelRequestData {
  turn_id?: string | undefined;
}

// ── Session getStatus data ──────────────────────────────────────────────

export interface SessionGetStatusResponseData {
  state: string;
  current_turn?: string | undefined;
  model?: string | undefined;
}

// ── Session getHistory data ─────────────────────────────────────────────

export interface SessionGetHistoryResponseData {
  messages: unknown[];
}

// ── Config change data types ────────────────────────────────────────────

export interface SessionSetModelRequestData {
  model: string;
}

export interface SessionSetSystemPromptRequestData {
  prompt: string;
}

export interface SessionSetPlanModeRequestData {
  enabled: boolean;
}

// Phase 18 A.5 — toggle session-scoped bypass-permissions (yolo) mode.
export interface SessionSetYoloRequestData {
  enabled: boolean;
}

// Phase 18 A.6 — adjust reasoning/thinking effort level.
export interface SessionSetThinkingRequestData {
  level: string;
}

export interface SessionAddSystemReminderRequestData {
  content: string;
  category?: string | undefined;
}

// ── Tool registration data ──────────────────────────────────────────────

export interface SessionRegisterToolRequestData {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface SessionListToolsResponseData {
  tools: Array<{ name: string; description: string }>;
}

// ── Event data types (§3.6) ─────────────────────────────────────────────

export interface TurnBeginEventData {
  turn_id: string;
  user_input: string | readonly UserInputPart[];
  input_kind: 'user' | 'system_trigger';
  trigger_source?: string | undefined;
}

export interface TurnEndEventData {
  turn_id: string;
  reason: 'done' | 'cancelled' | 'error';
  success: boolean;
  usage?:
    | {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens?: number | undefined;
        cache_write_tokens?: number | undefined;
        cost_usd?: number | undefined;
      }
    | undefined;
}

export interface StepBeginEventData {
  step: number;
}

export interface StepInterruptedEventData {
  step: number;
  reason: string;
}

/**
 * Phase 17 §B.6 — `content.delta` wire event payload. Carries either
 * a text / thinking chunk (the legacy shape) or a streaming
 * `tool_call_part` when the provider emits tool_use arguments
 * incrementally. Keeping all three variants on one envelope lets
 * clients render everything through a single frame type.
 */
export interface ContentDeltaEventData {
  type: 'text' | 'thinking' | 'tool_call_part';
  text?: string | undefined;
  thinking?: string | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
  arguments_chunk?: string | undefined;
}

export interface ToolCallEventData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string | undefined;
}

export interface ToolResultEventData {
  tool_call_id: string;
  output: string;
  is_error?: boolean | undefined;
}

export interface StatusUpdateEventData {
  context_usage?: unknown;
  token_usage?: unknown;
  plan_mode?: boolean | undefined;
  model?: string | undefined;
}

// ── Phase 16 / 决策 #113 — sessionMeta wire method payloads ────────────

export interface SessionRenameRequestData {
  title: string;
}

export interface SessionSetTagsRequestData {
  tags: readonly string[];
}

export interface SessionGetMetaResponseData {
  meta: {
    session_id: string;
    created_at: number;
    title?: string | undefined;
    tags?: readonly string[] | undefined;
    description?: string | undefined;
    archived?: boolean | undefined;
    last_model?: string | undefined;
    turn_count: number;
    last_updated: number;
  };
}

export interface SessionMetaChangedEventData {
  patch: {
    title?: string | undefined;
    tags?: readonly string[] | undefined;
    description?: string | undefined;
    archived?: boolean | undefined;
    color?: string | undefined;
  };
  source: 'user' | 'auto' | 'system';
}

export interface SessionErrorEventData {
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

// ── Zod schemas for WireMessage envelope ────────────────────────────────

const _rawWireErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  details: z.unknown().optional(),
});

/**
 * Envelope base schema — field-level validation only.
 *
 * Conditional cross-field rules (type → method/request_id/seq) live in the
 * exported `WireMessageSchema` below via `.superRefine`. Splitting avoids the
 * refine running on values that already failed base parsing and lets zod emit
 * accurate per-field error paths.
 *
 * Field constraints mirror §3 appendix A of `kimi-core-ts-design-v2.md`:
 *   - `id` must carry one of the `req_` / `res_` / `evt_` prefixes
 *   - `time` must be a positive integer (Unix ms)
 *   - `seq` (if present) must be a non-negative integer
 */
const _rawWireMessageSchema = z.object({
  id: z.string().regex(/^(req|res|evt)_/, {
    message: 'id must start with req_, res_, or evt_',
  }),
  time: z.number().int().positive(),
  session_id: z.string().min(1),
  type: z.enum(['request', 'response', 'event']),
  from: z.string().min(1),
  to: z.string().min(1),
  method: z.string().min(1).optional(),
  request_id: z.string().min(1).optional(),
  data: z.unknown().optional(),
  error: _rawWireErrorSchema.optional(),
  turn_id: z.string().optional(),
  agent_type: z.enum(['main', 'sub', 'independent']).optional(),
  seq: z.number().int().nonnegative().optional(),
});

const _refinedWireMessageSchema = _rawWireMessageSchema.superRefine((msg, ctx) => {
  // Rule 1: request/event must have a non-empty `method`.
  if (
    (msg.type === 'request' || msg.type === 'event') &&
    (msg.method === undefined || msg.method === '')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['method'],
      message: `${msg.type} envelope must include non-empty "method"`,
    });
  }
  // Rule 2: response must have a non-empty `request_id` (for RPC pairing).
  // Phase 17 §A.4 — JSON-RPC parity: when the server could not recover
  // the client id (codec / envelope schema failure), the error
  // response is allowed to omit `request_id`. Gated on `error` being
  // present so normal responses still require the id.
  if (
    msg.type === 'response' &&
    (msg.request_id === undefined || msg.request_id === '') &&
    msg.error === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['request_id'],
      message: 'response envelope must include non-empty "request_id"',
    });
  }
  // Rule 3: event must have a `seq` (monotonic event ordering for resume/replay).
  if (msg.type === 'event' && msg.seq === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['seq'],
      message: 'event envelope must include "seq"',
    });
  }
});

export const WireErrorSchema: z.ZodType<WireError> = _rawWireErrorSchema;
export const WireMessageSchema: z.ZodType<WireMessage> = _refinedWireMessageSchema;

const _dg_WireError: AssertEqual<z.infer<typeof _rawWireErrorSchema>, WireError> = true;
const _dg_WireMessage: AssertEqual<z.infer<typeof _rawWireMessageSchema>, WireMessage> = true;
void _dg_WireError;
void _dg_WireMessage;
