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
        async *[Symbol.asyncIterator]() {},
      }),
    };
    const chaos = new ChaosChatProvider(
      inner as RetryableChatProvider,
      { errorProbability: 0 },
    );
    const result = chaos.onRetryableError(new Error('boom'));
    expect(result).toBe(true);
    expect(called).toBe(1);
  });

  it('onRetryableError returns false when inner provider is not retryable', () => {
    const inner = new MockChatProvider([{ type: 'text', text: 'hi' }]);
    const chaos = new ChaosChatProvider(inner, { errorProbability: 0 });
    expect(chaos.onRetryableError(new Error('boom'))).toBe(false);
  });
});
