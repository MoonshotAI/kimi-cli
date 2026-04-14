import { describe, it, expect } from 'vitest';

import { APIStatusError } from '../src/errors.js';
import type { Message, StreamedMessagePart, ToolCall } from '../src/message.js';
import { MockChatProvider } from '../src/mock-provider.js';
import type { RetryableChatProvider } from '../src/provider.js';
import { ChaosChatProvider } from '../src/providers/chaos.js';

describe('ChaosChatProvider', () => {
  it('always throws APIStatusError when errorProbability is 1.0', async () => {
    const inner = new MockChatProvider([{ type: 'text', text: 'Hello, world!' }]);
    const chaos = new ChaosChatProvider(inner, { errorProbability: 1.0 });
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello, world!' }], toolCalls: [] },
    ];

    for (let i = 0; i < 3; i++) {
      try {
        const stream = await chaos.generate('', [], history);
        for await (const _ of stream) {
          // drain
        }
        throw new Error('Expected APIStatusError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIStatusError);
      }
    }
  });

  it('passes through when errorProbability is 0', async () => {
    const inner = new MockChatProvider([{ type: 'text', text: 'Hello!' }]);
    const chaos = new ChaosChatProvider(inner, { errorProbability: 0 });
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'test' }], toolCalls: [] },
    ];

    const stream = await chaos.generate('', [], history);
    const parts = [];
    for await (const part of stream) {
      parts.push(part);
    }
    expect(parts).toEqual([{ type: 'text', text: 'Hello!' }]);
  });

  it('delegates modelName to inner provider', () => {
    const inner = new MockChatProvider([{ type: 'text', text: 'test' }], {
      modelName: 'test-model',
    });
    const chaos = new ChaosChatProvider(inner, { errorProbability: 0.5 });
    expect(chaos.modelName).toBe('test-model');
  });

  it('delegates thinkingEffort to inner provider', () => {
    const inner = new MockChatProvider([{ type: 'text', text: 'test' }]);
    const chaos = new ChaosChatProvider(inner, { errorProbability: 0.5 });
    expect(chaos.thinkingEffort).toBeNull();
  });

  it('delegates finishReason and rawFinishReason from the wrapped stream', async () => {
    const inner = new MockChatProvider([{ type: 'text', text: 'Hi' }], {
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    const chaos = new ChaosChatProvider(inner, { errorProbability: 0 });
    const stream = await chaos.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] }],
    );
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('truncated');
    expect(stream.rawFinishReason).toBe('length');
  });

  it('delegates finishReason through the ChaosStreamedMessage wrapper', async () => {
    // Passing a non-zero corruptToolCallProbability forces the chaos
    // provider onto its wrapping code path, which must still forward the
    // inner stream's finishReason getters.
    const inner = new MockChatProvider([{ type: 'text', text: 'Hi' }], {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    const chaos = new ChaosChatProvider(inner, {
      errorProbability: 0,
      corruptToolCallProbability: 0.5,
      seed: 7,
    });
    const stream = await chaos.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] }],
    );
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('filtered');
    expect(stream.rawFinishReason).toBe('content_filter');
  });

  it('withThinking returns a new ChaosChatProvider', () => {
    const inner = new MockChatProvider([{ type: 'text', text: 'test' }]);
    const chaos = new ChaosChatProvider(inner, { errorProbability: 0.5 });
    const newChaos = chaos.withThinking('high');
    expect(newChaos).toBeInstanceOf(ChaosChatProvider);
    expect(newChaos).not.toBe(chaos);
  });

  it('corrupts tool call arguments at given probability', async () => {
    const inner = new MockChatProvider([
      { type: 'function', id: 'tc_001', function: { name: 'foo', arguments: '{"x":1}' } },
    ]);
    const chaos = new ChaosChatProvider(inner, {
      errorProbability: 0,
      corruptToolCallProbability: 1.0,
      seed: 42,
    });

    const stream = await chaos.generate('', [], []);
    const parts: StreamedMessagePart[] = [];
    for await (const p of stream) parts.push(p);

    const toolCall = parts.find((p) => p.type === 'function');
    expect(toolCall).toBeDefined();
    expect((toolCall as ToolCall).function.arguments).not.toBe('{"x":1}');
  });

  it('seed produces deterministic error injection', async () => {
    const run = async (): Promise<number[]> => {
      const chaos = new ChaosChatProvider(new MockChatProvider([{ type: 'text', text: 'hi' }]), {
        errorProbability: 0.5,
        seed: 12345,
      });
      const errors: number[] = [];
      for (let i = 0; i < 20; i++) {
        try {
          await chaos.generate('', [], []);
        } catch {
          errors.push(i);
        }
      }
      return errors;
    };

    const errors1 = await run();
    const errors2 = await run();
    // Identical seed + identical call sequence → identical error indices.
    expect(errors1).toEqual(errors2);
    // Sanity: with errorProbability 0.5 over 20 attempts we should see errors.
    expect(errors1.length).toBeGreaterThan(0);
    expect(errors1.length).toBeLessThan(20);
  });

  it('supports stream-mid error injection', async () => {
    const inner = new MockChatProvider([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'text', text: 'c' },
    ]);
    const chaos = new ChaosChatProvider(inner, {
      errorProbability: 0,
      streamErrorProbability: 1.0,
      seed: 1,
    });

    const stream = await chaos.generate('', [], []);
    await expect(
      (async () => {
        for await (const _p of stream) {
          void _p;
        }
      })(),
    ).rejects.toThrow();
  });

  it('onRetryableError delegates to inner provider when it is retryable', () => {
    let called = 0;
    const inner: Partial<RetryableChatProvider> = {
      name: 'retryable-mock',
      modelName: 'rm',
      thinkingEffort: null,
      onRetryableError: () => {
        called += 1;
        return true;
      },
      withThinking: function () {
        return this as never;
      },
      generate: async () => ({
        id: null,
        usage: null,
        finishReason: null,
        rawFinishReason: null,
        async *[Symbol.asyncIterator]() {},
      }),
    };
    const chaos = new ChaosChatProvider(inner as RetryableChatProvider, { errorProbability: 0 });
    const result = chaos.onRetryableError(new Error('boom'));
    expect(result).toBe(true);
    expect(called).toBe(1);
  });

  it('onRetryableError returns false when inner provider is not retryable', () => {
    const inner = new MockChatProvider([{ type: 'text', text: 'hi' }]);
    const chaos = new ChaosChatProvider(inner, { errorProbability: 0 });
    expect(chaos.onRetryableError(new Error('boom'))).toBe(false);
  });

  it('ChaosStreamedMessage.id and usage delegate to the wrapped stream', async () => {
    const inner = new MockChatProvider([{ type: 'text', text: 'hi' }], {
      id: 'mock-id-42',
      usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    const chaos = new ChaosChatProvider(inner, { errorProbability: 0 });

    const stream = await chaos.generate('', [], []);
    // drain
    for await (const _ of stream) {
      /* drain */
    }
    expect(stream.id).toBe('mock-id-42');
    expect(stream.usage).toEqual({
      inputOther: 10,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('corrupts tool_call_part with non-empty arguments_part by trimming the last char', async () => {
    const inner = new MockChatProvider([{ type: 'tool_call_part', argumentsPart: '{"x":1}' }]);
    const chaos = new ChaosChatProvider(inner, {
      errorProbability: 0,
      corruptToolCallProbability: 1.0,
      seed: 7,
    });

    const stream = await chaos.generate('', [], []);
    const parts: StreamedMessagePart[] = [];
    for await (const p of stream) parts.push(p);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'tool_call_part',
      argumentsPart: '{"x":1', // last char trimmed
    });
  });

  it('leaves ToolCall with null arguments unchanged when corruption probability is 1', async () => {
    const inner = new MockChatProvider([
      { type: 'function', id: 'tc_null', function: { name: 'foo', arguments: null } },
    ]);
    const chaos = new ChaosChatProvider(inner, {
      errorProbability: 0,
      corruptToolCallProbability: 1.0,
      seed: 11,
    });

    const stream = await chaos.generate('', [], []);
    const parts: StreamedMessagePart[] = [];
    for await (const p of stream) parts.push(p);

    expect(parts[0]).toMatchObject({
      type: 'function',
      function: { arguments: null }, // unchanged because args was null
    });
  });

  it('leaves ToolCall with empty-string arguments unchanged when corruption probability is 1', async () => {
    const inner = new MockChatProvider([
      { type: 'function', id: 'tc_empty', function: { name: 'foo', arguments: '' } },
    ]);
    const chaos = new ChaosChatProvider(inner, {
      errorProbability: 0,
      corruptToolCallProbability: 1.0,
      seed: 13,
    });

    const stream = await chaos.generate('', [], []);
    const parts: StreamedMessagePart[] = [];
    for await (const p of stream) parts.push(p);

    expect((parts[0] as ToolCall).function.arguments).toBe('');
  });

  it('leaves tool_call_part with null arguments_part unchanged', async () => {
    const inner = new MockChatProvider([{ type: 'tool_call_part', argumentsPart: null }]);
    const chaos = new ChaosChatProvider(inner, {
      errorProbability: 0,
      corruptToolCallProbability: 1.0,
      seed: 17,
    });

    const stream = await chaos.generate('', [], []);
    const parts: StreamedMessagePart[] = [];
    for await (const p of stream) parts.push(p);

    expect(parts[0]).toMatchObject({ type: 'tool_call_part', argumentsPart: null });
  });

  it('passes through non-tool-call parts even when corruption probability is 1', async () => {
    const inner = new MockChatProvider([
      { type: 'text', text: 'plain text' },
      { type: 'think', think: 'thinking' },
    ]);
    const chaos = new ChaosChatProvider(inner, {
      errorProbability: 0,
      corruptToolCallProbability: 1.0,
      seed: 19,
    });

    const stream = await chaos.generate('', [], []);
    const parts: StreamedMessagePart[] = [];
    for await (const p of stream) parts.push(p);

    expect(parts).toEqual([
      { type: 'text', text: 'plain text' },
      { type: 'think', think: 'thinking' },
    ]);
  });
});
