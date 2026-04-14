import { describe, it, expect } from 'vitest';
import type { WireEvent } from '../src/types.js';
import {
  EventStreamMerger,
  createCancellableStream,
  mergeEventStream,
} from '../src/event-stream.js';

// ── Helpers ───────────────────────────────────────────────────────────

function textEvent(text: string): WireEvent {
  return { type: 'ContentPart', part: { type: 'text', text } };
}

function thinkEvent(think: string): WireEvent {
  return { type: 'ContentPart', part: { type: 'think', think } };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) {
    items.push(item);
  }
  return items;
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

// ── EventStreamMerger ─────────────────────────────────────────────────

describe('EventStreamMerger', () => {
  it('merges consecutive text events', () => {
    const merger = new EventStreamMerger();

    expect(merger.push(textEvent('Hello'))).toEqual([]);
    expect(merger.push(textEvent(' World'))).toEqual([]);

    const flushed = merger.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(textEvent('Hello World'));
  });

  it('merges consecutive think events', () => {
    const merger = new EventStreamMerger();

    expect(merger.push(thinkEvent('Let me '))).toEqual([]);
    expect(merger.push(thinkEvent('think...'))).toEqual([]);

    const flushed = merger.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(thinkEvent('Let me think...'));
  });

  it('does not merge different content sub-types', () => {
    const merger = new EventStreamMerger();

    const result1 = merger.push(thinkEvent('thinking...'));
    expect(result1).toEqual([]);

    const result2 = merger.push(textEvent('response'));
    expect(result2).toHaveLength(1);
    expect(result2[0]).toEqual(thinkEvent('thinking...'));

    const flushed = merger.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(textEvent('response'));
  });

  it('flushes pending event when a non-ContentPart arrives', () => {
    const merger = new EventStreamMerger();

    expect(merger.push(textEvent('partial'))).toEqual([]);

    const turnEnd: WireEvent = { type: 'TurnEnd' };
    const result = merger.push(turnEnd);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(textEvent('partial'));
    expect(result[1]).toEqual(turnEnd);
  });

  it('passes through non-ContentPart events immediately', () => {
    const merger = new EventStreamMerger();

    const stepBegin: WireEvent = { type: 'StepBegin', n: 1 };
    const turnEnd: WireEvent = { type: 'TurnEnd' };

    const r1 = merger.push(stepBegin);
    expect(r1).toEqual([stepBegin]);

    const r2 = merger.push(turnEnd);
    expect(r2).toEqual([turnEnd]);

    expect(merger.flush()).toEqual([]);
  });

  it('handles empty flush', () => {
    const merger = new EventStreamMerger();
    expect(merger.flush()).toEqual([]);
  });

  it('resets state correctly', () => {
    const merger = new EventStreamMerger();
    merger.push(textEvent('buffered'));
    merger.reset();
    expect(merger.flush()).toEqual([]);
  });
});

// ── mergeEventStream ──────────────────────────────────────────────────

describe('mergeEventStream', () => {
  it('merges consecutive text events in an async iterable', async () => {
    const events: WireEvent[] = [
      { type: 'TurnBegin', userInput: 'hi' },
      { type: 'StepBegin', n: 1 },
      textEvent('Hello'),
      textEvent(' '),
      textEvent('World'),
      { type: 'TurnEnd' },
    ];

    const merged = await collect(mergeEventStream(fromArray(events)));

    expect(merged).toEqual([
      { type: 'TurnBegin', userInput: 'hi' },
      { type: 'StepBegin', n: 1 },
      textEvent('Hello World'),
      { type: 'TurnEnd' },
    ]);
  });

  it('handles empty stream', async () => {
    const merged = await collect(mergeEventStream(fromArray([])));
    expect(merged).toEqual([]);
  });

  it('handles stream with only non-mergeable events', async () => {
    const events: WireEvent[] = [
      { type: 'TurnBegin', userInput: 'test' },
      { type: 'StepBegin', n: 1 },
      { type: 'TurnEnd' },
    ];

    const merged = await collect(mergeEventStream(fromArray(events)));
    expect(merged).toEqual(events);
  });
});

// ── createCancellableStream ───────────────────────────────────────────

describe('createCancellableStream', () => {
  it('yields all values when not cancelled', async () => {
    const source = fromArray([1, 2, 3]);
    const stream = createCancellableStream(source);

    const result = await collect(stream.iterable);
    expect(result).toEqual([1, 2, 3]);
    expect(stream.cancelled).toBe(false);
  });

  it('stops yielding after cancel is called', async () => {
    async function* slowSource(): AsyncIterable<number> {
      yield 1;
      yield 2;
      // After cancel, should not reach here
      yield 3;
      yield 4;
    }

    const stream = createCancellableStream(slowSource());
    const items: number[] = [];

    for await (const item of stream.iterable) {
      items.push(item);
      if (item === 2) {
        stream.cancel();
      }
    }

    // After cancel, the iteration terminates at the next .next() call.
    // We got items 1 and 2 before cancel was called.
    expect(items).toEqual([1, 2]);
    expect(stream.cancelled).toBe(true);
  });

  it('reports cancelled state', () => {
    const stream = createCancellableStream(fromArray([]));
    expect(stream.cancelled).toBe(false);
    stream.cancel();
    expect(stream.cancelled).toBe(true);
  });

  it('returns empty immediately when cancelled before iteration', async () => {
    const stream = createCancellableStream(fromArray([1, 2, 3]));
    stream.cancel();

    const result = await collect(stream.iterable);
    expect(result).toEqual([]);
  });
});
