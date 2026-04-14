/**
 * SessionEventBus — session-wide fan-out for Soul events (v2 §4.6 / §5.2).
 *
 * Two faces:
 *   1. Inward (to Soul): implements Slice 2 `EventSink` — `emit(event)`
 *      returns `void`, not `Promise<void>` (铁律 4). Soul calls it
 *      synchronously from inside `runSoulTurn`.
 *   2. Outward (to UI / transport / telemetry): `on(listener)` registers a
 *      sink, `off(listener)` removes it. Listeners also see `void` from
 *      `emit` — they have no way to back-pressure Soul.
 *
 * Contract guarantees (v2 §4.6.3):
 *   - Listener errors must NOT propagate back to Soul. The bus catches them
 *     internally so a bad UI listener cannot crash the agent loop.
 *   - Listeners MUST NOT call back into `ContextState` write methods or
 *     `JournalWriter.append` (铁律 5). Enforcement is convention-level.
 *   - `emit` fans out synchronously in listener registration order.
 */

import type { EventSink, SoulEvent } from '../soul/index.js';

export type SessionEventListener = (event: SoulEvent) => void;

export class SessionEventBus implements EventSink {
  private readonly listeners: SessionEventListener[] = [];

  emit(event: SoulEvent): void {
    // Iterate over a stable snapshot so a listener that mutates the bus
    // cannot shift the iteration it is part of.
    const snapshot = this.listeners.slice();
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        // §4.6.3 rule 3: listener errors must never reach Soul or block
        // siblings. Swallow silently.
      }
    }
  }

  on(listener: SessionEventListener): void {
    this.listeners.push(listener);
  }

  off(listener: SessionEventListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1) {
      this.listeners.splice(idx, 1);
    }
  }

  listenerCount(): number {
    return this.listeners.length;
  }
}
