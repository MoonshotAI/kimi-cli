/**
 * Covers: `SessionEventBus.emitWithSource(event, source)` + `BusEvent`
 * signal passthrough (Phase 6 / 决策 #88 / v2 §4.8.2 / §D.6.1).
 *
 * Design intent:
 *   - `BusEvent = SoulEvent & { source?: EventSource }` — the transport-layer
 *     envelope. Main-agent events go through plain `emit(event)` and reach
 *     listeners with `source === undefined`. Subagent / teammate events go
 *     through `emitWithSource(event, source)` and reach listeners with the
 *     injected `source` attached.
 *   - The `source` field lives ONLY in the EventBus transport layer. It is
 *     NEVER persisted (see subagent-independent-wire.test.ts for the
 *     counterpart assertion that wire.jsonl has no source field).
 *   - Bus respects the four load-bearing invariants from the v1 bus:
 *     - `emit` returns `void` (铁律 4)
 *     - A listener throwing / rejecting does not crash sibling listeners
 *     - Sync and async listener errors are isolated
 *     - Listener registration order is preserved
 *
 * All tests are red bar until `emitWithSource` lands.
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { BusEvent, EventSource } from '../../src/soul-plus/session-event-bus.js';
import { SessionEventBus } from '../../src/soul-plus/index.js';
import type { SoulEvent } from '../../src/soul/index.js';

describe('SessionEventBus.emitWithSource (§4.8.2 / 决策 #88)', () => {
  it('listener receives the event with the injected source attached', () => {
    const bus = new SessionEventBus();
    const seen: BusEvent[] = [];
    bus.on((e) => {
      seen.push(e);
    });

    const source: EventSource = { id: 'sub_abc', kind: 'subagent', name: 'code-reviewer' };
    bus.emitWithSource({ type: 'content.delta', delta: 'hello' }, source);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('content.delta');
    expect(seen[0]?.source).toEqual(source);
  });

  it('plain emit(event) delivers source === undefined (main agent events)', () => {
    const bus = new SessionEventBus();
    const seen: BusEvent[] = [];
    bus.on((e) => {
      seen.push(e);
    });

    bus.emit({ type: 'step.begin', step: 1 });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBeUndefined();
  });

  it('emitWithSource does not mutate the original SoulEvent argument', () => {
    const bus = new SessionEventBus();
    const original: SoulEvent = { type: 'content.delta', delta: 'x' };
    bus.on(() => {});
    bus.emitWithSource(original, { id: 'sub_1', kind: 'subagent' });
    // Source must never leak back onto the caller's argument. The bus
    // attaches the envelope in a copy, so `original` stays clean.
    expect((original as Record<string, unknown>)['source']).toBeUndefined();
  });

  it('main-agent emit and subagent-tagged emit interleave correctly', () => {
    const bus = new SessionEventBus();
    const seen: BusEvent[] = [];
    bus.on((e) => {
      seen.push(e);
    });

    bus.emit({ type: 'step.begin', step: 1 }); // main
    bus.emitWithSource(
      { type: 'content.delta', delta: 'child-a' },
      { id: 'sub_a', kind: 'subagent', name: 'explorer' },
    );
    bus.emit({ type: 'step.end', step: 1 }); // main
    bus.emitWithSource(
      { type: 'content.delta', delta: 'child-b' },
      { id: 'sub_b', kind: 'subagent', name: 'code-reviewer' },
    );

    expect(seen).toHaveLength(4);
    expect(seen[0]?.source).toBeUndefined();
    expect(seen[1]?.source?.id).toBe('sub_a');
    expect(seen[2]?.source).toBeUndefined();
    expect(seen[3]?.source?.id).toBe('sub_b');
  });

  it('fans out a sourced event to every registered listener', () => {
    const bus = new SessionEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on(a);
    bus.on(b);

    const source: EventSource = { id: 'sub_1', kind: 'subagent' };
    bus.emitWithSource({ type: 'step.begin', step: 1 }, source);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    const aArg = a.mock.calls[0]?.[0] as BusEvent;
    const bArg = b.mock.calls[0]?.[0] as BusEvent;
    expect(aArg.source).toEqual(source);
    expect(bArg.source).toEqual(source);
  });

  it('teammate kind is supported on the EventSource union', () => {
    const bus = new SessionEventBus();
    const seen: BusEvent[] = [];
    bus.on((e) => {
      seen.push(e);
    });

    const source: EventSource = { id: 'ses_teammate_1', kind: 'teammate', name: 'planner' };
    bus.emitWithSource({ type: 'step.begin', step: 1 }, source);
    expect(seen[0]?.source?.kind).toBe('teammate');
  });

  it('remote kind is supported on the EventSource union', () => {
    const bus = new SessionEventBus();
    const seen: BusEvent[] = [];
    bus.on((e) => {
      seen.push(e);
    });

    const source: EventSource = { id: 'bridge_cc_1', kind: 'remote', name: 'cc-teammate' };
    bus.emitWithSource({ type: 'step.begin', step: 1 }, source);
    expect(seen[0]?.source?.kind).toBe('remote');
  });
});

describe('SessionEventBus.emitWithSource — listener isolation', () => {
  it('a sync listener that throws does not stop subsequent listeners', () => {
    const bus = new SessionEventBus();
    const calls: string[] = [];
    bus.on(() => {
      calls.push('first');
    });
    bus.on(() => {
      calls.push('second');
      throw new Error('boom');
    });
    bus.on(() => {
      calls.push('third');
    });

    bus.emitWithSource(
      { type: 'step.begin', step: 1 },
      { id: 'sub_1', kind: 'subagent' },
    );
    expect(calls).toEqual(['first', 'second', 'third']);
  });

  it('a sync listener throw does not propagate out of emitWithSource', () => {
    const bus = new SessionEventBus();
    bus.on(() => {
      throw new Error('boom');
    });
    expect(() => {
      bus.emitWithSource(
        { type: 'step.begin', step: 1 },
        { id: 'sub_1', kind: 'subagent' },
      );
    }).not.toThrow();
  });

  it('an async listener rejection does NOT escape as an unhandled rejection', async () => {
    const bus = new SessionEventBus();
    bus.on(async () => {
      throw new Error('async listener failure');
    });
    bus.on(async () => {
      await Promise.resolve();
      throw new Error('delayed async listener failure');
    });
    const good = vi.fn();
    bus.on(good);

    const unhandled: unknown[] = [];
    const handler = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', handler);
    try {
      bus.emitWithSource(
        { type: 'step.begin', step: 1 },
        { id: 'sub_1', kind: 'subagent' },
      );
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          setImmediate(() => {
            resolve();
          });
        });
      });
      expect(unhandled).toHaveLength(0);
      expect(good).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });
});

describe('SessionEventBus.emitWithSource — type contract (铁律 4)', () => {
  it('emitWithSource returns void (not Promise<void>)', () => {
    // Type-level assertion: the signature must stay synchronous; Soul /
    // wrappers cannot be back-pressured by listener progress.
    expectTypeOf<typeof SessionEventBus.prototype.emitWithSource>().returns.toBeVoid();
  });

  it('concrete runtime call returns undefined (not a promise)', () => {
    const bus = new SessionEventBus();
    const r: void = bus.emitWithSource(
      { type: 'step.begin', step: 1 },
      { id: 'sub_1', kind: 'subagent' },
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    r;
    // If the implementation returned a promise, `r` would not be `void`
    // compatible. The assignment itself is the assertion.
    expect(r).toBeUndefined();
  });
});
