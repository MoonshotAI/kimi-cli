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

import { z } from 'zod';

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
//
// Phase 2 (todo/phase-2-compaction-out-of-soul.md 铁律 7): `'needs_compaction'`
// is the signal Soul returns when `shouldCompact` fires at the while-top
// safe point. Soul does no lifecycle / provider / journal / context-reset
// work itself; TurnManager catches this stop reason and runs
// `executeCompaction` before re-entering Soul on the same turn_id.
export type StopReason =
  | 'end_turn'
  | 'needs_compaction'
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
    }
  | {
      // Phase 14 §3.3 / decision #3 — additive video variant.
      type: 'video';
      source: { type: 'base64'; data: string; media_type: string };
    };

export interface ToolResult<Output = unknown> {
  isError?: boolean | undefined;
  content: string | ToolResultContent[];
  output?: Output | undefined;
}

// ── Tool update (streamed progress, v2 §附录 D.2 + 决策 #98 D10) ────────

export interface ToolUpdate {
  kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  text?: string | undefined;
  percent?: number | undefined;
  /** Vendor-defined event identifier when `kind === 'custom'`. */
  custom_kind?: string | undefined;
  /** Opaque payload paired with `custom_kind`. */
  custom_data?: unknown;
}

// ── Tool UI rendering hints (v2 §10.7.3 / 决策 #98) ─────────────────────
//
// Two discriminated unions ferry rich rendering hints from a Tool to the
// UI without forcing the client to hardcode tool-specific arg / output
// field names. Field naming is STRICT snake_case to match v2 §10.7.3.
// Soul carries no `permission` vocabulary — these are pure data shapes.

export type ToolInputDisplay =
  | {
      kind: 'command';
      command: string;
      cwd?: string | undefined;
      description?: string | undefined;
      /**
       * Phase 14 §1.1 — shell dialect hint ('bash' | 'powershell').
       * Clients that don't recognise it ignore the field (additive).
       */
      language?: 'bash' | 'powershell' | undefined;
    }
  | {
      kind: 'file_io';
      operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
      path: string;
      detail?: string | undefined;
    }
  | {
      kind: 'diff';
      path: string;
      before: string;
      after: string;
      hunks?: number | undefined;
    }
  | {
      kind: 'search';
      query: string;
      scope?: string | undefined;
    }
  | { kind: 'url_fetch'; url: string; method?: string | undefined }
  | {
      kind: 'agent_call';
      agent_name: string;
      prompt: string;
      background?: boolean | undefined;
    }
  | { kind: 'skill_call'; skill_name: string; args?: string | undefined }
  | {
      kind: 'todo_list';
      items: Array<{ title: string; status: string }>;
    }
  | {
      kind: 'background_task';
      task_id: string;
      status: string;
      description: string;
      /**
       * Vendor-defined task subtype. Renamed from the v2 doc's inner
       * `kind` field to avoid clobbering the discriminator (§10.7.3 doc
       * bug — see slice-5 migration-report §9.5).
       */
      task_kind?: string | undefined;
    }
  | { kind: 'task_stop'; task_id: string; task_description: string }
  | { kind: 'generic'; summary: string; detail?: unknown };

export type ToolResultDisplay =
  | {
      kind: 'command_output';
      exit_code: number;
      stdout?: string | undefined;
      stderr?: string | undefined;
    }
  | {
      kind: 'file_content';
      path: string;
      content: string;
      range?: { start: number; end: number } | undefined;
      truncated?: boolean | undefined;
    }
  | {
      kind: 'diff';
      path: string;
      before: string;
      after: string;
      hunks?: number | undefined;
    }
  | {
      kind: 'search_results';
      query: string;
      matches: Array<{ file: string; line: number; text: string }>;
    }
  | {
      kind: 'url_content';
      url: string;
      status: number;
      preview?: string | undefined;
      content_type?: string | undefined;
    }
  | {
      kind: 'agent_summary';
      agent_name: string;
      result?: string | undefined;
      steps?: number | undefined;
    }
  | {
      kind: 'background_task';
      task_id: string;
      status: string;
      description: string;
    }
  | {
      kind: 'todo_list';
      items: Array<{ title: string; status: string }>;
    }
  | { kind: 'structured'; data: unknown }
  | { kind: 'text'; text: string; truncated?: boolean | undefined }
  | { kind: 'error'; message: string; code?: string | undefined }
  | { kind: 'generic'; summary: string; detail?: unknown };

// ── Zod schemas for the display unions (consumed by wire-record.ts) ────

const _rawToolInputDisplaySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string(),
    cwd: z.string().optional(),
    description: z.string().optional(),
    language: z.enum(['bash', 'powershell']).optional(),
  }),
  z.object({
    kind: z.literal('file_io'),
    operation: z.enum(['read', 'write', 'edit', 'glob', 'grep']),
    path: z.string(),
    detail: z.string().optional(),
  }),
  z.object({
    kind: z.literal('diff'),
    path: z.string(),
    before: z.string(),
    after: z.string(),
    hunks: z.number().optional(),
  }),
  z.object({
    kind: z.literal('search'),
    query: z.string(),
    scope: z.string().optional(),
  }),
  z.object({
    kind: z.literal('url_fetch'),
    url: z.string(),
    method: z.string().optional(),
  }),
  z.object({
    kind: z.literal('agent_call'),
    agent_name: z.string(),
    prompt: z.string(),
    background: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('skill_call'),
    skill_name: z.string(),
    args: z.string().optional(),
  }),
  z.object({
    kind: z.literal('todo_list'),
    items: z.array(z.object({ title: z.string(), status: z.string() })),
  }),
  z.object({
    kind: z.literal('background_task'),
    task_id: z.string(),
    status: z.string(),
    description: z.string(),
    task_kind: z.string().optional(),
  }),
  z.object({
    kind: z.literal('task_stop'),
    task_id: z.string(),
    task_description: z.string(),
  }),
  z.object({
    kind: z.literal('generic'),
    summary: z.string(),
    detail: z.unknown().optional(),
  }),
]);
export const ToolInputDisplaySchema: z.ZodType<ToolInputDisplay> = _rawToolInputDisplaySchema;

