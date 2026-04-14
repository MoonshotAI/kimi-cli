import { describe, expect, it } from 'vitest';

import { APIEmptyResponseError } from '../src/errors.js';
import { generate } from '../src/generate.js';
import type { Message, StreamedMessagePart, ThinkPart, ToolCall } from '../src/message.js';
import { mergeInPlace } from '../src/message.js';
import { MockChatProvider } from '../src/mock-provider.js';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '../src/provider.js';
import { SimpleToolset } from '../src/simple-toolset.js';
import { step } from '../src/step.js';
import type { JsonType, Tool, ToolReturnValue } from '../src/tool.js';
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
    finishReason: null,
    rawFinishReason: null,
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
    generate: async (
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
    ): Promise<StreamedMessage> => stream,
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

// ── Stress Tests ─────────────────────────────────────────────────────

describe('stress: empty stream', () => {
  it('MockChatProvider with empty parts throws APIEmptyResponseError', async () => {
    const provider = new MockChatProvider([]);
    await expect(generate(provider, '', [], [])).rejects.toThrow(APIEmptyResponseError);
  });

  it('empty parts via inline mock also throws APIEmptyResponseError', async () => {
    const stream = createMockStream([]);
    const provider = createMockProvider(stream);
    await expect(generate(provider, '', [], [])).rejects.toThrow(APIEmptyResponseError);
  });
});

describe('stress: large ToolCall arguments (10KB)', () => {
  it('assembles 10KB arguments from multiple ToolCallPart increments correctly', async () => {
    // Build a 10KB JSON string
    const largeValue = 'x'.repeat(10 * 1024);
    const fullArgs = JSON.stringify({ data: largeValue });

    // Split into ~100-byte chunks to simulate streaming
    const chunkSize = 100;
    const chunks: string[] = [];
    for (let i = 0; i < fullArgs.length; i += chunkSize) {
      chunks.push(fullArgs.slice(i, i + chunkSize));
    }

    const parts: StreamedMessagePart[] = [
      {
        type: 'function',
        id: 'large-tc-1',
        function: { name: 'big_tool', arguments: null },
      },
      ...chunks.map(
        (chunk): StreamedMessagePart => ({
          type: 'tool_call_part',
          argumentsPart: chunk,
        }),
      ),
      // Also include a text part so the response is not empty
      { type: 'text', text: 'done' },
    ];

    const provider = new MockChatProvider(parts);
    const result = await generate(provider, '', [], []);

    expect(result.message.toolCalls).toBeDefined();
    expect(result.message.toolCalls).toHaveLength(1);
    expect(result.message.toolCalls[0]!.function.arguments).toBe(fullArgs);
    expect(result.message.toolCalls[0]!.function.arguments!.length).toBe(fullArgs.length);

    // Verify the JSON is parseable and correct
    const parsed = JSON.parse(result.message.toolCalls[0]!.function.arguments!) as {
      data: string;
    };
    expect(parsed.data).toBe(largeValue);
  });
});

describe('stress: concurrent tool dispatch', () => {
  it('step() dispatches 3 ToolCalls concurrently and returns results in call order', async () => {
    const tc1: ToolCall = {
      type: 'function',
      id: 'call-1',
      function: { name: 'slow_tool', arguments: '{"delay": 1}' },
    };
    const tc2: ToolCall = {
      type: 'function',
      id: 'call-2',
      function: { name: 'slow_tool', arguments: '{"delay": 2}' },
    };
    const tc3: ToolCall = {
      type: 'function',
      id: 'call-3',
      function: { name: 'slow_tool', arguments: '{"delay": 3}' },
    };

    const stream = createMockStream([tc1, tc2, tc3]);
    const provider = createMockProvider(stream);

    // Track completion order
    const completionOrder: string[] = [];

    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'slow_tool', description: 'Simulates varying latency', parameters: {} },
      async (args: JsonType): Promise<ToolReturnValue> => {
        const obj = args as Record<string, JsonType>;
        const delay = obj['delay'] as number;
        // Reverse delay order: call-3 finishes first, call-1 finishes last
        await new Promise<void>((resolve) => setTimeout(resolve, (4 - delay) * 10));
        completionOrder.push(`call-${delay}`);
        return toolOk({ output: `result-${delay}` });
      },
    );

    const result = await step(provider, '', toolset, []);

    expect(result.toolCalls).toHaveLength(3);

    const toolResults = await result.toolResults();

    // Results must be in call order (call-1, call-2, call-3), not completion order
    expect(toolResults).toHaveLength(3);
    expect(toolResults[0]!.toolCallId).toBe('call-1');
    expect(toolResults[1]!.toolCallId).toBe('call-2');
    expect(toolResults[2]!.toolCallId).toBe('call-3');

    expect(toolResults[0]!.returnValue.output).toBe('result-1');
    expect(toolResults[1]!.returnValue.output).toBe('result-2');
    expect(toolResults[2]!.returnValue.output).toBe('result-3');

    // Verify they actually ran concurrently (call-3 should have finished first)
    expect(completionOrder[0]).toBe('call-3');
    expect(completionOrder[1]).toBe('call-2');
    expect(completionOrder[2]).toBe('call-1');
  });
});

