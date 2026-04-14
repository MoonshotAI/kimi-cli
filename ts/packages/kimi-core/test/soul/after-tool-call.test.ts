// Covers: SoulConfig.afterToolCall callback (§5.1.3 / §5.1.7).
// - resultOverride → context receives the overridden result
// - undefined return → original result is passed through
// - callback receives the original args + the parsed/overridden input

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { AfterToolCallHook, SoulConfig, ToolResult } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { EchoTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — afterToolCall hook', () => {
  it('resultOverride → storage receives the overridden result, not the original', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'secret' }, 'call_1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = {
      tools: [new EchoTool()],
      afterToolCall: async () => ({
        resultOverride: { content: '[redacted]' },
      }),
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const toolResults = context.toolResultCalls();
    expect(toolResults).toHaveLength(1);
    // The override should have replaced the echo-tool's 'secret' output
    expect(toolResults[0]?.result.output).toBe('[redacted]');
  });

  it('undefined return → original tool result is passed through unchanged', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hello' }, 'call_1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    let afterCallCount = 0;
    const afterToolCall: AfterToolCallHook = async (): Promise<undefined> => {
      afterCallCount += 1;
    };
    const config: SoulConfig = {
      tools: [new EchoTool()],
      afterToolCall,
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    expect(afterCallCount).toBe(1);
    const toolResults = context.toolResultCalls();
    expect(toolResults).toHaveLength(1);
    // Original echo output should survive into storage
    expect(toolResults[0]?.result.output).toBe('hello');
  });

  it('context.result passed to afterToolCall is the raw tool output', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'raw' }, 'call_r')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    let capturedResultContent: unknown = null;
    const config: SoulConfig = {
      tools: [new EchoTool()],
      afterToolCall: async (ctx) => {
        capturedResultContent = ctx.result.content;
        expect(ctx.toolCall.name).toBe('echo');
        expect(ctx.args).toEqual({ text: 'raw' });
      },
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    expect(capturedResultContent).toBe('raw');
  });

  it('afterToolCall receives the same AbortSignal Soul uses for the turn', async () => {
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
      afterToolCall: async (_ctx, signal) => {
        receivedSignal = signal;
      },
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });

  it('afterToolCall runs AFTER tool.execute (ordering contract)', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'x' })]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const trace: string[] = [];
    class TracingEcho extends EchoTool {
      override async execute(
        id: string,
        args: { text: string },
        signal: AbortSignal,
      ): Promise<ToolResult> {
        trace.push('execute');
        return super.execute(id, args, signal);
      }
    }
    const config: SoulConfig = {
      tools: [new TracingEcho()],
      afterToolCall: async () => {
        trace.push('after');
      },
    };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    expect(trace).toEqual(['execute', 'after']);
  });
});
