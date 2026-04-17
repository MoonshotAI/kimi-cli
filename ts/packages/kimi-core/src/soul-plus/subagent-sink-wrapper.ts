/**
 * createSubagentSinkWrapper — Phase 6 / 决策 #88 / v2 §6.5.
 *
 * The wrapper is the seam between a subagent (or teammate / remote) Soul's
 * `EventSink.emit(event)` call and the session-wide `SessionEventBus`. It
 * replaces the pre-Phase-6 `createBubblingSink`, which nested every child
 * event back into the parent wire under a `subagent_event` envelope.
 *
 * Contract (locked by `subagent-sink-wrapper.test.ts`):
 *   - `emit` returns `void` (铁律 4 — fire-and-forget; the bus must never
 *     back-pressure Soul).
 *   - Every emitted `SoulEvent` is forwarded to `parentEventBus` via
 *     `emitWithSource(event, source)` so listeners can attribute it back
 *     to the originating agent.
 *   - The wrapper itself does NOT persist anything to `childJournalWriter`.
 *     Durable records (`assistant_message`, `tool_result`, …) are owned by
 *     `ContextState.appendXxx()` on the child side, which writes through
 *     the child's own JournalWriter. Re-emitting them here would create a
 *     double-write that drifts from the canonical projection (铁律 5).
 *   - `source` is a transport-only envelope (§4.8.2). It MUST never reach
 *     wire.jsonl; that invariant is upheld by `SessionEventBus.emitWithSource`,
 *     which copies the envelope onto a shallow `BusEvent` clone rather than
 *     mutating the input.
 *   - Listener exceptions on the parent bus do not escape the wrapper —
 *     the bus's own `safeDispatch` isolates them; we additionally swallow
 *     synchronous throws here as a defense-in-depth measure.
 *
 * `childJournalWriter` is part of the public dependency surface (and is
 * deliberately required by the test contract) so future audit hooks can
 * attach without changing the signature. The Phase 6 implementation does
 * not call it.
 */

import type { EventSink, SoulEvent } from '../soul/index.js';
import type { JournalWriter } from '../storage/journal-writer.js';
import type { EventSource, SessionEventBus } from './session-event-bus.js';

export interface SubagentSinkWrapperDeps {
  /**
   * The child agent's own `JournalWriter`. The Phase 6 wrapper does NOT
   * write through it (see file header — durable records are owned by
   * `ContextState.appendXxx()` on the child side). The field is kept on
   * the dependency surface so future audit / counter hooks can attach
   * without changing the public signature, and so the contract test
   * (`subagent-sink-wrapper.test.ts`) can pin the spy shape.
   */
  readonly childJournalWriter: JournalWriter;
  readonly parentEventBus: SessionEventBus;
  readonly source: EventSource;
}

export function createSubagentSinkWrapper(deps: SubagentSinkWrapperDeps): EventSink {
  // Intentionally NOT destructuring `childJournalWriter` — see its JSDoc
  // on `SubagentSinkWrapperDeps`. The wrapper has no current use for it;
  // dropping it from the destructure keeps lint quiet without a `void`
  // expression and avoids implying we'll write to it later by accident.
  const { parentEventBus, source } = deps;
  return {
    emit(event: SoulEvent): void {
      try {
        parentEventBus.emitWithSource(event, source);
      } catch {
        // Bus dispatch already isolates listeners; the catch here is a
        // belt-and-braces guard so a bus regression can never propagate
        // out of EventSink.emit and crash the child Soul loop.
      }
    },
  };
}
