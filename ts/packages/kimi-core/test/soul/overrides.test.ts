// Covers: SoulTurnOverrides (§5.1.4 / §5.1.7 L1346-L1351 L1393-L1406).
// - model override → kosong.chat receives the override, not context.model
// - activeTools filter → LLM sees only the whitelisted tool subset
// - effort override → kosong.chat receives it

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { SoulConfig, SoulTurnOverrides } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { EchoTool, FailingTool, ProgressTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — overrides', () => {
  it('overrides.model is passed to kosong.chat instead of context.model', async () => {
    const context = new FakeContextState({ initialModel: 'context-model-a' });
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const overrides: SoulTurnOverrides = { model: 'override-model-b' };

    await runSoulTurn(
      { text: 'go' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
      overrides,
    );

    expect(kosong.calls).toHaveLength(1);
    expect(kosong.calls[0]?.model).toBe('override-model-b');
  });

  it('no overrides → kosong.chat sees context.model', async () => {
    const context = new FakeContextState({ initialModel: 'the-real-model' });
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

    expect(kosong.calls[0]?.model).toBe('the-real-model');
  });

  it('overrides.activeTools filters the LLM-visible tool list to the whitelist', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = {
      tools: [new EchoTool(), new FailingTool(), new ProgressTool()],
    };
    const overrides: SoulTurnOverrides = { activeTools: ['echo', 'progress'] };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
      overrides,
    );

    const names = kosong.calls[0]?.tools.map((t) => t.name) ?? [];
    expect(names.toSorted()).toEqual(['echo', 'progress']);
  });

  it('undefined overrides.activeTools → all configured tools are visible', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = {
      tools: [new EchoTool(), new ProgressTool()],
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const names = kosong.calls[0]?.tools.map((t) => t.name) ?? [];
    expect(names.toSorted()).toEqual(['echo', 'progress']);
  });

  it('empty overrides.activeTools → no tools visible to the LLM', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };
    const overrides: SoulTurnOverrides = { activeTools: [] };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
      overrides,
    );

    expect(kosong.calls[0]?.tools).toEqual([]);
  });

  it('overrides.effort is forwarded to kosong.chat', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const overrides: SoulTurnOverrides = { effort: 'high' };

    await runSoulTurn(
      { text: 'go' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
      overrides,
    );

    expect(kosong.calls[0]?.effort).toBe('high');
  });
});
