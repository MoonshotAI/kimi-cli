// Covers: §8 row 17 — end-to-end systemPrompt flow (方案 B)
// runSoulTurn reads context.systemPrompt and passes it to kosong.chat()
// via ChatParams.systemPrompt.

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { ChatParams, SoulConfig } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — systemPrompt passthrough (Fix 4)', () => {
  it('passes context.systemPrompt to kosong.chat() via ChatParams', async () => {
    const context = new FakeContextState({
      initialSystemPrompt: 'You are a helpful AI assistant.',
    });
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('hello')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [] };

    await runSoulTurn({ text: 'hi' }, config, context, runtime, sink, new AbortController().signal);

    expect(kosong.callCount).toBe(1);
    const chatParams: ChatParams = kosong.calls[0]!;
    expect(chatParams.systemPrompt).toBe('You are a helpful AI assistant.');
  });

  it('passes empty string when context.systemPrompt is empty', async () => {
    const context = new FakeContextState({
      initialSystemPrompt: '',
    });
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('hello')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [] };

    await runSoulTurn({ text: 'hi' }, config, context, runtime, sink, new AbortController().signal);

    const chatParams: ChatParams = kosong.calls[0]!;
    expect(chatParams.systemPrompt).toBe('');
  });
});
