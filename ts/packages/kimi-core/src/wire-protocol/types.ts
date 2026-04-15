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
  | 'session.attach';

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

// All wire methods
export type WireMethod =
  | ProcessMethod
  | ConversationMethod
  | ManagementMethod
  | ConfigMethod
  | ToolsMethod
  | ReverseRpcMethod;

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
  | 'plan.display';

// ── Channel type (§6.1) ─────────────────────────────────────────────────

export type ChannelType = 'conversation' | 'management' | 'config' | 'tools' | 'process';

// ── Initialize handshake data (§3.5) ────────────────────────────────────

export interface InitializeRequestData {
  protocol_version?: string | undefined;
  client_capabilities?: Record<string, unknown> | undefined;
}

export interface InitializeResponseData {
  protocol_version: string;
  capabilities: Record<string, unknown>;
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

export interface SessionPromptRequestData {
  input: string;
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
  queued: true;
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
  user_input: string;
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

export interface ContentDeltaEventData {
  type: 'text' | 'thinking';
  text?: string | undefined;
  thinking?: string | undefined;
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

const _rawWireMessageSchema = z.object({
  id: z.string(),
  time: z.number(),
  session_id: z.string(),
  type: z.enum(['request', 'response', 'event']),
  from: z.string(),
  to: z.string(),
  method: z.string().optional(),
  request_id: z.string().optional(),
  data: z.unknown().optional(),
  error: _rawWireErrorSchema.optional(),
  turn_id: z.string().optional(),
  agent_type: z.enum(['main', 'sub', 'independent']).optional(),
  seq: z.number().optional(),
});

export const WireErrorSchema: z.ZodType<WireError> = _rawWireErrorSchema;
export const WireMessageSchema: z.ZodType<WireMessage> = _rawWireMessageSchema;

const _dg_WireError: AssertEqual<z.infer<typeof _rawWireErrorSchema>, WireError> = true;
const _dg_WireMessage: AssertEqual<z.infer<typeof _rawWireMessageSchema>, WireMessage> = true;
void _dg_WireError;
void _dg_WireMessage;