describe('stress: tool handler throws exception', () => {
  it('step() does not crash when a tool handler throws; toolResults includes toolRuntimeError', async () => {
    const tc: ToolCall = {
      type: 'function',
      id: 'crash-call',
      function: { name: 'crasher', arguments: '{}' },
    };

    const stream = createMockStream([{ type: 'text', text: 'calling tool' }, tc]);
    const provider = createMockProvider(stream);

    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'crasher', description: 'Always throws', parameters: {} },
      async (): Promise<ToolReturnValue> => {
        throw new Error('catastrophic failure');
      },
    );

    // step() itself should not throw
    const result = await step(provider, '', toolset, []);
    expect(result.toolCalls).toHaveLength(1);

    // toolResults() should contain the runtime error, not re-throw
    const toolResults = await result.toolResults();
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.returnValue.isError).toBe(true);
    expect(toolResults[0]!.returnValue.message).toBe('Error running tool: catastrophic failure');
    expect(toolResults[0]!.returnValue.display).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'brief', text: 'Tool runtime error' }),
      ]),
    );
  });

  it('multiple tools where one throws do not affect the other', async () => {
    const tc1: ToolCall = {
      type: 'function',
      id: 'ok-call',
      function: { name: 'good_tool', arguments: '{}' },
    };
    const tc2: ToolCall = {
      type: 'function',
      id: 'bad-call',
      function: { name: 'bad_tool', arguments: '{}' },
    };

    const stream = createMockStream([tc1, tc2]);
    const provider = createMockProvider(stream);

    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'good_tool', description: 'Works fine', parameters: {} },
      async (): Promise<ToolReturnValue> => toolOk({ output: 'success' }),
    );
    toolset.add(
      { name: 'bad_tool', description: 'Throws', parameters: {} },
      async (): Promise<ToolReturnValue> => {
        throw new Error('tool explosion');
      },
    );

    const result = await step(provider, '', toolset, []);
    const toolResults = await result.toolResults();

    expect(toolResults).toHaveLength(2);
    // First tool succeeded
    expect(toolResults[0]!.returnValue.isError).toBe(false);
    expect(toolResults[0]!.returnValue.output).toBe('success');
    // Second tool errored
    expect(toolResults[1]!.returnValue.isError).toBe(true);
    expect(toolResults[1]!.returnValue.message).toBe('Error running tool: tool explosion');
  });
});

