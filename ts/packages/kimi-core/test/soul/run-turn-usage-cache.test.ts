// Covers: §8 row 16 — TurnResult.usage must accumulate all 4 dimensions
// (input / output / cache_read / cache_write) across multi-step turns.
//
// Slice 2.0 Fix 3 regression tests.

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { SoulConfig } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { EchoTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — cache usage accumulation (Fix 3)', () => {
  it('accumulates cache_read and cache_write across multi-step turn', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'a' })], {
          input: 100,
          output: 50,
          cache_read: 20,
          cache_write: 10,
        }),
        makeToolUseResponse([makeToolCall('echo', { text: 'b' })], {
          input: 80,
          output: 30,
          cache_read: 15,
          cache_write: 5,
        }),
        makeEndTurnResponse('done', {
          input: 60,
          output: 20,
          cache_read: 10,
          cache_write: 0,
        }),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    const result = await runSoulTurn(
      { text: 'test cache' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(result.steps).toBe(3);
    expect(result.usage.input).toBe(100 + 80 + 60);
    expect(result.usage.output).toBe(50 + 30 + 20);
    expect(result.usage.cache_read).toBe(20 + 15 + 10);
    expect(result.usage.cache_write).toBe(10 + 5 + 0);
  });

  it('does not produce NaN when steps lack cache fields', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'a' })], {
          input: 50,
          output: 25,
          // no cache_read / cache_write
        }),
        makeEndTurnResponse('done', {
          input: 30,
          output: 15,
          cache_read: 5,
          // no cache_write
        }),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    const result = await runSoulTurn(
      { text: 'no cache' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(result.usage.input).toBe(80);
    expect(result.usage.output).toBe(40);
    expect(result.usage.cache_read).toBe(5);
    expect(result.usage.cache_write).toBe(0);
    // Critical: must not be NaN
    expect(Number.isNaN(result.usage.cache_read)).toBe(false);
    expect(Number.isNaN(result.usage.cache_write)).toBe(false);
  });

  it('single-step turn with cache fields reports them correctly', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeEndTurnResponse('hello', {
          input: 200,
          output: 100,
          cache_read: 50,
          cache_write: 25,
        }),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [] };

    const result = await runSoulTurn(
      { text: 'hi' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(result.usage.cache_read).toBe(50);
    expect(result.usage.cache_write).toBe(25);
  });
});
