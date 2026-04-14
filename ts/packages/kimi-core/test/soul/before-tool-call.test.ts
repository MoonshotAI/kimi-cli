// Covers: SoulConfig.beforeToolCall callback (§5.1.3 / §5.1.7).
// Soul treats it as an opaque async callback with three possible outcomes:
// - returns {block: true} → Soul writes error tool_result with reason, skips execute
// - returns {updatedInput: ...} → Soul passes the override into tool.execute
// - returns undefined → normal pass-through
// The callback is exercised exclusively via the `block` field; no host-side
// gate vocabulary leaks into these tests (Soul-layer rule 2).

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { BeforeToolCallHook, SoulConfig } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { EchoTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — beforeToolCall gate', () => {
  it('block:true → writes error tool_result with reason, skips tool.execute', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'call_1')]),
        makeEndTurnResponse('fine'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const echo = new EchoTool();
    const config: SoulConfig = {
      tools: [echo],
      beforeToolCall: async () => ({ block: true, reason: 'blocked by test' }),
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    expect(echo.calls).toHaveLength(0);
    const toolResults = context.toolResultCalls();
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.toolCallId).toBe('call_1');
    expect(toolResults[0]?.result.isError).toBe(true);
  });

  it('block:true with no reason → still produces an error tool_result', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' })]),
        makeEndTurnResponse('fine'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = {
      tools: [new EchoTool()],
      beforeToolCall: async () => ({ block: true }),
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const toolResults = context.toolResultCalls();
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.result.isError).toBe(true);
  });

  it('updatedInput → tool.execute receives the overridden args', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'original' }, 'call_1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const echo = new EchoTool();
    const config: SoulConfig = {
      tools: [echo],
      beforeToolCall: async () => ({ updatedInput: { text: 'rewritten' } }),
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    expect(echo.calls).toHaveLength(1);
    expect(echo.calls[0]?.args).toEqual({ text: 'rewritten' });
  });

  it('undefined return → normal pass-through (tool.execute runs with parsed args)', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'as-is' })]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const echo = new EchoTool();
    let beforeCallCount = 0;
    const beforeToolCall: BeforeToolCallHook = async (): Promise<undefined> => {
      beforeCallCount += 1;
    };
    const config: SoulConfig = { tools: [echo], beforeToolCall };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    expect(beforeCallCount).toBe(1);
    expect(echo.calls).toHaveLength(1);
    expect(echo.calls[0]?.args).toEqual({ text: 'as-is' });
  });

  it('beforeToolCall throws non-abort error → synthetic error tool_result, loop continues', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'x' }, 'call_err')]),
        makeEndTurnResponse('handled'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const echo = new EchoTool();
    const config: SoulConfig = {
      tools: [echo],
      beforeToolCall: async () => {
        throw new Error('gate exploded');
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

    expect(result.stopReason).toBe('end_turn');
    expect(echo.calls).toHaveLength(0);
    const toolResults = context.toolResultCalls();
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.toolCallId).toBe('call_err');
    expect(toolResults[0]?.result.isError).toBe(true);
  });

  it('beforeToolCall receives the same AbortSignal Soul uses for the turn', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'x' })]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const config: SoulConfig = {
      tools: [new EchoTool()],
      beforeToolCall: async (_ctx, signal) => {
        receivedSignal = signal;
      },
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });

  it('beforeToolCall context carries the correct toolCall / args / assistantMessage', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'payload' }, 'call_ctx')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const seen: { toolCallId: string; args: unknown }[] = [];
    const config: SoulConfig = {
      tools: [new EchoTool()],
      beforeToolCall: async (ctx) => {
        seen.push({ toolCallId: ctx.toolCall.id, args: ctx.args });
        expect(ctx.toolCall.name).toBe('echo');
        expect(ctx.assistantMessage.role).toBe('assistant');
        expect(ctx.context).toBeDefined();
      },
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolCallId).toBe('call_ctx');
    expect(seen[0]?.args).toEqual({ text: 'payload' });
  });
});
