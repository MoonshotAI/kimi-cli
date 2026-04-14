/**
 * Test helper — an EventSink that records every event into an array for
 * later assertion. Used by the run-turn-* and event-sink-contract tests.
 */

import type { EventSink, SoulEvent } from '../../../src/soul/index.js';

export class CollectingEventSink implements EventSink {
  readonly events: SoulEvent[] = [];
  listenerError: unknown = null;
  throwOnEmit = false;

  emit(event: SoulEvent): void {
    if (this.throwOnEmit) {
      // Soul must swallow listener errors (§4.6.3 rule 3). We expose this
      // knob so tests can verify Soul keeps running even when emit throws.
      throw new Error('listener failed');
    }
    this.events.push(event);
  }

  typesIn(): SoulEvent['type'][] {
    return this.events.map((e) => e.type);
  }

  count(type: SoulEvent['type']): number {
    return this.events.filter((e) => e.type === type).length;
  }

  byType<T extends SoulEvent['type']>(type: T): Extract<SoulEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<SoulEvent, { type: T }> => e.type === type);
  }
}
