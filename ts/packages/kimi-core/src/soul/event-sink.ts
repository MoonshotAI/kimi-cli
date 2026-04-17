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
   * Phase 16 / 决策 #113 — SessionMetaService fans out a patch event after
   * each wire-truth write (title / tags / …). Derived-field mutations
   * (turn_count / last_model) MUST NOT emit this event — see §6.13.7 D6.
   */
  | {
      type: 'session_meta.changed';
      data: {
        patch: {
          title?: string | undefined;
          tags?: string[] | undefined;
          description?: string | undefined;
          archived?: boolean | undefined;
          color?: string | undefined;
        };
        source: 'user' | 'auto' | 'system';
      };
    }
  /**
   * Phase 16 — turn lifecycle tick consumed by SessionMetaService to
   * increment the derived `turn_count`. Carried through the EventBus so
   * SessionMetaService can subscribe without a back-channel (铁律 6 —
   * Soul does not learn about sessionMeta).
   */
  | { type: 'turn.end' }
  /**
   * Phase 16 — model change notification consumed by SessionMetaService
   * to derive `last_model`. Emitted alongside the existing
   * `model_changed` wire record.
   */
  | { type: 'model.changed'; data: { new_model: string } };

export interface EventSink {
  emit(event: SoulEvent): void;
}
