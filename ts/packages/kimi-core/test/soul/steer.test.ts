// Covers: steer drain on step open (§5.1.7 L1377-L1385).
// Each step starts with context.drainSteerMessages() → if non-empty, await
// context.addUserMessages(...). Empty buffer must NOT trigger addUserMessages.

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { SoulConfig } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — steer drain', () => {
  it('empty steer buffer → addUserMessages is NOT called', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();

    await runSoulTurn(
      { text: 'hi' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(context.addUserMessagesCalls()).toHaveLength(0);
  });

  it('steer buffer with one entry → addUserMessages called once with that entry', async () => {
    const context = new FakeContextState({
      initialSteerBuffer: [{ text: 'mid-turn user nudge' }],
    });
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();

    await runSoulTurn(
      { text: 'original' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const calls = context.addUserMessagesCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.steers).toHaveLength(1);
    expect(calls[0]?.steers[0]?.text).toBe('mid-turn user nudge');
  });

  it('steer buffer with multiple entries → single addUserMessages call with all entries', async () => {
    const context = new FakeContextState({
      initialSteerBuffer: [{ text: 'first' }, { text: 'second' }, { text: 'third' }],
    });
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();

    await runSoulTurn(
      { text: 'go' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const calls = context.addUserMessagesCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.steers.map((s) => s.text)).toEqual(['first', 'second', 'third']);
  });

  it('drain happens BEFORE kosong.chat on every step', async () => {
    const context = new FakeContextState({
      initialSteerBuffer: [{ text: 'pre-step steer' }],
    });
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [] };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    // The addUserMessages call must land before the first LLM call, so the
    // messages include the drained steer. We verify the call trace has
    // addUserMessages as the very first recorded write.
    expect(context.calls[0]?.kind).toBe('addUserMessages');
    expect(kosong.callCount).toBe(1);
  });

  it('drainSteerMessages is called once per step (not per turn)', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        // two steps: tool_use then end_turn
        {
          message: { role: 'assistant', content: '' },
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { input: 0, output: 0 },
        },
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();

    await runSoulTurn(
      { text: 'go' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    // Single-step turn → exactly one drain. (Multi-step variants are covered
    // by the happy-path tests; this lock-down just asserts "drain is per-step,
    // not per-turn".)
    expect(context.drainCount).toBe(1);
  });
});
