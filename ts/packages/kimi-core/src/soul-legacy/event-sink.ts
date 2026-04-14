import type { WireEvent } from '../wire-legacy/events.js';

export interface EventSink {
  emit(event: WireEvent): void;
}

export class CollectingSink implements EventSink {
  readonly events: WireEvent[] = [];

  emit(event: WireEvent): void {
    this.events.push(event);
  }

  findByType<T extends WireEvent['type']>(type: T): Extract<WireEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<WireEvent, { type: T }> => e.type === type);
  }

  clear(): void {
    this.events.length = 0;
  }
}