describe('stress: mergeInPlace edge cases', () => {
  it('ThinkPart(encrypted="sig") + ThinkPart refuses to merge', () => {
    const target: ThinkPart = { type: 'think', think: 'done thinking', encrypted: 'sig' };
    const source: ThinkPart = { type: 'think', think: ' more thoughts' };

    const merged = mergeInPlace(target, source);

    expect(merged).toBe(false);
    // Target should remain unchanged
    expect(target.think).toBe('done thinking');
    expect(target.encrypted).toBe('sig');
  });

  it('ThinkPart + ThinkPart(encrypted) sets encrypted on merge', () => {
    const target: ThinkPart = { type: 'think', think: 'initial' };
    const source: ThinkPart = { type: 'think', think: '', encrypted: 'new-sig' };

    const merged = mergeInPlace(target, source);

    expect(merged).toBe(true);
    expect(target.think).toBe('initial');
    expect(target.encrypted).toBe('new-sig');
  });

  it('ThinkPart(encrypted) + ThinkPart(encrypted) refuses to merge', () => {
    const target: ThinkPart = { type: 'think', think: 'a', encrypted: 'sig-1' };
    const source: ThinkPart = { type: 'think', think: 'b', encrypted: 'sig-2' };

    const merged = mergeInPlace(target, source);

    expect(merged).toBe(false);
    expect(target.think).toBe('a');
    expect(target.encrypted).toBe('sig-1');
  });
});

describe('stress: consecutive different type parts', () => {
  it('TextPart -> ThinkPart -> ToolCall -> ToolCallPart -> TextPart merges correctly', async () => {
    const parts: StreamedMessagePart[] = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' }, // should merge with previous text
      { type: 'think', think: 'Let me think...' },
      { type: 'think', think: ' more thinking' }, // should merge with previous think
      {
        type: 'function',
        id: 'tc-1',
        function: { name: 'search', arguments: null },
      },
      { type: 'tool_call_part', argumentsPart: '{"q":' }, // merges into ToolCall
      { type: 'tool_call_part', argumentsPart: '"test"}' }, // merges into ToolCall
      { type: 'text', text: 'After tool call' }, // new text part, cannot merge with ToolCall
    ];

    const provider = new MockChatProvider(parts);
    const result = await generate(provider, '', [], []);

    // Verify content parts
    expect(result.message.content).toHaveLength(3);

    // First: merged text "Hello world"
    expect(result.message.content[0]).toEqual({ type: 'text', text: 'Hello world' });

    // Second: merged think "Let me think... more thinking"
    expect(result.message.content[1]).toEqual({
      type: 'think',
      think: 'Let me think... more thinking',
    });

    // Third: "After tool call" text
    expect(result.message.content[2]).toEqual({ type: 'text', text: 'After tool call' });

    // Verify tool calls
    expect(result.message.toolCalls).toHaveLength(1);
    expect(result.message.toolCalls[0]).toEqual({
      type: 'function',
      id: 'tc-1',
      function: { name: 'search', arguments: '{"q":"test"}' },
    });
  });

  it('interleaved: text -> think -> text -> think produces 4 separate parts', async () => {
    const parts: StreamedMessagePart[] = [
      { type: 'text', text: 'A' },
      { type: 'think', think: 'B' },
      { type: 'text', text: 'C' },
      { type: 'think', think: 'D' },
    ];

    const provider = new MockChatProvider(parts);
    const result = await generate(provider, '', [], []);

    // Each type switch should produce a new part (no merging across types)
    expect(result.message.content).toHaveLength(4);
    expect(result.message.content[0]).toEqual({ type: 'text', text: 'A' });
    expect(result.message.content[1]).toEqual({ type: 'think', think: 'B' });
    expect(result.message.content[2]).toEqual({ type: 'text', text: 'C' });
    expect(result.message.content[3]).toEqual({ type: 'think', think: 'D' });
  });

  it('multiple ToolCalls without ToolCallParts are separate', async () => {
    const parts: StreamedMessagePart[] = [
      { type: 'text', text: 'Calling tools' },
      {
        type: 'function',
        id: 'tc-1',
        function: { name: 'tool_a', arguments: '{"x":1}' },
      },
      {
        type: 'function',
        id: 'tc-2',
        function: { name: 'tool_b', arguments: '{"y":2}' },
      },
    ];

    const provider = new MockChatProvider(parts);
    const result = await generate(provider, '', [], []);

    expect(result.message.content).toHaveLength(1);
    expect(result.message.toolCalls).toHaveLength(2);
    expect(result.message.toolCalls[0]!.id).toBe('tc-1');
    expect(result.message.toolCalls[1]!.id).toBe('tc-2');
  });
});
