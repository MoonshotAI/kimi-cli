/**
 * Covers: `tool.result` SoulEvent emission from `runSoulTurn` on the
 * normal path AND every synthetic path (Slice 4.2 / §4.6).
 *
 * Before Slice 4.2, the TUI bridge wrapped every tool to capture a
 * synthetic `tool.result` wire message after `execute` settled. That
 * missed the three `runSoulTurn` internal synthesiser branches —
 * "tool not found", "zod parse error", "beforeToolCall block" — so
 * the UI's `tool.call` → `tool.result` pair hung open. Slice 4.2
 * makes `tool.result` a first-class `SoulEvent` variant and emits it
 * right before every `context.appendToolResult` call inside
 * `runSoulTurn`. This test pins that the event fires for all paths.
 */

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { SoulConfig } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { EchoTool, FailingTool, StrictArgsTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — tool.result SoulEvent', () => {
  it('emits tool.result on the normal execute path', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'call_ok')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const results = sink.byType('tool.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_ok',
    });
    // Normal execute path does not mark is_error true.
    expect(results[0]?.isError).toBeUndefined();
  });

  it('emits tool.result on the "tool not found" synthetic path', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('nope', { x: 1 }, 'call_missing')]),
        makeEndTurnResponse('ok'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const results = sink.byType('tool.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_missing',
      isError: true,
    });
    expect(results[0]?.output).toMatch(/not found/i);
  });

  it('emits tool.result on the zod parse failure synthetic path', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('strict', { value: 'bad' }, 'call_parse')]),
        makeEndTurnResponse('ok'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new StrictArgsTool()] };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const results = sink.byType('tool.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_parse',
      isError: true,
    });
    expect(results[0]?.output).toMatch(/invalid input/i);
  });

  it('emits tool.result on the beforeToolCall block path', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'denied' }, 'call_block')]),
        makeEndTurnResponse('ok'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = {
      tools: [new EchoTool()],
      beforeToolCall: async () => ({ block: true, reason: 'permission denied' }),
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const results = sink.byType('tool.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_block',
      isError: true,
      output: 'permission denied',
    });
  });

  it('emits tool.result on the execute-throw synthetic path', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('fail', { x: 1 }, 'call_throw')]),
        makeEndTurnResponse('ok'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new FailingTool()] };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const results = sink.byType('tool.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_throw',
      isError: true,
    });
  });

  it('emits tool.result on the beforeToolCall-throw synthetic path', async () => {
    // Mirrors Slice 4.1 M1 fix: a non-abort throw from beforeToolCall
    // lands in the `hookResult = undefined` catch branch that persists
    // a synthetic error tool_result. Slice 4.2 must fire tool.result
    // for that branch too.
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'oops' }, 'call_before_throw')]),
        makeEndTurnResponse('ok'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = {
      tools: [new EchoTool()],
      beforeToolCall: async () => {
        throw new Error('pre-hook exploded');
      },
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const results = sink.byType('tool.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_before_throw',
      isError: true,
    });
    expect(results[0]?.output).toMatch(/beforeToolCall hook failed/);
    expect(results[0]?.output).toMatch(/pre-hook exploded/);
  });

  it('emits tool.result on the afterToolCall non-abort throw synthetic path', async () => {
    // afterToolCall is a redaction/truncation seam: when it throws a
    // non-abort error Soul MUST NOT persist the raw tool output (the
    // hook may have been the exact thing that was supposed to strip
    // sensitive content). Instead it writes a synthetic error
    // tool_result AND — Slice 4.2 — fires a matching tool.result
    // event that surfaces the hook failure, not the raw output.
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'SENSITIVE' }, 'call_after_throw')]),
        makeEndTurnResponse('ok'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = {
      tools: [new EchoTool()],
      afterToolCall: async () => {
        throw new Error('redaction hook crashed');
      },
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const results = sink.byType('tool.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_after_throw',
      isError: true,
    });
    // Must not leak the raw pre-redaction payload through the event.
    expect(results[0]?.output).not.toBe('SENSITIVE');
    expect(results[0]?.output).toMatch(/afterToolCall hook failed/);
    expect(results[0]?.output).toMatch(/redaction hook crashed/);
  });

  it('emits tool.result on the afterToolCall AbortError synthetic path', async () => {
    // An AbortError from afterToolCall converges on the same
    // stopReason='aborted' path as a cancelled execute, but Soul
    // still writes a synthetic aborted tool_result BEFORE rethrowing.
    // Slice 4.2 fires the matching tool.result event immediately
    // before that append so the TUI sees a balanced call/result
    // pair even on aborted turns.
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'raw' }, 'call_after_abort')]),
        makeEndTurnResponse('should not run'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = {
      tools: [new EchoTool()],
      afterToolCall: async () => {
        const err = new Error('hook aborted mid-redaction');
        err.name = 'AbortError';
        throw err;
      },
    };

    const result = await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    // Outer catch converges on aborted — the follow-up LLM call
    // never runs.
    expect(result.stopReason).toBe('aborted');
    const results = sink.byType('tool.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_after_abort',
      isError: true,
    });
    expect(results[0]?.output).toMatch(/aborted during afterToolCall/);
  });

  it('every tool.result follows its matching tool.call', async () => {
    // Pair invariant — Slice 4.2 guarantees each tool.call emit is
    // paired with a tool.result emit, for both normal and synthetic
    // branches. Two tool calls in a single LLM turn, one resolves
    // normally and one fails at the "tool not found" gate.
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([
          makeToolCall('echo', { text: 'ok' }, 'call_a'),
          makeToolCall('missing', { x: 1 }, 'call_b'),
        ]),
        makeEndTurnResponse('ok'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const calls = sink.byType('tool.call');
    const results = sink.byType('tool.result');
    expect(calls.map((c) => c.toolCallId)).toEqual(['call_a', 'call_b']);
    expect(results.map((r) => r.toolCallId)).toEqual(['call_a', 'call_b']);
  });
});