const _rawToolResultDisplaySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command_output'),
    exit_code: z.number(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  }),
  z.object({
    kind: z.literal('file_content'),
    path: z.string(),
    content: z.string(),
    range: z.object({ start: z.number(), end: z.number() }).optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('diff'),
    path: z.string(),
    before: z.string(),
    after: z.string(),
    hunks: z.number().optional(),
  }),
  z.object({
    kind: z.literal('search_results'),
    query: z.string(),
    matches: z.array(
      z.object({ file: z.string(), line: z.number(), text: z.string() }),
    ),
  }),
  z.object({
    kind: z.literal('url_content'),
    url: z.string(),
    status: z.number(),
    preview: z.string().optional(),
    content_type: z.string().optional(),
  }),
  z.object({
    kind: z.literal('agent_summary'),
    agent_name: z.string(),
    result: z.string().optional(),
    steps: z.number().optional(),
  }),
  z.object({
    kind: z.literal('background_task'),
    task_id: z.string(),
    status: z.string(),
    description: z.string(),
  }),
  z.object({
    kind: z.literal('todo_list'),
    items: z.array(z.object({ title: z.string(), status: z.string() })),
  }),
  z.object({ kind: z.literal('structured'), data: z.unknown() }),
  z.object({
    kind: z.literal('text'),
    text: z.string(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
  }),
  z.object({
    kind: z.literal('generic'),
    summary: z.string(),
    detail: z.unknown().optional(),
  }),
]);
export const ToolResultDisplaySchema: z.ZodType<ToolResultDisplay> = _rawToolResultDisplaySchema;

// Compile-time drift guards — keep zod inferred shape aligned with the
// hand-written discriminated unions above.
type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;
const _driftGuard_ToolInputDisplay: AssertEqual<
  z.infer<typeof _rawToolInputDisplaySchema>,
  ToolInputDisplay
> = true;
void _driftGuard_ToolInputDisplay;
const _driftGuard_ToolResultDisplay: AssertEqual<
  z.infer<typeof _rawToolResultDisplaySchema>,
  ToolResultDisplay
> = true;
void _driftGuard_ToolResultDisplay;

// ── Tool display hooks (v2 §10.7.4 / 决策 #98) ──────────────────────────

export interface ToolDisplayHooks<Input = unknown, Output = unknown> {
  getUserFacingName?(input: Partial<Input> | undefined): string;
  getActivityDescription?(input: Partial<Input> | undefined): string;
  getInputDisplay?(input: Input): ToolInputDisplay;
  getResultDisplay?(input: Input, result: ToolResult<Output>): ToolResultDisplay;
  getProgressDescription?(input: Input, update: ToolUpdate): string | undefined;
  getCollapsedSummary?(input: Input, result: ToolResult<Output>): string;
}

// ── Assistant message (v2 §附录 D.1) ────────────────────────────────────

export interface AssistantMessage {
  role: 'assistant';
  content: string | ContentBlock[];
  tool_calls?: ToolCall[] | undefined;
  stop_reason?: StopReason | undefined;
}

// ── Tool metadata (v2 §9-F.2 / Slice 7.2 决策 #100) ─────────────────────

export interface ToolMetadata {
  readonly source: 'builtin' | 'mcp' | 'sdk' | 'plugin';
  /** Server identifier for `source === 'mcp'`. */
  readonly serverId?: string | undefined;
  /** Original (un-prefixed) tool name as advertised by the source. */
  readonly originalName?: string | undefined;
}

// ── Tool interface (v2 §9-F.2 + Slice 5 optional fields) ────────────────

export interface Tool<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  /**
   * Slice 5 / 决策 #96 L1 — single tool result content character ceiling.
   * `undefined` → orchestrator falls back to `DEFAULT_BUILTIN_MAX_RESULT_CHARS`.
   * `Infinity`  → never persist (the tool already self-limits).
   */
  readonly maxResultSizeChars?: number | undefined;
  /**
   * Slice 5 / 决策 #97 — predicate the streaming scheduler queries to
   * decide whether overlapping `execute()` invocations are safe. Phase 5
   * leaves the slot present but unused. Declared as a method (not arrow
   * field) so the implicit bivariance keeps `Tool<{x}>` assignable to
   * `Tool<unknown>` — matching `execute()`'s existing behaviour.
   */
  isConcurrencySafe?(input: Input): boolean;
  /**
   * Slice 5 / 决策 #98 — optional UI rendering hooks. Six members, all
   * optional; missing hooks fall back to `defaultGetXxx` exports from
   * `src/tools/display-defaults.ts`.
   */
  readonly display?: ToolDisplayHooks<Input, Output> | undefined;
  /**
   * Slice 7.2 (决策 #100) — provenance metadata. Lets the orchestrator /
   * UI tell built-in tools apart from MCP- or plugin-supplied ones, and
   * preserves the original (un-prefixed) name for MCP tools so a
   * downstream router can locate the source tool definition.
   */
  readonly metadata?: ToolMetadata | undefined;
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
  /**
   * Slice 5 / 决策 #96 L3 — caller-known context window in tokens.
   * `runSoulTurn` forwards this verbatim into `runtime.kosong.chat({...})`
   * so `KosongAdapter` can probe for silent overflow (usage exceeding
   * the window). Omitted → silent-overflow detection stays a no-op.
   */
  contextWindow?: number | undefined;
}
