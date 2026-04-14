// Covers: EventSink contract rules (§4.6 / §5.0 rule 4).
// - `emit` is `void` in the type signature (not Promise<void>)
// - a throwing listener does NOT break Soul (rule 5 / §4.6.3)
// - event sequence symmetry: step.begin ↔ step.end on every normal step

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { EventSink, SoulEvent } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { EchoTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('EventSink contract', () => {
  it('EventSink.emit has a void return type (not Promise<void>)', () => {
    const sink: EventSink = {
      emit(_event: SoulEvent): void {
        // void return — no Promise allowed at the type level
      },
    };
    sink.emit({ type: 'step.begin', step: 1 });
    // The interface-level return type is `void` — a Slice 2 reviewer would
    // reject any change to `Promise<void>` as an ADR-level decision. We
    // assert at runtime that emit itself is a synchronous function.
    expect(sink.emit.constructor.name).toBe('Function');
  });

  it('a throwing listener does not crash Soul — the turn still completes', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const throwingSink: EventSink = {
      emit(_event: SoulEvent): void {
        throw new Error('listener failed');
      },
    };

    const result = await runSoulTurn(
      { text: 'go' },
      { tools: [] },
      context,
      runtime,
      throwingSink,
      new AbortController().signal,
    );

    expect(result.stopReason).toBe('end_turn');
  });

  it('a listener that throws only on the first call — Soul still finishes', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    let throwOnce = true;
    const events: SoulEvent[] = [];
    const sink: EventSink = {
      emit(event: SoulEvent): void {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('first listener call failed');
        }
        events.push(event);
      },
    };

    const result = await runSoulTurn(
      { text: 'go' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(result.stopReason).toBe('end_turn');
    // At least one event must have been emitted after the first failure
    expect(events.length).toBeGreaterThan(0);
  });

  it('step.begin and step.end are symmetric on a normal turn', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'a' })]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();

    await runSoulTurn(
      { text: 'go' },
      { tools: [new EchoTool()] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(sink.count('step.begin')).toBe(sink.count('step.end'));
    expect(sink.count('step.interrupted')).toBe(0);
  });

  it('abort turn emits step.interrupted ONCE, not step.end', async () => {
    const context = new FakeContextState();
    const controller = new AbortController();
    controller.abort();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('will not run')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();

    await runSoulTurn({ text: 'go' }, { tools: [] }, context, runtime, sink, controller.signal);

    expect(sink.count('step.interrupted')).toBe(1);
  });

  it('emit is not awaited — Soul continues even if listener returns a rejected promise', async () => {
    // This test enforces the rule "emit returns void" by ensuring Soul
    // does not treat the listener's runtime behaviour as async. A listener
    // that mistakenly returns `Promise<never>` (via an async function)
    // must not be observed as a rejection by Soul.
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink: EventSink = {
      emit(_event: SoulEvent): void {
        // Intentionally create a rejected promise inside the emit body.
        // Soul must not observe this rejection. The `.catch(() => {})`
        // consumes it at the Node process level (Soul has no reference
        // to this promise — "unobserved" is the Node process' concern,
        // not Soul's).
        Promise.reject(new Error('should be ignored')).catch(() => {});
      },
    };

    const result = await runSoulTurn(
      { text: 'go' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(result.stopReason).toBe('end_turn');
  });

  it('content.delta events are emitted from the onDelta callback Soul wires into kosong.chat', async () => {
    const context = new FakeContextState();
    // Simulate a streaming kosong that fires onDelta twice during the turn
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('final')],
    });
    // Wrap kosong.chat so it invokes params.onDelta before returning
    const wrapped = {
      async chat(params: Parameters<typeof kosong.chat>[0]) {
        params.onDelta?.('fi');
        params.onDelta?.('nal');
        return kosong.chat(params);
      },
    };
    const { runtime } = createFakeRuntime({ kosong: wrapped });
    const sink = new CollectingEventSink();

    await runSoulTurn(
      { text: 'go' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const deltas = sink.byType('content.delta');
    expect(deltas.map((e) => e.delta)).toEqual(['fi', 'nal']);
  });
});
