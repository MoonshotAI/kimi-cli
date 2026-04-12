import { describe, expect, it } from 'vitest';

import { ChatProviderError } from '../src/errors.js';
import type { Message, StreamedMessagePart, ToolCall } from '../src/message.js';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '../src/provider.js';
import { step } from '../src/step.js';
import type { Tool, ToolResult, Toolset } from '../src/tool.js';
import { toolOk } from '../src/tool.js';
import type { TokenUsage } from '../src/usage.js';

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockStream(
  parts: StreamedMessagePart[],
  opts?: { id?: string; usage?: TokenUsage },
): StreamedMessage {
  return {
    get id(): string | null {
      return opts?.id ?? null;
    },
    get usage(): TokenUsage | null {
      return opts?.usage ?? null;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

function createMockProvider(stream: StreamedMessage): ChatProvider {
  return {
    name: 'mock',
    modelName: 'mock-model',
    thinkingEffort: null,
    generate(_systemPrompt: string, _tools: Tool[], _history: Message[]): Promise<StreamedMessage> {
      return Promise.resolve(stream);
    },
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

/**
 * Create a mock toolset that returns a simple success result for any tool call.
 */
function createSimpleMockToolset(
  handler?: (toolCall: ToolCall) => Promise<ToolResult> | ToolResult,
): Toolset {
  return {
    tools: [
      {
        name: 'plus',
        description: 'Add two numbers',
        parameters: {
          type: 'object',
          properties: {
            a: { type: 'integer' },
            b: { type: 'integer' },
          },
        },
      },
    ],
    handle:
      handler ??
      ((toolCall: ToolCall): ToolResult => ({
        toolCallId: toolCall.id,
        returnValue: toolOk({ output: 'mock-result' }),
      })),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('step()', () => {
  it('returns a StepResult with message, toolCalls, and toolResults', async () => {
    const plusToolCall: ToolCall = {
      type: 'function',
      id: 'plus#123',
      function: { name: 'plus', arguments: '{"a": 1, "b": 2}' },
    };
    const stream = createMockStream([{ type: 'text', text: 'Hello, world!' }, plusToolCall]);
    const provider = createMockProvider(stream);

    const toolset = createSimpleMockToolset(
      (toolCall: ToolCall): ToolResult => ({
        toolCallId: toolCall.id,
        returnValue: toolOk({ output: '3' }),
      }),
    );

    const result = await step(provider, '', toolset, []);

    expect(result.message.content).toEqual([{ type: 'text', text: 'Hello, world!' }]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual(plusToolCall);

    const toolResults = await result.toolResults();
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.toolCallId).toBe('plus#123');
    expect(toolResults[0]!.returnValue.output).toBe('3');
  });

  it('fires onMessagePart and onToolResult callbacks', async () => {
    const plusToolCall: ToolCall = {
      type: 'function',
      id: 'plus#123',
      function: { name: 'plus', arguments: '{"a": 1, "b": 2}' },
    };
    const stream = createMockStream([{ type: 'text', text: 'Hello, world!' }, plusToolCall]);
    const provider = createMockProvider(stream);

    const toolset = createSimpleMockToolset(
      (toolCall: ToolCall): ToolResult => ({
        toolCallId: toolCall.id,
        returnValue: toolOk({ output: '3' }),
      }),
    );

    const outputParts: StreamedMessagePart[] = [];
    const collectedToolResults: ToolResult[] = [];

    const stepResult = await step(provider, '', toolset, [], {
      onMessagePart(part: StreamedMessagePart): void {
        outputParts.push(part);
      },
      onToolResult(toolResult: ToolResult): void {
        collectedToolResults.push(toolResult);
      },
    });

    // onMessagePart should receive each raw streamed part.
    expect(outputParts).toHaveLength(2);
    expect(outputParts[0]).toEqual({ type: 'text', text: 'Hello, world!' });

    // Await results so onToolResult fires.
    const toolResults = await stepResult.toolResults();

    expect(toolResults).toHaveLength(1);
    expect(collectedToolResults).toHaveLength(1);
    expect(collectedToolResults[0]!.toolCallId).toBe('plus#123');
  });

  it('returns empty toolResults when no tool calls', async () => {
    const stream = createMockStream([{ type: 'text', text: 'No tools needed.' }]);
    const provider = createMockProvider(stream);
    const toolset = createSimpleMockToolset();

    const stepResult = await step(provider, '', toolset, []);
    const toolResults = await stepResult.toolResults();

    expect(stepResult.toolCalls).toHaveLength(0);
    expect(toolResults).toHaveLength(0);
  });

  it('preserves stream id and usage', async () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 50,
      inputCacheRead: 200,
      inputCacheCreation: 10,
    };
    const stream = createMockStream([{ type: 'text', text: 'hi' }], {
      id: 'msg-123',
      usage,
    });
    const provider = createMockProvider(stream);
    const toolset = createSimpleMockToolset();

    const stepResult = await step(provider, '', toolset, []);

    expect(stepResult.id).toBe('msg-123');
    expect(stepResult.usage).toEqual(usage);
  });

  it('handles multiple tool calls', async () => {
    const tc1: ToolCall = {
      type: 'function',
      id: 'call-1',
      function: { name: 'plus', arguments: '{"a":1,"b":2}' },
    };
    const tc2: ToolCall = {
      type: 'function',
      id: 'call-2',
      function: { name: 'plus', arguments: '{"a":3,"b":4}' },
    };
    const stream = createMockStream([tc1, tc2]);
    const provider = createMockProvider(stream);

    const toolset = createSimpleMockToolset(
      (toolCall: ToolCall): ToolResult => ({
        toolCallId: toolCall.id,
        returnValue: toolOk({ output: `result-${toolCall.id}` }),
      }),
    );

    const stepResult = await step(provider, '', toolset, []);
    const toolResults = await stepResult.toolResults();

    expect(stepResult.toolCalls).toHaveLength(2);
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]!.toolCallId).toBe('call-1');
    expect(toolResults[1]!.toolCallId).toBe('call-2');
  });

  // ── Error-path tests ────────────────────────────────────────────────

  it('does not dispatch tool calls when provider throws mid-stream', async () => {
    // With deferred dispatch, onToolCall only fires *after* the stream
    // has drained. A mid-stream provider error therefore leaves zero
    // pending tool futures — toolset.handle must never be called.
    //
    // This is the desired behaviour for parallel tool call streams
    // where arguments can interleave; dispatching eagerly would hand
    // tools half-parsed JSON. See generate.test.ts for the full
    // rationale.
    let toolHandleCalls = 0;

    const tc1: ToolCall = {
      type: 'function',
      id: 'call-first',
      function: { name: 'slow', arguments: '{}' },
    };
    const tc2: ToolCall = {
      type: 'function',
      id: 'call-second',
      function: { name: 'slow', arguments: '{}' },
    };

    const throwingStream: StreamedMessage = {
      get id(): string | null {
        return null;
      },
      get usage(): TokenUsage | null {
        return null;
      },
      async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
        yield tc1;
        yield tc2;
        throw new ChatProviderError('provider blew up mid-stream');
      },
    };

    const provider: ChatProvider = {
      name: 'mock-throwing',
      modelName: 'mock-model',
      thinkingEffort: null,
      generate(): Promise<StreamedMessage> {
        return Promise.resolve(throwingStream);
      },
      withThinking(_effort: ThinkingEffort): ChatProvider {
        return this;
      },
    };

    const toolset: Toolset = {
      tools: [],
      handle(toolCall: ToolCall): Promise<ToolResult> {
        toolHandleCalls++;
        return Promise.resolve({
          toolCallId: toolCall.id,
          returnValue: toolOk({ output: 'should-never-run' }),
        });
      },
    };

    await expect(step(provider, '', toolset, [])).rejects.toThrow(ChatProviderError);

    // No tools were dispatched because onToolCall is deferred until
    // after the stream completes successfully.
    expect(toolHandleCalls).toBe(0);
  });

  it('mid-stream provider error does not leak unhandled rejections', async () => {
    const tc1: ToolCall = {
      type: 'function',
      id: 'call-rejected',
      function: { name: 'boom', arguments: '{}' },
    };
    const tc2: ToolCall = {
      type: 'function',
      id: 'call-next',
      function: { name: 'boom', arguments: '{}' },
    };

    const throwingStream: StreamedMessage = {
      get id(): string | null {
        return null;
      },
      get usage(): TokenUsage | null {
        return null;
      },
      async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
        yield tc1;
        yield tc2;
        throw new ChatProviderError('kaboom');
      },
    };

    const provider: ChatProvider = {
      name: 'mock-throwing',
      modelName: 'mock-model',
      thinkingEffort: null,
      generate(): Promise<StreamedMessage> {
        return Promise.resolve(throwingStream);
      },
      withThinking(_effort: ThinkingEffort): ChatProvider {
        return this;
      },
    };

    // Toolset whose handle() returns a rejecting promise. With deferred
    // dispatch, handle() is never even invoked on a mid-stream error,
    // so this never produces a rejected promise. The listener check
    // below still guards against any future regression where step()
    // accidentally drops a reference to a rejected promise.
    const toolset: Toolset = {
      tools: [],
      handle(): Promise<ToolResult> {
        return Promise.reject(new Error('tool failed'));
      },
    };

    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      await expect(step(provider, '', toolset, [])).rejects.toThrow(ChatProviderError);
      // Give the event loop a few ticks for any unhandled rejections to fire.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    } finally {
      process.off('unhandledRejection', listener);
    }

    expect(unhandled).toEqual([]);
  });

  it('does not emit unhandledRejection when toolResults() is not awaited', async () => {
    const stream = createMockStream([
      {
        type: 'function',
        id: 'call-rejected',
        function: { name: 'plus', arguments: '{"a":1,"b":2}' },
      },
    ]);
    const provider = createMockProvider(stream);

    const toolset: Toolset = {
      tools: [],
      handle(): Promise<ToolResult> {
        return Promise.reject(new Error('tool failed'));
      },
    };

    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };

    process.on('unhandledRejection', listener);
    try {
      await step(provider, '', toolset, []);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    } finally {
      process.off('unhandledRejection', listener);
    }

    expect(unhandled).toEqual([]);
  });

  it('dispatches tool calls after the stream completes (deferred dispatch)', async () => {
    // Positive regression: with interleaved parallel tool call streams,
    // step() must still dispatch every tool exactly once, and each
    // toolset.handle() invocation must receive fully-assembled
    // arguments.
    const seenArgs: Array<{ id: string; args: string | null }> = [];

    const stream = createMockStream([
      {
        type: 'function',
        id: 'tc-a',
        function: { name: 'plus', arguments: null },
        _streamIndex: 0,
      },
      {
        type: 'function',
        id: 'tc-b',
        function: { name: 'plus', arguments: null },
        _streamIndex: 1,
      },
      { type: 'tool_call_part', argumentsPart: '{"a":1,', index: 0 },
      { type: 'tool_call_part', argumentsPart: '{"a":3,', index: 1 },
      { type: 'tool_call_part', argumentsPart: '"b":2}', index: 0 },
      { type: 'tool_call_part', argumentsPart: '"b":4}', index: 1 },
    ]);
    const provider = createMockProvider(stream);

    const toolset: Toolset = {
      tools: [],
      handle(toolCall: ToolCall): Promise<ToolResult> {
        seenArgs.push({ id: toolCall.id, args: toolCall.function.arguments });
        return Promise.resolve({
          toolCallId: toolCall.id,
          returnValue: toolOk({ output: `ok-${toolCall.id}` }),
        });
      },
    };

    const stepResult = await step(provider, '', toolset, []);
    const toolResults = await stepResult.toolResults();

    // Every handle() invocation saw the fully-assembled arguments for
    // its own tool call — no partial JSON.
    expect(seenArgs).toEqual([
      { id: 'tc-a', args: '{"a":1,"b":2}' },
      { id: 'tc-b', args: '{"a":3,"b":4}' },
    ]);
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]!.toolCallId).toBe('tc-a');
    expect(toolResults[1]!.toolCallId).toBe('tc-b');
  });

  it('handles sync toolset.handle() return', async () => {
    const tc: ToolCall = {
      type: 'function',
      id: 'call-sync',
      function: { name: 'plus', arguments: '{}' },
    };
    const stream = createMockStream([tc]);
    const provider = createMockProvider(stream);

    // Toolset that returns a sync ToolResult (not a Promise).
    const toolset: Toolset = {
      tools: [],
      handle(toolCall: ToolCall): ToolResult {
        return {
          toolCallId: toolCall.id,
          returnValue: toolOk({ output: 'sync-result' }),
        };
      },
    };

    const stepResult = await step(provider, '', toolset, []);
    const toolResults = await stepResult.toolResults();

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.returnValue.output).toBe('sync-result');
  });
});
