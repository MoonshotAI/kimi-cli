/**
 * Hook system — shared type definitions (Slice 4 scope, §9-C / §9-H).
 *
 * Defines the hook event types, executor interface, and result shapes.
 * Phase 1 hardcodes two executor types: `command` and `wire`.
 */

import type { ToolCall, ToolResult } from '../soul/types.js';

// ── Hook event types (§9-H.2) ──────────────────────────────────────────

export type HookEventType = 'PreToolUse' | 'PostToolUse' | 'OnToolFailure';

// ── Hook input (§9-H.2 + HookInputBase) ────────────────────────────────

export interface HookInputBase {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepNumber?: number | undefined;
  readonly agentId: string;
}

export interface PreToolUseInput extends HookInputBase {
  readonly event: 'PreToolUse';
  readonly toolCall: ToolCall;
  readonly args: unknown;
}

export interface PostToolUseInput extends HookInputBase {
  readonly event: 'PostToolUse';
  readonly toolCall: ToolCall;
  readonly args: unknown;
  readonly result: ToolResult;
}

export interface OnToolFailureInput extends HookInputBase {
  readonly event: 'OnToolFailure';
  readonly toolCall: ToolCall;
  readonly args: unknown;
  readonly error: Error;
}

export type HookInput = PreToolUseInput | PostToolUseInput | OnToolFailureInput;

// ── Hook config (§9-C.2) ───────────────────────────────────────────────

export interface HookConfigBase {
  readonly event: HookEventType;
  readonly matcher?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface CommandHookConfig extends HookConfigBase {
  readonly type: 'command';
  readonly command: string;
  readonly cwd?: string | undefined;
}

export interface WireHookConfig extends HookConfigBase {
  readonly type: 'wire';
  readonly subscriptionId: string;
}

export type HookConfig = CommandHookConfig | WireHookConfig;

// ── Hook result (§9-C.1) ───────────────────────────────────────────────

export interface HookResult {
  ok: boolean;
  reason?: string | undefined;
  blockAction?: boolean | undefined;
  additionalContext?: string | undefined;
  updatedInput?: Record<string, unknown> | undefined;
}

// ── Aggregated result (§9-C.3) ─────────────────────────────────────────

export interface AggregatedHookResult {
  blockAction: boolean;
  reason?: string | undefined;
  additionalContext: string[];
}

// ── Hook executor interface (§9-C.1) ───────────────────────────────────

export interface HookExecutor {
  readonly type: string;
  execute(hook: HookConfig, input: HookInput, signal: AbortSignal): Promise<HookResult>;
}
