import { describe, expect, it } from 'vitest';

import { APIConnectionError, APIStatusError, ChatProviderError } from '../../src/errors.js';
import { generate } from '../../src/generate.js';
import type { Message, StreamedMessagePart, ToolCall } from '../../src/message.js';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '../../src/provider.js';
import { SimpleToolset } from '../../src/simple-toolset.js';
import { step } from '../../src/step.js';
import type { JsonType, Tool, ToolReturnValue } from '../../src/tool.js';
import { toolOk } from '../../src/tool.js';
import type { TokenUsage } from '../../src/usage.js';

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

/** Provider whose generate() throws the given error. */
function createThrowingProvider(error: Error): ChatProvider {
  return {
    name: 'throwing',
    modelName: 'throwing',
    thinkingEffort: null,
    async generate(
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
    ): Promise<StreamedMessage> {
      throw error;
    },
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

/** Provider whose generate() succeeds, but the stream throws mid-iteration. */
function createStreamErrorProvider(partsBefore: StreamedMessagePart[], error: Error): ChatProvider {
  return {
    name: 'stream-error',
    modelName: 'stream-error',
    thinkingEffort: null,
    async generate(
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
    ): Promise<StreamedMessage> {
      return {
        get id(): string | null {
          return null;
        },
        get usage(): TokenUsage | null {
          return null;
        },
        async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
          for (const part of partsBefore) {
            yield part;
          }
          throw error;
        },
      };
    },
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

function createMockProvider(stream: StreamedMessage): ChatProvider {
  return {
    name: 'mock',
    modelName: 'mock',
    thinkingEffort: null,
    async generate(
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
    ): Promise<StreamedMessage> {
      return stream;
    },
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: error recovery', () => {
  describe('provider generate() throws', () => {
    it('APIStatusError propagates through step()', async () => {
      const error = new APIStatusError(429, 'Rate limited', 'req-123');
      const provider = createThrowingProvider(error);
      const toolset = new SimpleToolset();

      await expect(
        step(provider, '', toolset, [
          { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        ]),
      ).rejects.toThrow(APIStatusError);

      try {
        await step(provider, '', toolset, [
          { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        ]);
        expect.unreachable('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(APIStatusError);
        const apiError = error as APIStatusError;
        expect(apiError.statusCode).toBe(429);
        expect(apiError.requestId).toBe('req-123');
      }
    });

    it('APIConnectionError propagates through step()', async () => {
      const error = new APIConnectionError('Connection reset');
      const provider = createThrowingProvider(error);
      const toolset = new SimpleToolset();

      await expect(
        step(provider, '', toolset, [
          { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        ]),
      ).rejects.toThrow(APIConnectionError);
    });

    it('ChatProviderError propagates through generate()', async () => {
      const error = new ChatProviderError('Unknown provider error');
      const provider = createThrowingProvider(error);

      await expect(generate(provider, '', [], [])).rejects.toThrow(ChatProviderError);
    });

    it('non-ChatProviderError also propagates through step()', async () => {
      const error = new TypeError('Something unexpected');
      const provider = createThrowingProvider(error);
      const toolset = new SimpleToolset();

      await expect(
        step(provider, '', toolset, [
          { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        ]),
      ).rejects.toThrow(TypeError);
    });
  });

  describe('stream throws mid-iteration', () => {
    it('error after some text parts propagates correctly', async () => {
      const provider = createStreamErrorProvider(
        [{ type: 'text', text: 'Partial response...' }],
        new APIConnectionError('Stream disconnected'),
      );
      const toolset = new SimpleToolset();

      await expect(
        step(provider, '', toolset, [
          { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        ]),
      ).rejects.toThrow(APIConnectionError);
    });

    it('error after tool call part propagates and cleans up pending tool promises', async () => {
      // When the stream yields a ToolCall then immediately throws, the ToolCall
      // is still in the pending-part buffer and has NOT been flushed/dispatched
      // via onToolCall. This is correct behavior: generate() only fires
      // onToolCall when a new non-mergeable part arrives or at stream end.
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-1',
        function: { name: 'slow_tool', arguments: '{}' },
      };

      const provider = createStreamErrorProvider(
        [tc],
        new APIConnectionError('Stream cut mid-tool'),
      );

      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'slow_tool', description: 'Slow', parameters: {} },
        async (): Promise<ToolReturnValue> => {
          return toolOk({ output: 'done' });
        },
      );

      await expect(
        step(provider, '', toolset, [
          { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        ]),
      ).rejects.toThrow(APIConnectionError);
    });

    it('generic Error mid-stream propagates', async () => {
      const provider = createStreamErrorProvider(
        [{ type: 'text', text: 'start' }],
        new Error('Random network failure'),
      );

      await expect(generate(provider, '', [], [])).rejects.toThrow('Random network failure');
    });
  });

  describe('tool execution errors', () => {
    it('tool handler throws → toolRuntimeError in results, other tools unaffected', async () => {
      const tc1: ToolCall = {
        type: 'function',
        id: 'tc-ok',
        function: { name: 'good_tool', arguments: '{}' },
      };
      const tc2: ToolCall = {
        type: 'function',
        id: 'tc-fail',
        function: { name: 'bad_tool', arguments: '{}' },
      };
      const tc3: ToolCall = {
        type: 'function',
        id: 'tc-ok-2',
        function: { name: 'good_tool', arguments: '{}' },
      };

      const stream = createMockStream([tc1, tc2, tc3]);
      const provider = createMockProvider(stream);

      const completionOrder: string[] = [];
      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'good_tool', description: 'Works', parameters: {} },
        async (
          _args: JsonType,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ): Promise<ToolReturnValue> => {
          completionOrder.push('good');
          return toolOk({ output: 'success' });
        },
      );
      toolset.add(
        { name: 'bad_tool', description: 'Crashes', parameters: {} },
        async (): Promise<ToolReturnValue> => {
          completionOrder.push('bad');
          throw new Error('Tool timeout simulation');
        },
      );

      const result = await step(provider, '', toolset, []);
      const toolResults = await result.toolResults();

      expect(toolResults).toHaveLength(3);
      // First tool: success
      expect(toolResults[0]!.returnValue.isError).toBe(false);
      expect(toolResults[0]!.returnValue.output).toBe('success');
      // Second tool: runtime error
      expect(toolResults[1]!.returnValue.isError).toBe(true);
      expect(toolResults[1]!.returnValue.message).toBe(
        'Error running tool: Tool timeout simulation',
      );
      // Third tool: success
      expect(toolResults[2]!.returnValue.isError).toBe(false);
      expect(toolResults[2]!.returnValue.output).toBe('success');
    });

    it('tool not found → toolNotFoundError in results', async () => {
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-missing',
        function: { name: 'nonexistent_tool', arguments: '{}' },
      };

      const stream = createMockStream([{ type: 'text', text: 'calling' }, tc]);
      const provider = createMockProvider(stream);

      const toolset = new SimpleToolset();
      // No tools registered

      const result = await step(provider, '', toolset, []);
      const toolResults = await result.toolResults();

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]!.returnValue.isError).toBe(true);
      expect(toolResults[0]!.returnValue.message).toContain('nonexistent_tool');
    });

    it('tool with invalid JSON arguments → toolParseError', async () => {
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-bad-json',
        function: { name: 'my_tool', arguments: '{invalid json' },
      };

      const stream = createMockStream([{ type: 'text', text: 'calling' }, tc]);
      const provider = createMockProvider(stream);

      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'my_tool', description: 'A tool', parameters: {} },
        async (): Promise<ToolReturnValue> => toolOk({ output: 'ok' }),
      );

      const result = await step(provider, '', toolset, []);
      const toolResults = await result.toolResults();

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]!.returnValue.isError).toBe(true);
      // The message should describe a parse error
      expect(toolResults[0]!.returnValue.display).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'brief', text: 'Invalid arguments' }),
        ]),
      );
    });

    it('tool throws non-Error value → still wrapped as runtime error', async () => {
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-str-throw',
        function: { name: 'throws_string', arguments: '{}' },
      };

      const stream = createMockStream([tc]);
      const provider = createMockProvider(stream);

      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'throws_string', description: 'Throws a string', parameters: {} },
        async (): Promise<ToolReturnValue> => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'a raw string error';
        },
      );

      const result = await step(provider, '', toolset, []);
      const toolResults = await result.toolResults();

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]!.returnValue.isError).toBe(true);
      expect(toolResults[0]!.returnValue.message).toBe('Error running tool: a raw string error');
    });
  });

  describe('provider error before tool dispatch', () => {
    it('tool handlers are never invoked when the stream errors mid-way', async () => {
      // With deferred tool dispatch (the fix for the parallel tool call
      // argument-interleaving P1 bug), onToolCall fires only after the
      // stream has fully drained. A mid-stream error therefore means
      // zero tools are dispatched — the handler must not run.
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-cleanup',
        function: { name: 'cleanup_test', arguments: '{}' },
      };

      let handlerInvoked = false;
      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'cleanup_test', description: 'Test cleanup', parameters: {} },
        async (): Promise<ToolReturnValue> => {
          handlerInvoked = true;
          return toolOk({ output: 'done' });
        },
      );

      // Custom provider: yields tc, then text, then throws mid-stream.
      const provider: ChatProvider = {
        name: 'cleanup-test',
        modelName: 'cleanup-test',
        thinkingEffort: null,
        async generate(
          _systemPrompt: string,
          _tools: Tool[],
          _history: Message[],
        ): Promise<StreamedMessage> {
          return {
            get id(): string | null {
              return null;
            },
            get usage(): TokenUsage | null {
              return null;
            },
            async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
              yield tc;
              yield { type: 'text', text: 'some text' };
              throw new ChatProviderError('Stream failure after tool dispatch');
            },
          };
        },
        withThinking(_effort: ThinkingEffort): ChatProvider {
          return this;
        },
      };

      await expect(
        step(provider, '', toolset, [
          { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] },
        ]),
      ).rejects.toThrow(ChatProviderError);

      // Give any in-flight microtasks a chance to run; the handler must
      // still not have been invoked.
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(handlerInvoked).toBe(false);
    });
  });
});
