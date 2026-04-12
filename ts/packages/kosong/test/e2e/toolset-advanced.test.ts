import { describe, expect, it } from 'vitest';

import type { StreamedMessagePart, ToolCall } from '../../src/message.js';
import type { Message } from '../../src/message.js';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '../../src/provider.js';
import { SimpleToolset } from '../../src/simple-toolset.js';
import { step } from '../../src/step.js';
import type { StepCallbacks } from '../../src/step.js';
import type { JsonType, Tool, ToolResult, ToolReturnValue } from '../../src/tool.js';
import { toolOk } from '../../src/tool.js';
import type { TokenUsage } from '../../src/usage.js';

// ── Helpers ──────────────────────────────────────────────────────────

function buildStream(
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

class QueuedProvider implements ChatProvider {
  readonly name: string = 'queued';
  readonly modelName: string = 'queued';
  readonly thinkingEffort: ThinkingEffort | null = null;
  private readonly _queue: StreamedMessage[];
  private _cursor: number = 0;

  constructor(queue: StreamedMessage[]) {
    this._queue = queue;
  }

  async generate(
    _systemPrompt: string,
    _tools: Tool[],
    _history: Message[],
  ): Promise<StreamedMessage> {
    const stream = this._queue[this._cursor];
    if (stream === undefined) {
      throw new Error(`QueuedProvider exhausted at turn ${this._cursor + 1}.`);
    }
    this._cursor++;
    return stream;
  }

  withThinking(_effort: ThinkingEffort): ChatProvider {
    return this;
  }
}

// ── Tests: Tool arguments edge cases ─────────────────────────────────

describe('e2e: toolset advanced', () => {
  describe('tool argument boundaries', () => {
    it('arguments=null -> handler receives {}', async () => {
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-null',
        function: { name: 'my_tool', arguments: null },
      };

      const provider = new QueuedProvider([
        buildStream([tc]),
        buildStream([{ type: 'text', text: 'done' }]),
      ]);

      let receivedArgs: JsonType = undefined as unknown as JsonType;
      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'my_tool', description: 'Test tool', parameters: {} },
        async (args: JsonType): Promise<ToolReturnValue> => {
          receivedArgs = args;
          return toolOk({ output: 'ok' });
        },
      );

      const result = await step(provider, '', toolset, [
        { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] },
      ]);
      const results = await result.toolResults();

      // null arguments should be parsed as {} via JSON.parse('{}')
      expect(receivedArgs).toEqual({});
      expect(results[0]!.returnValue.isError).toBe(false);
    });

    it('arguments="" -> toolParseError', async () => {
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-empty',
        function: { name: 'my_tool', arguments: '' },
      };

      const provider = new QueuedProvider([
        buildStream([tc]),
        buildStream([{ type: 'text', text: 'done' }]),
      ]);

      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'my_tool', description: 'Test tool', parameters: {} },
        async (): Promise<ToolReturnValue> => toolOk({ output: 'ok' }),
      );

      const result = await step(provider, '', toolset, [
        { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] },
      ]);
      const results = await result.toolResults();

      // Empty string "" is not valid JSON, should produce a parse error
      expect(results[0]!.returnValue.isError).toBe(true);
    });

    it('arguments="null" -> handler receives null', async () => {
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-string-null',
        function: { name: 'my_tool', arguments: 'null' },
      };

      const provider = new QueuedProvider([
        buildStream([tc]),
        buildStream([{ type: 'text', text: 'done' }]),
      ]);

      let receivedArgs: JsonType = undefined as unknown as JsonType;
      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'my_tool', description: 'Test tool', parameters: {} },
        async (args: JsonType): Promise<ToolReturnValue> => {
          receivedArgs = args;
          return toolOk({ output: 'ok' });
        },
      );

      const result = await step(provider, '', toolset, [
        { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] },
      ]);
      await result.toolResults();

      // JSON.parse("null") === null
      expect(receivedArgs).toBeNull();
    });

    it('arguments="[]" -> handler receives empty array', async () => {
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-array',
        function: { name: 'my_tool', arguments: '[]' },
      };

      const provider = new QueuedProvider([
        buildStream([tc]),
        buildStream([{ type: 'text', text: 'done' }]),
      ]);

      let receivedArgs: JsonType = undefined as unknown as JsonType;
      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'my_tool', description: 'Test tool', parameters: {} },
        async (args: JsonType): Promise<ToolReturnValue> => {
          receivedArgs = args;
          return toolOk({ output: 'ok' });
        },
      );

      const result = await step(provider, '', toolset, [
        { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] },
      ]);
      await result.toolResults();

      // JSON.parse("[]") === []
      expect(receivedArgs).toEqual([]);
    });

    it('arguments with unicode JSON -> correctly parsed', async () => {
      const args = JSON.stringify({ message: 'Hello \u4E16\u754C!', emoji: '\uD83D\uDE80' });
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-unicode',
        function: { name: 'my_tool', arguments: args },
      };

      const provider = new QueuedProvider([
        buildStream([tc]),
        buildStream([{ type: 'text', text: 'done' }]),
      ]);

      let receivedArgs: JsonType = undefined as unknown as JsonType;
      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'my_tool', description: 'Test tool', parameters: {} },
        async (receivedArgsParam: JsonType): Promise<ToolReturnValue> => {
          receivedArgs = receivedArgsParam;
          return toolOk({ output: 'ok' });
        },
      );

      const result = await step(provider, '', toolset, [
        { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] },
      ]);
      await result.toolResults();

      const parsed = receivedArgs as Record<string, JsonType>;
      expect(parsed['message']).toBe('Hello \u4E16\u754C!');
      expect(parsed['emoji']).toBe('\uD83D\uDE80');
    });
  });

  // ── Tests: Concurrent tool execution order ─────────────────────────

  describe('concurrent tool execution order guarantees', () => {
    it('toolResults() returns in ToolCall order, not completion order', async () => {
      const tc1: ToolCall = {
        type: 'function',
        id: 'tc-slow',
        function: { name: 'delayed', arguments: '{"delay":100,"label":"slow"}' },
      };
      const tc2: ToolCall = {
        type: 'function',
        id: 'tc-fast',
        function: { name: 'delayed', arguments: '{"delay":10,"label":"fast"}' },
      };
      const tc3: ToolCall = {
        type: 'function',
        id: 'tc-mid',
        function: { name: 'delayed', arguments: '{"delay":50,"label":"mid"}' },
      };

      const provider = new QueuedProvider([
        buildStream([tc1, tc2, tc3]),
        buildStream([{ type: 'text', text: 'done' }]),
      ]);

      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'delayed', description: 'Delayed tool', parameters: {} },
        async (args: JsonType): Promise<ToolReturnValue> => {
          const obj = args as Record<string, JsonType>;
          const delay = obj['delay'] as number;
          const label = obj['label'] as string;
          await new Promise<void>((r) => setTimeout(r, delay));
          return toolOk({ output: label });
        },
      );

      const result = await step(provider, '', toolset, [
        { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] },
      ]);
      const results = await result.toolResults();

      // Results must be in ToolCall order: slow, fast, mid
      expect(results).toHaveLength(3);
      expect(results[0]!.toolCallId).toBe('tc-slow');
      expect(results[0]!.returnValue.output).toBe('slow');
      expect(results[1]!.toolCallId).toBe('tc-fast');
      expect(results[1]!.returnValue.output).toBe('fast');
      expect(results[2]!.toolCallId).toBe('tc-mid');
      expect(results[2]!.returnValue.output).toBe('mid');
    });

    it('onToolResult fires in completion order, not ToolCall order', async () => {
      const tc1: ToolCall = {
        type: 'function',
        id: 'tc-slow',
        function: { name: 'delayed', arguments: '{"delay":80,"label":"slow"}' },
      };
      const tc2: ToolCall = {
        type: 'function',
        id: 'tc-fast',
        function: { name: 'delayed', arguments: '{"delay":10,"label":"fast"}' },
      };
      const tc3: ToolCall = {
        type: 'function',
        id: 'tc-mid',
        function: { name: 'delayed', arguments: '{"delay":40,"label":"mid"}' },
      };

      const provider = new QueuedProvider([
        buildStream([tc1, tc2, tc3]),
        buildStream([{ type: 'text', text: 'done' }]),
      ]);

      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'delayed', description: 'Delayed tool', parameters: {} },
        async (args: JsonType): Promise<ToolReturnValue> => {
          const obj = args as Record<string, JsonType>;
          const delay = obj['delay'] as number;
          const label = obj['label'] as string;
          await new Promise<void>((r) => setTimeout(r, delay));
          return toolOk({ output: label });
        },
      );

      const completionOrder: string[] = [];
      const callbacks: StepCallbacks = {
        onToolResult(result: ToolResult): void {
          completionOrder.push(result.toolCallId);
        },
      };

      const result = await step(
        provider,
        '',
        toolset,
        [{ role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] }],
        callbacks,
      );
      await result.toolResults();

      // onToolResult should fire in completion order: fast(10ms), mid(40ms), slow(80ms)
      expect(completionOrder[0]).toBe('tc-fast');
      expect(completionOrder[1]).toBe('tc-mid');
      expect(completionOrder[2]).toBe('tc-slow');
    });
  });

  // ── Tests: step() cancellation semantics ──────────────────────────

  describe('step() error cleanup', () => {
    it('generate() failure does not dispatch any tool handlers', async () => {
      // With deferred tool dispatch (the fix for the parallel tool call
      // argument-interleaving P1 bug), onToolCall only fires once the
      // stream has fully drained. A mid-stream provider failure therefore
      // never dispatches any tool — we no longer need to "clean up"
      // pending tool promises because none are ever started.
      const errorStream: StreamedMessage = {
        get id(): string | null {
          return null;
        },
        get usage(): TokenUsage | null {
          return null;
        },
        async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
          yield {
            type: 'function',
            id: 'tc-doomed',
            function: { name: 'slow_tool', arguments: '{}' },
          } satisfies ToolCall;
          yield { type: 'text', text: 'processing...' };
          throw new Error('stream connection lost');
        },
      };

      const errorProvider: ChatProvider = {
        name: 'error-provider',
        modelName: 'error-model',
        thinkingEffort: null,
        async generate(): Promise<StreamedMessage> {
          return errorStream;
        },
        withThinking(): ChatProvider {
          return this;
        },
      };

      let handlerStarted = false;
      let handlerFinished = false;

      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'slow_tool', description: 'Slow tool', parameters: {} },
        async (): Promise<ToolReturnValue> => {
          handlerStarted = true;
          await new Promise<void>((r) => setTimeout(r, 50));
          handlerFinished = true;
          return toolOk({ output: 'done' });
        },
      );

      await expect(
        step(errorProvider, '', toolset, [
          { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] },
        ]),
      ).rejects.toThrow('stream connection lost');

      // Give any in-flight microtasks a chance to run; the handler must
      // never have been invoked.
      await new Promise<void>((r) => setTimeout(r, 80));
      expect(handlerStarted).toBe(false);
      expect(handlerFinished).toBe(false);
    });

    it('tool handler exception does not crash step()', async () => {
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-error',
        function: { name: 'bad_tool', arguments: '{}' },
      };

      const provider = new QueuedProvider([
        buildStream([tc]),
        buildStream([{ type: 'text', text: 'done' }]),
      ]);

      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'bad_tool', description: 'Bad tool', parameters: {} },
        async (): Promise<ToolReturnValue> => {
          throw new Error('handler exploded');
        },
      );

      const result = await step(provider, '', toolset, [
        { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] },
      ]);
      const results = await result.toolResults();

      // The error should be wrapped as a toolRuntimeError
      expect(results).toHaveLength(1);
      expect(results[0]!.returnValue.isError).toBe(true);
      expect(results[0]!.returnValue.message).toContain('handler exploded');
    });
  });
});
