/**
 * Covers: `SessionEventBus` (v2 §4.6 / §5.2 — fire-and-forget fan-out).
 *
 * Pins the "`emit` returns `void`, not `Promise`" type contract (铁律 4),
 * listener registration/deregistration semantics, fan-out ordering, and
 * the "listener errors never propagate to Soul" guarantee (§4.6.3).
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { SessionEventBus } from '../../src/soul-plus/index.js';
import type { SoulEvent } from '../../src/soul/index.js';

describe('SessionEventBus', () => {
  it('emit returns void (type contract — bus is the EventSink for Soul)', () => {
    const bus = new SessionEventBus();
    // Runtime assertion: `emit` returns nothing (i.e. `undefined`). We
    // call it on its own line so the void return is not placed inside
    // another expression.
    bus.emit({ type: 'step.begin', step: 1 });
    // Type-level assertion: lock the signature to `void`, independent of
    // any particular instance. Referencing `bus.emit` as an unbound
    // method would trip `typescript-eslint(unbound-method)`.
    expectTypeOf<typeof SessionEventBus.prototype.emit>().returns.toBeVoid();
  });

  it('starts with zero listeners', () => {
    const bus = new SessionEventBus();
    expect(bus.listenerCount()).toBe(0);
  });

  it('fans an event out to every registered listener', () => {
    const bus = new SessionEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();

    bus.on(a);
    bus.on(b);
    bus.on(c);

    const event: SoulEvent = { type: 'content.delta', delta: 'hello' };
    bus.emit(event);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(event);
    expect(b).toHaveBeenCalledWith(event);
    expect(c).toHaveBeenCalledWith(event);
  });

  it('tracks listener count across on / off', () => {
    const bus = new SessionEventBus();
    const listener = (): void => {};
    bus.on(listener);
    expect(bus.listenerCount()).toBe(1);
    bus.on(() => {});
    expect(bus.listenerCount()).toBe(2);
    bus.off(listener);
    expect(bus.listenerCount()).toBe(1);
  });

  it('off removes a listener so it no longer sees events', () => {
    const bus = new SessionEventBus();
    const received: SoulEvent[] = [];
    const listener = (e: SoulEvent): void => {
      received.push(e);
    };
    bus.on(listener);
    bus.emit({ type: 'step.begin', step: 1 });
    expect(received).toHaveLength(1);

    bus.off(listener);
    bus.emit({ type: 'step.begin', step: 2 });
    expect(received).toHaveLength(1);
  });

  it('off is a no-op when the listener was never registered', () => {
    const bus = new SessionEventBus();
    expect(() => {
      bus.off(() => {});
    }).not.toThrow();
    expect(bus.listenerCount()).toBe(0);
  });

  it('listener errors do not propagate to emit — the bad listener is isolated', () => {
    const bus = new SessionEventBus();
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    bus.on(bad);
    bus.on(good);

    expect(() => {
      bus.emit({ type: 'step.end', step: 1 });
    }).not.toThrow();
    // good listener must still fire even though bad threw
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('a listener that throws does not stop subsequent listeners in the same emit', () => {
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

    bus.emit({ type: 'step.begin', step: 1 });
    expect(calls).toEqual(['first', 'second', 'third']);
  });

  it('emitting with zero listeners is safe', () => {
    const bus = new SessionEventBus();
    expect(() => {
      bus.emit({ type: 'step.begin', step: 1 });
    }).not.toThrow();
  });

  it('delivers all event kinds verbatim (discriminated union passthrough)', () => {
    const bus = new SessionEventBus();
    const seen: SoulEvent[] = [];
    bus.on((e) => {
      seen.push(e);
    });

    const events: SoulEvent[] = [
      { type: 'step.begin', step: 1 },
      { type: 'content.delta', delta: 'foo' },
      { type: 'tool.call', toolCallId: 't1', name: 'echo', args: { text: 'hi' } },
      {
        type: 'tool.progress',
        toolCallId: 't1',
        update: { kind: 'stdout', text: 'x' },
      },
      { type: 'step.end', step: 1 },
      { type: 'compaction.begin' },
      { type: 'compaction.end', tokensBefore: 100, tokensAfter: 20 },
    ];
    for (const e of events) bus.emit(e);

    expect(seen).toEqual(events);
  });
});
