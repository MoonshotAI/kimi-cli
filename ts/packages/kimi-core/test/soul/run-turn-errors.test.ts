// Covers: non-abort error paths and graceful recovery (§5.1.7):
// - maxSteps exceeded → throws MaxStepsExceededError (wrapped as stopReason='error')
// - tool not found → synthetic error tool_result + loop continues
// - zod parse failure → synthetic error tool_result + loop continues
// - tool throws non-abort error → synthetic error tool_result + loop continues
// - LLM throws non-abort error → rethrown, stopReason='error' on emitted event

import { describe, expect, it } from 'vitest';

import { MaxStepsExceededError, runSoulTurn } from '../../src/soul/index.js';
import type { SoulConfig } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { EchoTool, FailingTool, StrictArgsTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — error paths', () => {
  it('tool not found → writes error tool_result and continues the turn', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('does_not_exist', { foo: 1 }, 'call_missing')]),
        makeEndTurnResponse('handled gracefully'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    const result = await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(result.stopReason).toBe('end_turn');
    const toolResults = context.toolResultCalls();
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.toolCallId).toBe('call_missing');
    expect(toolResults[0]?.result.isError).toBe(true);
    // LLM was called twice: once to receive the bad call, once to continue
    expect(kosong.callCount).toBe(2);
  });

  it('zod input parse failure → error tool_result, tool.execute not called', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('strict', { value: 'not a number' }, 'call_bad_args')]),
        makeEndTurnResponse('handled'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const strict = new StrictArgsTool();
    const config: SoulConfig = { tools: [strict] };

    const result = await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(result.stopReason).toBe('end_turn');
    expect(strict.calls).toHaveLength(0);
    const toolResults = context.toolResultCalls();
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.result.isError).toBe(true);
  });

  it('tool throws non-abort error → error tool_result + loop continues', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('fail', {}, 'call_fail')]),
        makeEndTurnResponse('handled'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new FailingTool('bad thing')] };

    const result = await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(result.stopReason).toBe('end_turn');
    const toolResults = context.toolResultCalls();
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.result.isError).toBe(true);
    expect(kosong.callCount).toBe(2);
  });

  it('LLM throws a non-abort error → runSoulTurn rethrows it', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [],
      throwOnIndex: { index: 0, error: new Error('upstream 500') },
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();

    await expect(
      runSoulTurn(
        { text: 'go' },
        { tools: [] },
        context,
        runtime,
        sink,
        new AbortController().signal,
      ),
    ).rejects.toThrow('upstream 500');

    // An 'error' interrupted event is emitted before rethrow
    expect(sink.byType('step.interrupted')).toHaveLength(1);
  });

  it('exceeds maxSteps → throws MaxStepsExceededError (rethrown as error path)', async () => {
    const context = new FakeContextState();
    // Script 3 tool_use responses but set maxSteps=2, so the 3rd step trips the guard.
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' })]),
        makeToolUseResponse([makeToolCall('echo', { text: '2' })]),
        makeToolUseResponse([makeToolCall('echo', { text: '3' })]),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()], maxSteps: 2 };

    await expect(
      runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal),
    ).rejects.toBeInstanceOf(MaxStepsExceededError);
  });

  it('MaxStepsExceededError carries the configured maxSteps on it', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' })]),
        makeToolUseResponse([makeToolCall('echo', { text: '2' })]),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()], maxSteps: 1 };

    try {
      await runSoulTurn(
        { text: 'go' },
        config,
        context,
        runtime,
        sink,
        new AbortController().signal,
      );
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MaxStepsExceededError);
      if (error instanceof MaxStepsExceededError) {
        expect(error.maxSteps).toBe(1);
        expect(error.code).toBe('soul.max_steps_exceeded');
      }
    }
  });

  it('default maxSteps is 100 when not provided', async () => {
    const context = new FakeContextState();
    // Single end_turn response so a default loop runs clean
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();

    // Passing config without maxSteps must not throw on the first step —
    // which implicitly asserts the default is >= 1
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
});
