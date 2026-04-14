// Covers: compaction detection gate at the while-loop safe point (§5.1.7
// L1361-L1366). Slice 2 tests ONLY the negative path: a normal turn does
// NOT trigger compaction. The positive trigger (`shouldCompact` returning
// true for a specific tokenCountWithPending threshold) is implementer-
// defined and covered at the Slice 6 Compaction boundary.

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import {
  createFakeRuntime,
  createSpyCompactionProvider,
  createSpyJournalCapability,
  createSpyLifecycleGate,
} from './fixtures/fake-runtime.js';
import { EchoTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — compaction gate', () => {
  it('normal turn with zero token pressure does NOT call compactionProvider.run', async () => {
    const context = new FakeContextState({ initialTokenCountWithPending: 0 });
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done', { input: 5, output: 5 })],
    });
    const compactionProvider = createSpyCompactionProvider();
    const { runtime } = createFakeRuntime({ kosong, compactionProvider });
    const sink = new CollectingEventSink();

    await runSoulTurn(
      { text: 'go' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(compactionProvider.calls).toHaveLength(0);
  });

  it('normal turn does NOT call lifecycle.transitionTo', async () => {
    const context = new FakeContextState({ initialTokenCountWithPending: 0 });
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const lifecycle = createSpyLifecycleGate();
    const { runtime } = createFakeRuntime({ kosong, lifecycle });
    const sink = new CollectingEventSink();

    await runSoulTurn(
      { text: 'go' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    // Soul itself never transitions on a plain turn — only `runCompaction`
    // ever touches `lifecycle.transitionTo`.
    expect(lifecycle.transitions).toEqual([]);
  });

  it('normal turn does NOT call journal.rotate', async () => {
    const context = new FakeContextState({ initialTokenCountWithPending: 0 });
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const journal = createSpyJournalCapability();
    const { runtime } = createFakeRuntime({ kosong, journal });
    const sink = new CollectingEventSink();

    await runSoulTurn(
      { text: 'go' },
      { tools: [] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(journal.rotations).toHaveLength(0);
  });

  it('multi-step tool loop under normal pressure does NOT trigger compaction', async () => {
    const context = new FakeContextState({ initialTokenCountWithPending: 0 });
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'a' })], { input: 1, output: 1 }),
        makeToolUseResponse([makeToolCall('echo', { text: 'b' })], { input: 1, output: 1 }),
        makeEndTurnResponse('done', { input: 1, output: 1 }),
      ],
    });
    const compactionProvider = createSpyCompactionProvider();
    const lifecycle = createSpyLifecycleGate();
    const journal = createSpyJournalCapability();
    const { runtime } = createFakeRuntime({
      kosong,
      compactionProvider,
      lifecycle,
      journal,
    });
    const sink = new CollectingEventSink();

    await runSoulTurn(
      { text: 'go' },
      { tools: [new EchoTool()] },
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(compactionProvider.calls).toHaveLength(0);
    expect(lifecycle.transitions).toEqual([]);
    expect(journal.rotations).toHaveLength(0);
    expect(sink.count('compaction.begin')).toBe(0);
    expect(sink.count('compaction.end')).toBe(0);
  });
});
