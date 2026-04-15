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
  | { type: 'compaction.begin' }
  | {
      type: 'compaction.end';
      tokensBefore?: number | undefined;
      tokensAfter?: number | undefined;
    };

export interface EventSink {
  emit(event: SoulEvent): void;
}
