/**
 * Hook system — shared type definitions (Slice 4 + Slice 3.6 scope, §9-C / §9-H).
 *
 * Defines the hook event types, executor interface, and result shapes.
 * Slice 4 shipped three tool-scoped events; Slice 3.6 extends the union
 * with lifecycle events ported from Python `kimi_cli/hooks/config.py`:
 *
 *   - `UserPromptSubmit` — fired before a new user prompt enters Soul.
 *     Matches Python's event of the same name; conceptually equivalent
 *     to a "turn start" trigger.
 *   - `Stop` — fired after a turn settles (before lifecycle drains to
 *     idle). Mirrors Python's `Stop` event; the optional `reason` field
 *     distinguishes `done` / `cancelled` / `error`.
 *   - `Notification` — fired when NotificationManager completes a
 *     fan-out. Payload carries notification type / title / severity so
 *     hook matchers can filter by notification class.
 *
 * Slice 3.6 deliberately defers `SubagentStart` / `SubagentStop` /
 * `PreCompact` / `PostCompact` / `SessionStart` / `SessionEnd` /
 * `StopFailure` / `PostToolUseFailure` because their trigger sites are
 * scattered across Phase 1/2 code paths we do not want to touch. The
 * union intentionally omits them so host code that registers a hook
 * for a non-supported event surfaces a TS error immediately.
 *
 * Phase 1 hardcodes two executor types: `command` and `wire`.
 */

import type { ToolCall, ToolResult } from '../soul/types.js';

// ── Hook event types (§9-H.2 + Slice 3.6 lifecycle extensions) ────────

export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'OnToolFailure'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'Notification';

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

// ── Slice 3.6 lifecycle events ─────────────────────────────────────────

/**
 * Fired when a user prompt is accepted by TurnManager.handlePrompt and
 * the WAL `user_message` record has been appended. Hooks cannot veto
 * the prompt in Slice 3.6 (no `blockAction` semantics for lifecycle
 * events) — `executeHooks` is invoked fire-and-forget so a slow hook
 * never delays handlePrompt's return to the caller.
 */
export interface UserPromptSubmitInput extends HookInputBase {
  readonly event: 'UserPromptSubmit';
  readonly prompt: string;
}

/**
 * Fired after the `turn_end` WAL record is durable. The `reason` field
 * is the same three-valued outcome TurnManager writes to the journal
 * (`done` / `cancelled` / `error`). The matcher is run against the
 * reason string so a hook can filter by e.g. `/^error$/`.
 */
export interface StopInput extends HookInputBase {
  readonly event: 'Stop';
  readonly reason: 'done' | 'cancelled' | 'error';
}

/**
 * Fired after NotificationManager completes its fan-out. The matcher is
 * run against `notificationType` so a hook can filter e.g. approval vs
 * tool-progress vs compaction notifications. Payload fields mirror the
 * Python `notification()` builder (`kimi_cli/hooks/events.py`).
 */
export interface NotificationInput extends HookInputBase {
  readonly event: 'Notification';
  readonly notificationType: string;
  readonly title: string;
  readonly body: string;
  readonly severity: string;
}

export type HookInput =
  | PreToolUseInput
  | PostToolUseInput
  | OnToolFailureInput
  | UserPromptSubmitInput
  | StopInput
  | NotificationInput;

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
