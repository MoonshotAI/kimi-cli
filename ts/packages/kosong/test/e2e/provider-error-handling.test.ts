import { describe, expect, it } from 'vitest';

import {
  APIConnectionError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '../../src/errors.js';
import { generate } from '../../src/generate.js';
import type { StreamedMessagePart, ToolCall } from '../../src/message.js';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '../../src/provider.js';
import { SimpleToolset } from '../../src/simple-toolset.js';
import { step } from '../../src/step.js';
import type { ToolReturnValue } from '../../src/tool.js';
import { toolOk } from '../../src/tool.js';
import type { TokenUsage } from '../../src/usage.js';

// ── Provider error handling: broader coverage ─────────────────────────
//
// `error-recovery.test.ts` covers the happy-path error propagation.
// This file focuses on the less-covered corners:
//
//   * APITimeoutError propagation through generate() and step().
//   * APIStatusError status code classification across 4xx/5xx.
//   * The deferred-dispatch guarantee: when the provider stream throws
//     *after* a fully-buffered ToolCall has been seen, the tool handler
//     must STILL not run (because dispatch is deferred to stream-drain).
//   * APIEmptyResponseError emitted by generate() when no content / no
//     tool calls arrive.

// ── Mock helpers ──────────────────────────────────────────────────────

function createStream(
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

function createProvider(stream: StreamedMessage): ChatProvider {
  return {
    name: 'mock',
    modelName: 'mock',
    thinkingEffort: null,
    async generate(): Promise<StreamedMessage> {
      return stream;
    },
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

function createThrowingProvider(error: Error): ChatProvider {
  return {
    name: 'throwing',
    modelName: 'throwing',
    thinkingEffort: null,
    async generate(): Promise<StreamedMessage> {
      throw error;
    },
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

function createMidStreamThrowingProvider(
  partsBefore: StreamedMessagePart[],
  error: Error,
): ChatProvider {
  return {
    name: 'mid-stream-throw',
    modelName: 'mid-stream-throw',
    thinkingEffort: null,
    async generate(): Promise<StreamedMessage> {
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

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: provider error handling (extended)', () => {
  describe('APITimeoutError propagation', () => {
    it('APITimeoutError from generate() propagates as APITimeoutError through step()', async () => {
      const err = new APITimeoutError('deadline exceeded');
      const provider = createThrowingProvider(err);

      await expect(
        step(provider, '', new SimpleToolset(), [
          { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        ]),
      ).rejects.toBeInstanceOf(APITimeoutError);
    });

    it('APITimeoutError mid-stream propagates through generate()', async () => {
      const provider = createMidStreamThrowingProvider(
        [{ type: 'text', text: 'partial' }],
        new APITimeoutError('stream idle timeout'),
      );

      await expect(generate(provider, '', [], [])).rejects.toBeInstanceOf(APITimeoutError);
    });

    it('APITimeoutError preserves its message across step() boundaries', async () => {
      const err = new APITimeoutError('request timed out after 30s');
      const provider = createThrowingProvider(err);

      try {
        await step(provider, '', new SimpleToolset(), []);
        expect.unreachable('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(APITimeoutError);
        expect((error as Error).message).toBe('request timed out after 30s');
      }
    });
  });

  describe('APIStatusError: 4xx and 5xx classification', () => {
    const cases = [
      { status: 400, requestId: 'req-400', label: 'bad_request' },
      { status: 401, requestId: 'req-401', label: 'unauthorized' },
      { status: 403, requestId: 'req-403', label: 'forbidden' },
      { status: 404, requestId: 'req-404', label: 'not_found' },
      { status: 413, requestId: 'req-413', label: 'payload_too_large' },
      { status: 429, requestId: 'req-429', label: 'rate_limited' },
      { status: 500, requestId: 'req-500', label: 'internal_server_error' },
      { status: 502, requestId: 'req-502', label: 'bad_gateway' },
      { status: 503, requestId: 'req-503', label: 'service_unavailable' },
      { status: 504, requestId: 'req-504', label: 'gateway_timeout' },
    ];

    for (const { status, requestId, label } of cases) {
      it(`${label} (${status}) propagates through step() with statusCode and requestId intact`, async () => {
        const err = new APIStatusError(status, `HTTP ${status}`, requestId);
        const provider = createThrowingProvider(err);

        try {
          await step(provider, '', new SimpleToolset(), []);
          expect.unreachable('should have thrown');
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(APIStatusError);
          expect((error as APIStatusError).statusCode).toBe(status);
          expect((error as APIStatusError).requestId).toBe(requestId);
          // Base type chain must be intact.
          expect(error).toBeInstanceOf(ChatProviderError);
        }
      });
    }

    it('APIStatusError with null requestId normalises correctly', async () => {
      const err = new APIStatusError(500, 'boom');
      expect(err.requestId).toBeNull();

      const provider = createThrowingProvider(err);
      await expect(step(provider, '', new SimpleToolset(), [])).rejects.toBeInstanceOf(
        APIStatusError,
      );
    });
  });

  describe('APIConnectionError propagation', () => {
    it('mid-stream APIConnectionError propagates through generate()', async () => {
      const provider = createMidStreamThrowingProvider(
        [{ type: 'text', text: 'some output' }],
        new APIConnectionError('socket hang up'),
      );

      await expect(generate(provider, '', [], [])).rejects.toBeInstanceOf(APIConnectionError);
    });

    it('APIConnectionError thrown before any part still propagates', async () => {
      const provider = createMidStreamThrowingProvider(
        [],
        new APIConnectionError('connection reset'),
      );

      await expect(generate(provider, '', [], [])).rejects.toBeInstanceOf(APIConnectionError);
    });
  });

  describe('deferred tool dispatch under stream errors', () => {
    it('handler does NOT fire when stream throws after a fully-formed ToolCall', async () => {
      // The ToolCall arrives with complete arguments. Under naive
      // (non-deferred) dispatch, the handler would run before the
      // error. With deferred dispatch (the Codex P1 fix), onToolCall
      // fires only once the entire stream has been successfully
      // drained — so a mid-stream throw must prevent the handler
      // from running.
      let handlerRan = false;
      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'side_effect', description: 'Has a side effect', parameters: {} },
        async (): Promise<ToolReturnValue> => {
          handlerRan = true;
          return toolOk({ output: 'oops' });
        },
      );

      const tc: ToolCall = {
        type: 'function',
        id: 'tc_sfx',
        function: { name: 'side_effect', arguments: '{}' },
      };

      const provider = createMidStreamThrowingProvider(
        [tc, { type: 'text', text: 'more text' }],
        new APIConnectionError('stream died after tool call header'),
      );

      await expect(step(provider, '', toolset, [])).rejects.toBeInstanceOf(APIConnectionError);

      // Give microtasks a chance to run.
      await new Promise<void>((r) => setTimeout(r, 20));
      expect(handlerRan).toBe(false);
    });

    it('handler does NOT fire when stream throws after interleaved tool_call_part deltas', async () => {
      let handlerRan = false;
      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'search', description: '', parameters: {} },
        async (): Promise<ToolReturnValue> => {
          handlerRan = true;
          return toolOk({ output: 'ok' });
        },
      );

      const parts: StreamedMessagePart[] = [
        {
          type: 'function',
          id: 'tc_search',
          function: { name: 'search', arguments: null },
          _streamIndex: 0,
        },
        { type: 'tool_call_part', argumentsPart: '{"q":', index: 0 },
        // Stream dies before the arguments are complete.
      ];

      const provider = createMidStreamThrowingProvider(parts, new APITimeoutError('stream stuck'));

      await expect(step(provider, '', toolset, [])).rejects.toBeInstanceOf(APITimeoutError);

      await new Promise<void>((r) => setTimeout(r, 20));
      expect(handlerRan).toBe(false);
    });
  });

  describe('APIEmptyResponseError', () => {
    it('completely empty stream -> APIEmptyResponseError from generate()', async () => {
      const provider = createProvider(createStream([]));

      await expect(generate(provider, '', [], [])).rejects.toBeInstanceOf(APIEmptyResponseError);
    });

    it('think-only response -> APIEmptyResponseError', async () => {
      // Think content without any real text or tool calls is treated as
      // a stream interruption / token-budget-exhausted condition.
      const provider = createProvider(
        createStream([{ type: 'think', think: 'thinking aloud...' }]),
      );

      await expect(generate(provider, '', [], [])).rejects.toThrow(APIEmptyResponseError);
    });

    it('text with only whitespace + think is still treated as empty', async () => {
      const provider = createProvider(
        createStream([
          { type: 'think', think: 'hmm' },
          { type: 'text', text: '   \n\t  ' },
        ]),
      );

      await expect(generate(provider, '', [], [])).rejects.toThrow(APIEmptyResponseError);
    });

    it('text with real content passes (no APIEmptyResponseError)', async () => {
      const provider = createProvider(
        createStream([
          { type: 'think', think: 'thinking' },
          { type: 'text', text: 'actual response' },
        ]),
      );

      const result = await generate(provider, '', [], []);
      expect(result.message.content).toHaveLength(2);
    });

    it('empty content but non-empty toolCalls passes', async () => {
      const tc: ToolCall = {
        type: 'function',
        id: 'tc_only',
        function: { name: 'no_op', arguments: '{}' },
      };
      const provider = createProvider(createStream([tc]));

      const result = await generate(provider, '', [], []);
      expect(result.message.content).toHaveLength(0);
      expect(result.message.toolCalls).toHaveLength(1);
    });
  });

  describe('non-provider errors still propagate', () => {
    it('TypeError from generate() reaches the step() caller', async () => {
      const provider = createThrowingProvider(new TypeError('boom'));
      await expect(step(provider, '', new SimpleToolset(), [])).rejects.toBeInstanceOf(TypeError);
    });

    it('RangeError mid-stream reaches the generate() caller', async () => {
      const provider = createMidStreamThrowingProvider(
        [{ type: 'text', text: 'ok' }],
        new RangeError('out of range'),
      );
      await expect(generate(provider, '', [], [])).rejects.toBeInstanceOf(RangeError);
    });
  });
});
