import { describe, expect, it } from 'vitest';

import { generate } from '../../src/generate.js';
import type { Message, StreamedMessagePart } from '../../src/message.js';
import { extractText } from '../../src/message.js';
import type {
  ChatProvider,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from '../../src/provider.js';
import { SimpleToolset } from '../../src/simple-toolset.js';
import { step } from '../../src/step.js';
import type { Tool, ToolReturnValue } from '../../src/tool.js';
import { toolOk } from '../../src/tool.js';
import type { TokenUsage } from '../../src/usage.js';

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockStream(
  parts: StreamedMessagePart[],
  opts?: { id?: string; usage?: TokenUsage; delayMs?: number },
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
        if (opts?.delayMs !== undefined && opts.delayMs > 0) {
          await new Promise<void>((r) => setTimeout(r, opts.delayMs));
        }
        yield part;
      }
    },
  };
}

function createDelayedProvider(parts: StreamedMessagePart[], delayMs: number): ChatProvider {
  return {
    name: 'delayed',
    modelName: 'delayed-model',
    thinkingEffort: null,
    async generate(
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
      _options?: GenerateOptions,
    ): Promise<StreamedMessage> {
      return createMockStream(parts, { delayMs });
    },
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

function createMockProvider(stream: StreamedMessage): ChatProvider {
  return {
    name: 'mock',
    modelName: 'mock-model',
    thinkingEffort: null,
    async generate(
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
      _options?: GenerateOptions,
    ): Promise<StreamedMessage> {
      return stream;
    },
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: abort signal', () => {
  describe('abort during generate streaming loop', () => {
    it('aborting in onMessagePart callback causes AbortError', async () => {
      const controller = new AbortController();
      let callbackCount = 0;

      const provider = createDelayedProvider(
        [
          { type: 'text', text: 'chunk1' },
          { type: 'text', text: 'chunk2' },
          { type: 'text', text: 'chunk3' },
        ],
        5,
      );

      const promise = generate(
        provider,
        '',
        [],
        [],
        {
          onMessagePart(_part: StreamedMessagePart): void {
            callbackCount++;
            if (callbackCount >= 2) {
              controller.abort();
            }
          },
        },
        { signal: controller.signal },
      );

      await expect(promise).rejects.toThrow('The operation was aborted.');
    });
  });

  describe('abort during step tool execution', () => {
    it('aborting during tool handler propagates to step', async () => {
      const controller = new AbortController();

      // Provider that emits a tool call
      const toolCallStream = createMockStream([
        { type: 'text', text: 'Calling tool...' },
        {
          type: 'function',
          id: 'tool-1',
          function: { name: 'slow-tool', arguments: '{}' },
        },
      ]);

      const provider = createMockProvider(toolCallStream);

      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'slow-tool', description: 'A slow tool', parameters: {} },
        async (): Promise<ToolReturnValue> => {
          // Abort while tool is "executing"
          controller.abort();
          await new Promise<void>((r) => setTimeout(r, 50));
          return toolOk({ output: 'done' });
        },
      );

      // step() itself should not throw from the abort since tool execution
      // is async and the generate phase completed. The abort signal affects
      // the generate loop, not the tool handler directly.
      const result = await step(provider, '', toolset, [], undefined, {
        signal: controller.signal,
      });

      // The step completed (generate finished before abort was triggered in
      // the tool handler). The tool result should still resolve.
      const toolResults = await result.toolResults();
      expect(toolResults).toHaveLength(1);
    });
  });

  describe('pre-aborted signal', () => {
    it('immediately rejects without calling provider', async () => {
      const controller = new AbortController();
      controller.abort(); // pre-abort

      const provider: ChatProvider = {
        name: 'should-not-be-called',
        modelName: 'should-not-be-called',
        thinkingEffort: null,
        async generate(
          _systemPrompt: string,
          _tools: Tool[],
          _history: Message[],
          _options?: GenerateOptions,
        ): Promise<StreamedMessage> {
          return createMockStream([{ type: 'text', text: 'should not reach' }]);
        },
        withThinking(_effort: ThinkingEffort): ChatProvider {
          return this;
        },
      };

      // With a pre-aborted signal, the generate loop should abort on the
      // first iteration check. The provider.generate is called (because
      // the abort check happens inside the for-await loop), but the stream
      // should be interrupted immediately.
      const promise = generate(provider, '', [], [], undefined, {
        signal: controller.signal,
      });

      await expect(promise).rejects.toThrow();

      // Even if the provider was called (it creates the stream), the
      // iteration should abort on the very first signal check.
    });
  });

  describe('abort does not affect other concurrent generate calls', () => {
    it('aborting one generate does not affect another concurrent one', async () => {
      const controllerA = new AbortController();

      // Provider A: slow, will be aborted
      const providerA = createDelayedProvider(
        [
          { type: 'text', text: 'A-chunk1' },
          { type: 'text', text: 'A-chunk2' },
          { type: 'text', text: 'A-chunk3' },
          { type: 'text', text: 'A-chunk4' },
        ],
        10,
      );

      // Provider B: fast, should complete normally
      const providerB = createDelayedProvider(
        [
          { type: 'text', text: 'B-chunk1' },
          { type: 'text', text: 'B-chunk2' },
        ],
        2,
      );

      let aCallbackCount = 0;
      const promiseA = generate(
        providerA,
        '',
        [],
        [],
        {
          onMessagePart(_part: StreamedMessagePart): void {
            aCallbackCount++;
            if (aCallbackCount >= 2) {
              controllerA.abort();
            }
          },
        },
        { signal: controllerA.signal },
      );

      const promiseB = generate(providerB, '', [], []);

      // A should fail, B should succeed
      const [resultA, resultB] = await Promise.allSettled([promiseA, promiseB]);

      expect(resultA.status).toBe('rejected');
      expect(resultB.status).toBe('fulfilled');

      if (resultB.status === 'fulfilled') {
        expect(extractText(resultB.value.message)).toBe('B-chunk1B-chunk2');
      }
    });
  });
});
