/**
 * Event stream utilities for Wire events.
 *
 * Provides:
 * - `EventStreamMerger`: merges consecutive same-type ContentPart(text) events
 * - `createCancellableStream()`: wraps an AsyncIterable with cancellation support
 */

import type { WireEvent, ContentPartEvent } from './types.js';

// ── EventStreamMerger ─────────────────────────────────────────────────

/**
 * Merges consecutive ContentPart events of the same sub-type (e.g. text+text,
 * think+think) into a single event. This mirrors the Python `MergeableMixin`
 * in `wire/channel.py` which coalesces adjacent text deltas before they reach
 * the UI, reducing render churn.
 *
 * Non-ContentPart events pass through unchanged.
 */
export class EventStreamMerger {
  private pending: ContentPartEvent | null = null;

  /**
   * Push an event into the merger. Returns zero or one merged events.
   * Call `flush()` after the source stream ends to drain the last buffered event.
   */
  push(event: WireEvent): WireEvent[] {
    if (event.type !== 'ContentPart') {
      // Flush any buffered content event, then pass through
      const result: WireEvent[] = [];
      if (this.pending !== null) {
        result.push(this.pending);
        this.pending = null;
      }
      result.push(event);
      return result;
    }

    // ContentPart event -- try to merge with pending
    if (this.pending !== null && this.canMerge(this.pending, event)) {
      this.mergeInto(this.pending, event);
      return [];
    }

    // Different sub-type or no pending -- flush previous, buffer new
    const result: WireEvent[] = [];
    if (this.pending !== null) {
      result.push(this.pending);
    }
    this.pending = { type: 'ContentPart', part: { ...event.part } };
    return result;
  }

  /** Flush the last buffered event (if any). Call when the source stream ends. */
  flush(): WireEvent[] {
    if (this.pending !== null) {
      const result = [this.pending as WireEvent];
      this.pending = null;
      return result;
    }
    return [];
  }

  /** Reset the merger state. */
  reset(): void {
    this.pending = null;
  }

  private canMerge(a: ContentPartEvent, b: ContentPartEvent): boolean {
    return a.part.type === b.part.type && (a.part.type === 'text' || a.part.type === 'think');
  }

  private mergeInto(target: ContentPartEvent, source: ContentPartEvent): void {
    if (target.part.type === 'text' && source.part.type === 'text') {
      target.part = { type: 'text', text: target.part.text + source.part.text };
    } else if (target.part.type === 'think' && source.part.type === 'think') {
      target.part = { type: 'think', think: target.part.think + source.part.think };
    }
  }
}

// ── Cancellable Stream ────────────────────────────────────────────────

/**
 * A stream controller that wraps an AsyncIterable with cancellation.
 */
export interface CancellableStream<T> {
  /** The async iterable to consume. Terminates when cancelled or source ends. */
  iterable: AsyncIterable<T>;
  /** Signal cancellation. The iterable will end after the current yield. */
  cancel: () => void;
  /** Whether the stream has been cancelled. */
  readonly cancelled: boolean;
}

/**
 * Create a cancellable wrapper around an async iterable.
 *
 * The returned `iterable` will yield values from `source` until either:
 * - `source` is exhausted, or
 * - `cancel()` is called.
 */
export function createCancellableStream<T>(source: AsyncIterable<T>): CancellableStream<T> {
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = source[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<T>> {
          if (cancelled) {
            return { done: true, value: undefined };
          }
          const result = await iterator.next();
          if (cancelled) {
            return { done: true, value: undefined };
          }
          return result;
        },
        return(value?: T): Promise<IteratorResult<T>> {
          cancelled = true;
          if (iterator.return) {
            return iterator.return(value);
          }
          return Promise.resolve({ done: true as const, value: undefined as T });
        },
      };
    },
  };

  return {
    iterable,
    cancel,
    get cancelled(): boolean {
      return cancelled;
    },
  };
}

// ── Merged Stream Helper ──────────────────────────────────────────────

/**
 * Apply `EventStreamMerger` to an async iterable of WireEvents.
 * Returns a new async iterable that yields merged events.
 */
export async function* mergeEventStream(
  source: AsyncIterable<WireEvent>,
): AsyncIterable<WireEvent> {
  const merger = new EventStreamMerger();
  for await (const event of source) {
    const merged = merger.push(event);
    for (const e of merged) {
      yield e;
    }
  }
  const flushed = merger.flush();
  for (const e of flushed) {
    yield e;
  }
}
