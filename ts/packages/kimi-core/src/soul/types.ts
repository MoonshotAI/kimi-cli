/**
 * v2 Soul pure data types (§5.1 / §9-F / 附录 D).
 *
 * This module defines the data-only contract between `runSoulTurn` and its
 * callers. Behavioural interfaces (Runtime / EventSink / SoulContextState)
 * live in sibling files so this file has no behavioural surface.
 *
 * Fields are canonical v2 shape (snake_case for wire-adjacent fields such
 * as `tool_calls` / `stop_reason`, camelCase for Soul-internal fields).
 * `?: T | undefined` is used on every optional field so Zod `.optional()`
 * stays equivalent under `exactOptionalPropertyTypes: true` (Slice 1
 * lesson).
 */

import type { z } from 'zod';

import type { SoulContextState } from '../storage/context-state.js';
import type { CompactionConfig } from './compaction.js';

// Slice 1 already defines `UserInput` as `{ text: string }` for the
// SoulContextState write path. v2 §附录 D.3 widens the shape with optional
// attachments; the Slice 2 testing surface stays text-only so we re-export
// the Slice 1 symbol verbatim. Widening to the full v2 shape is deferred
// to the slice that actually introduces attachment handling (Slice 4+).
export type { UserInput } from '../storage/context-state.js';

// ── Token usage (v2 §附录 D.4) ──────────────────────────────────────────

export interface TokenUsage {
  input: number;
  output: number;
  cache_read?: number | undefined;
  cache_write?: number | undefined;
}

// ── Stop reason (v2 §附录 D.4) ──────────────────────────────────────────

// Mirrors v2 §附录 D.4: 7 canonical values. Note: Soul never returns
// `'max_steps'` — that case rethrows `MaxStepsExceededError` and never
// reaches a `TurnResult`. A TurnManager wanting to represent "stopped at
// max_steps" on a wire record should use its own enum; this Soul-facing
// type only enumerates values that actually flow back via `TurnResult`.
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'aborted'
  | 'error'
  | 'unknown';

// ── Turn result (v2 §5.1.7) ─────────────────────────────────────────────

export interface TurnResult {
  stopReason: StopReason;
  steps: number;
  usage: TokenUsage;
}

// ── Content block (v2 §附录 D.1) ────────────────────────────────────────

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string | undefined };

// ── Tool call (v2 §附录 D.2) ────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

// ── Tool result (v2 §附录 D.2 / §9-F.2) ─────────────────────────────────

export type ToolResultContent =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; data: string; media_type: string };
    };

export interface ToolResult<Output = unknown> {
  isError?: boolean | undefined;
  content: string | ToolResultContent[];
  output?: Output | undefined;
}

// ── Tool update (streamed progress, v2 §附录 D.2) ───────────────────────

export interface ToolUpdate {
  kind: 'stdout' | 'stderr' | 'progress' | 'status';
  text?: string | undefined;
  percent?: number | undefined;
}

// ── Assistant message (v2 §附录 D.1) ────────────────────────────────────

export interface AssistantMessage {
  role: 'assistant';
  content: string | ContentBlock[];
  tool_calls?: ToolCall[] | undefined;
  stop_reason?: StopReason | undefined;
}

// ── Tool interface (v2 §9-F.2 minimal four-field shape) ────────────────

export interface Tool<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  execute(
    toolCallId: string,
    args: Input,
    signal: AbortSignal,
    onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<Output>>;
}

// ── Soul turn overrides (v2 §5.1.4) ─────────────────────────────────────
//
// Strictly Soul-visible overrides — only fields affecting LLM visibility /
// model selection / effort. Host-side allow/deny rules are invisible to
// Soul by design and are not represented here.

export interface SoulTurnOverrides {
  model?: string | undefined;
  activeTools?: string[] | undefined;
  effort?: string | undefined;
}

// ── Soul config (v2 §5.1.3) ─────────────────────────────────────────────
//
// The two gate callbacks are intentionally named `beforeToolCall` and
// `afterToolCall`. Soul treats them as opaque async callbacks: one may
// return `{ block: true }` to veto a tool call, the other may return a
// `resultOverride` to transform the result. Soul carries no knowledge of
// why a call might be vetoed — that is a host-side concern injected via
// closure. See §5.0 rule 2.

export interface BeforeToolCallContext {
  toolCall: ToolCall;
  args: unknown;
  assistantMessage: AssistantMessage;
  context: SoulContextState;
}

export interface BeforeToolCallResult {
  block?: boolean | undefined;
  reason?: string | undefined;
  updatedInput?: unknown;
}

export interface AfterToolCallContext {
  toolCall: ToolCall;
  args: unknown;
  result: ToolResult;
  context: SoulContextState;
}

export interface AfterToolCallResult {
  resultOverride?: ToolResult | undefined;
}

export type BeforeToolCallHook = (
  ctx: BeforeToolCallContext,
  signal: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

export type AfterToolCallHook = (
  ctx: AfterToolCallContext,
  signal: AbortSignal,
) => Promise<AfterToolCallResult | undefined>;

export interface SoulConfig {
  tools: Tool[];
  maxSteps?: number | undefined;
  beforeToolCall?: BeforeToolCallHook | undefined;
  afterToolCall?: AfterToolCallHook | undefined;
  compactionConfig?: CompactionConfig | undefined;
}
