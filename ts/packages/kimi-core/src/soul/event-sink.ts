/**
 * Soul EventSink — fire-and-forget UI / telemetry channel (§4.6 / §5.0 rule 4).
 *
 * `emit` returns `void`, not `Promise<void>`. This is a type-level rule
 * (§4.6.2): any future change must pass an ADR, otherwise a stray `await`
 * on a listener will silently degrade streaming to a synchronous bottleneck.
 *
 * Listeners must not persist events to wire.jsonl (§5.0 rule 5). Listener
 * errors are caught internally and never propagate back to Soul — a bad
 * listener must not be able to crash the agent loop.
 */

import type { ToolUpdate } from './types.js';

export type SoulEvent =
  | { type: 'step.begin'; step: number }
  | { type: 'step.end'; step: number }
  | { type: 'step.interrupted'; step: number; reason: string }
  | { type: 'content.delta'; delta: string }
  | { type: 'thinking.delta'; delta: string }
  /**
   * Phase 17 §B.6 — incremental tool_use streaming. KosongAdapter
   * emits one variant per fully-assembled tool_call (fallback path
   * when the provider doesn't chunk) or one per chunk when it does.
   * The wire event-bridge translates this into a `content.delta`
   * frame with `type: 'tool_call_part'` on the `ContentDeltaEventData`
   * union.
   */
  | {
      type: 'tool_call_part';
      tool_call_id: string;
      name?: string | undefined;
      arguments_chunk?: string | undefined;
    }
  | {
      type: 'tool.call';
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { type: 'tool.progress'; toolCallId: string; update: ToolUpdate }
  /**
   * Slice 4.2 — emitted by `runSoulTurn` immediately before every
   * `context.appendToolResult` call, regardless of whether the result
   * comes from a normal `tool.execute` return, a synthetic "tool not
   * found" / "schema parse error" / "beforeToolCall block" branch, or
   * an execute throw. Downstream consumers (TUI bridge) rely on this
   * event to close the `tool.call` → `tool.result` pair without having
   * to wrap each tool's execute.
   */
  | {
      type: 'tool.result';
      toolCallId: string;
      output: string;
      isError?: boolean | undefined;
    }
  | { type: 'compaction.begin' }
  | {
      type: 'compaction.end';
      tokensBefore?: number | undefined;
      tokensAfter?: number | undefined;
    }
  /**
   * Phase 17 §A.6 — SoulEvent parity for the `session.error` wire event.
   * Previously TurnManager bypassed the union via `as never`; the cast is
   * gone now that the variant exists explicitly. Emitted by orchestration
   * layers (TurnManager / SoulPlus facades) when a recoverable or terminal
   * error needs to reach the UI/transport as a typed frame. Soul layer
   * itself does not emit this (L7: no cross-component orchestration).
   */
  | {
      type: 'session.error';
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
  /**
   * Phase 17 §B.7 — HookEngine lifecycle observability. Emitted when a
   * hook matcher fires (triggered) and once each matching hook settles
   * (resolved). Lets the wire event-bridge forward hook runs to clients.
   */
  | {
      type: 'hook.triggered';
      event: string;
      matchers: readonly string[];
      matched_count: number;
    }
  | {
      type: 'hook.resolved';
      hook_id: string;
      outcome: 'ok' | 'error' | 'blocked';
    }
  /**
   * Phase 17 §A.2 — `status.update` wire event parity. The payload mirrors
   * `StatusUpdateEventData` (context_usage / token_usage / plan_mode /
   * model). Kept as an opaque `data` blob so the bridge can forward
   * without re-validating shape at the Soul boundary.
   */
  | {
      type: 'status.update';
      data: {
        context_usage?: unknown;
        token_usage?: unknown;
        plan_mode?: boolean | undefined;
        model?: string | undefined;
      };
    };

export interface EventSink {
  emit(event: SoulEvent): void;
}
