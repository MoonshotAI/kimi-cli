import { describe, it, expect, vi } from 'vitest';

import { generate } from '../src/generate.js';
import type { Message, StreamedMessagePart } from '../src/message.js';
import { MockChatProvider } from '../src/mock-provider.js';
import type { FinishReason } from '../src/provider.js';
import {
  AnthropicChatProvider,
  GoogleGenAIChatProvider,
  GoogleGenAIStreamedMessage,
  KimiChatProvider,
  OpenAILegacyChatProvider,
  OpenAIResponsesStreamedMessage,
} from '../src/providers/index.js';
import { normalizeOpenAIFinishReason } from '../src/providers/openai-common.js';
import { step } from '../src/step.js';
import { toolOk, type Toolset } from '../src/tool.js';

// ── Test helpers ─────────────────────────────────────────────────────

const USER_MSG: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'hi' }],
  toolCalls: [],
};

function makeAsyncIterable<T>(events: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

const EMPTY_TOOLSET: Toolset = {
  tools: [],
  handle: (toolCall) => ({
    toolCallId: toolCall.id,
    returnValue: toolOk({ output: '' }),
  }),
};

// =====================================================================
// A. Normalization table coverage (direct helper tests where possible).
// =====================================================================

describe('normalizeOpenAIFinishReason (Kimi + OpenAILegacy shared helper)', () => {
  // Covers A for Kimi + OpenAILegacy.
  it.each<[string | null | undefined, FinishReason | null, string | null]>([
    ['stop', 'completed', 'stop'],
    ['tool_calls', 'tool_calls', 'tool_calls'],
    ['function_call', 'tool_calls', 'function_call'],
    ['length', 'truncated', 'length'],
    ['content_filter', 'filtered', 'content_filter'],
    ['unknown_value', 'other', 'unknown_value'],
    ['', 'other', ''],
    [null, null, null],
    [undefined, null, null],
  ])(
    'raw %j normalizes to finishReason=%j rawFinishReason=%j',
    (raw, expectedFinish, expectedRaw) => {
      const result = normalizeOpenAIFinishReason(raw);
      expect(result).toEqual({ finishReason: expectedFinish, rawFinishReason: expectedRaw });
    },
  );
});

// ── Kimi stream A-coverage ──────────────────────────────────────────

function makeKimiStream(rawFinish: string | null | undefined): AsyncIterable<unknown> {
  // Kimi / Chat Completions stream: emit one content chunk + a terminal
  // chunk carrying finish_reason.
  const chunks: Array<Record<string, unknown>> = [
    {
      id: 'chatcmpl-finish-1',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-finish-1',
      choices: [{ index: 0, delta: {}, finish_reason: rawFinish ?? null }],
    },
  ];
  return makeAsyncIterable(chunks);
}

describe('KimiChatProvider finish reason (stream, table coverage)', () => {
  // A + B coverage for Kimi.
  it.each<[string, FinishReason, string]>([
    ['stop', 'completed', 'stop'],
    ['tool_calls', 'tool_calls', 'tool_calls'],
    ['function_call', 'tool_calls', 'function_call'],
    ['length', 'truncated', 'length'],
    ['content_filter', 'filtered', 'content_filter'],
    ['mystery', 'other', 'mystery'],
  ])(
    'raw stream finish_reason %j maps to %j (raw=%j)',
    async (raw, expectedFinish, expectedRaw) => {
      const provider = new KimiChatProvider({
        model: 'kimi-k2-turbo-preview',
        apiKey: 'test-key',
        stream: true,
      });
      (provider as any)._client.chat.completions.create = vi
        .fn()
        .mockResolvedValue(makeKimiStream(raw));

      const stream = await provider.generate('', [], [USER_MSG]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBe(expectedFinish);
      expect(stream.rawFinishReason).toBe(expectedRaw);
    },
  );

  // D coverage for Kimi.
  it('returns null finishReason when stream never emits finish_reason', async () => {
    const provider = new KimiChatProvider({
      model: 'kimi-k2-turbo-preview',
      apiKey: 'test-key',
      stream: true,
    });
    const chunks = [
      {
        id: 'chatcmpl-null',
        choices: [{ index: 0, delta: { content: 'partial' } }],
      },
    ];
    (provider as any)._client.chat.completions.create = vi
      .fn()
      .mockResolvedValue(makeAsyncIterable(chunks));

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBeNull();
    expect(stream.rawFinishReason).toBeNull();
  });

  // C coverage for Kimi.
  it('captures finish_reason from a non-stream response', async () => {
    const provider = new KimiChatProvider({
      model: 'kimi-k2-turbo-preview',
      apiKey: 'test-key',
      stream: false,
    });
    (provider as any)._client.chat.completions.create = vi.fn().mockResolvedValue({
      id: 'chatcmpl-ns',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi' },
          finish_reason: 'length',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('truncated');
    expect(stream.rawFinishReason).toBe('length');
  });

  // D (non-stream) coverage for Kimi.
  it('returns null finishReason when non-stream response omits finish_reason', async () => {
    const provider = new KimiChatProvider({
      model: 'kimi-k2-turbo-preview',
      apiKey: 'test-key',
      stream: false,
    });
    (provider as any)._client.chat.completions.create = vi.fn().mockResolvedValue({
      id: 'chatcmpl-ns-null',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi' },
          // finish_reason omitted entirely
        },
      ],
    });

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBeNull();
    expect(stream.rawFinishReason).toBeNull();
  });
});

// ── OpenAILegacy stream + non-stream coverage ───────────────────────

describe('OpenAILegacyChatProvider finish reason (stream + non-stream)', () => {
  // A + B coverage for OpenAI Legacy.
  it.each<[string, FinishReason, string]>([
    ['stop', 'completed', 'stop'],
    ['tool_calls', 'tool_calls', 'tool_calls'],
    ['function_call', 'tool_calls', 'function_call'],
    ['length', 'truncated', 'length'],
    ['content_filter', 'filtered', 'content_filter'],
    ['mystery', 'other', 'mystery'],
  ])(
    'raw stream finish_reason %j maps to %j (raw=%j)',
    async (raw, expectedFinish, expectedRaw) => {
      const provider = new OpenAILegacyChatProvider({
        model: 'gpt-4.1',
        apiKey: 'test-key',
        stream: true,
      });
      (provider as any)._client.chat.completions.create = vi
        .fn()
        .mockResolvedValue(makeKimiStream(raw));

      const stream = await provider.generate('', [], [USER_MSG]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBe(expectedFinish);
      expect(stream.rawFinishReason).toBe(expectedRaw);
    },
  );

  // C coverage for OpenAI Legacy.
  it('captures finish_reason from a non-stream response', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      stream: false,
    });
    (provider as any)._client.chat.completions.create = vi.fn().mockResolvedValue({
      id: 'chatcmpl-ns-legacy',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi' },
          finish_reason: 'content_filter',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('filtered');
    expect(stream.rawFinishReason).toBe('content_filter');
  });

  // D coverage for OpenAI Legacy.
  it('returns null finishReason when stream omits finish_reason entirely', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      stream: true,
    });
    const chunks = [
      {
        id: 'chatcmpl-null',
        choices: [{ index: 0, delta: { content: 'hi' } }],
      },
    ];
    (provider as any)._client.chat.completions.create = vi
      .fn()
      .mockResolvedValue(makeAsyncIterable(chunks));

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBeNull();
    expect(stream.rawFinishReason).toBeNull();
  });
});

// =====================================================================
// OpenAI Responses API — stream event-based capture (A + B + C + D)
// =====================================================================

describe('OpenAIResponsesStreamedMessage finish reason', () => {
  // A: normalization table coverage via response.completed events.
  it.each<[string, string | undefined, FinishReason | null, string | null]>([
    ['completed', undefined, 'completed', 'completed'],
    ['incomplete', 'max_output_tokens', 'truncated', 'max_output_tokens'],
    ['incomplete', 'content_filter', 'filtered', 'content_filter'],
    ['incomplete', 'other_reason', 'other', 'other_reason'],
    ['incomplete', undefined, 'other', 'incomplete'],
    ['failed', undefined, 'other', 'failed'],
    ['cancelled', undefined, null, null],
  ])(
    'status=%j incomplete.reason=%j -> finishReason=%j rawFinishReason=%j',
    async (status, incompleteReason, expectedFinish, expectedRaw) => {
      const response: Record<string, unknown> = {
        id: 'resp_mapping',
        status,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (incompleteReason !== undefined) {
        response['incomplete_details'] = { reason: incompleteReason };
      }
      const events = [
        { type: 'response.output_text.delta', delta: 'hi' },
        {
          type: status === 'incomplete' ? 'response.incomplete' : 'response.completed',
          response,
        },
      ];
      const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBe(expectedFinish);
      expect(stream.rawFinishReason).toBe(expectedRaw);
    },
  );

  // B: last chunk carries finish reason — already exercised above, but
  // verify the happy path with a full response.completed event.
  it('captures finishReason=completed from response.completed stream event', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'hi' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_b',
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];
    const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('completed');
    expect(stream.rawFinishReason).toBe('completed');
  });

  // Executor偏离点: `response.incomplete` must also be recognized.
  it('captures finishReason from response.incomplete with max_output_tokens', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'par' },
      {
        type: 'response.incomplete',
        response: {
          id: 'resp_inc_mo',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];
    const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('truncated');
    expect(stream.rawFinishReason).toBe('max_output_tokens');
  });

  it('captures finishReason from response.incomplete with content_filter', async () => {
    const events = [
      {
        type: 'response.incomplete',
        response: {
          id: 'resp_inc_cf',
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];
    const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('filtered');
    expect(stream.rawFinishReason).toBe('content_filter');
  });

  // C: non-stream capture.
  it('captures finishReason from non-stream response top-level status', async () => {
    const response = {
      id: 'resp_ns',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 2, output_tokens: 1 },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'partial' }],
        },
      ],
    };
    const stream = new OpenAIResponsesStreamedMessage(response, false);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('truncated');
    expect(stream.rawFinishReason).toBe('max_output_tokens');
  });

  // D: no finish signal at all.
  it('returns null finishReason when stream has no completed/incomplete event', async () => {
    const events = [{ type: 'response.output_text.delta', delta: 'hi' }];
    const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBeNull();
    expect(stream.rawFinishReason).toBeNull();
  });

  it('returns null finishReason when non-stream response omits status', async () => {
    const response = {
      id: 'resp_no_status',
      usage: { input_tokens: 1, output_tokens: 1 },
      output: [],
    };
    const stream = new OpenAIResponsesStreamedMessage(response, false);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBeNull();
    expect(stream.rawFinishReason).toBeNull();
  });
});

// =====================================================================
// Anthropic — stream message_delta capture (A + B + C + D)
// =====================================================================

function createAnthropicStreamProvider(): AnthropicChatProvider {
  return new AnthropicChatProvider({
    model: 'k25',
    apiKey: 'test-key',
    defaultMaxTokens: 1024,
    stream: true,
  });
}

function createAnthropicNonStreamProvider(): AnthropicChatProvider {
  return new AnthropicChatProvider({
    model: 'k25',
    apiKey: 'test-key',
    defaultMaxTokens: 1024,
    stream: false,
  });
}

function anthropicMockStream(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('AnthropicChatProvider finish reason (stream + non-stream)', () => {
  // A coverage: every documented stop_reason value.
  it.each<[string, FinishReason]>([
    ['end_turn', 'completed'],
    ['stop_sequence', 'completed'],
    ['max_tokens', 'truncated'],
    ['tool_use', 'tool_calls'],
    ['pause_turn', 'paused'],
    ['refusal', 'filtered'],
    ['mystery_reason', 'other'],
  ])('stream stop_reason %j maps to %j', async (raw, expectedFinish) => {
    const provider = createAnthropicStreamProvider();
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg_a', usage: { input_tokens: 1 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      },
      // Executor偏离点: the executor captures stop_reason from
      // `message_delta.delta.stop_reason`. Make sure the test emits
      // exactly that shape.
      {
        type: 'message_delta',
        delta: { stop_reason: raw },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ];
    (provider as any)._client.messages.stream = vi
      .fn()
      .mockReturnValue(anthropicMockStream(events)) as never;

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe(expectedFinish);
    expect(stream.rawFinishReason).toBe(raw);
  });

  // D: no stop_reason emitted.
  it('returns null finishReason when no message_delta carries stop_reason', async () => {
    const provider = createAnthropicStreamProvider();
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg_none', usage: { input_tokens: 1 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      },
      // message_delta without stop_reason
      { type: 'message_delta', delta: {}, usage: { output_tokens: 1 } },
    ];
    (provider as any)._client.messages.stream = vi
      .fn()
      .mockReturnValue(anthropicMockStream(events)) as never;

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBeNull();
    expect(stream.rawFinishReason).toBeNull();
  });

  it('returns null finishReason when message_delta.delta.stop_reason is null', async () => {
    const provider = createAnthropicStreamProvider();
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg_null_sr', usage: { input_tokens: 1 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: null },
        usage: { output_tokens: 1 },
      },
    ];
    (provider as any)._client.messages.stream = vi
      .fn()
      .mockReturnValue(anthropicMockStream(events)) as never;

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBeNull();
    expect(stream.rawFinishReason).toBeNull();
  });

  // C: non-stream top-level stop_reason.
  it('captures stop_reason from non-stream response (max_tokens -> truncated)', async () => {
    const provider = createAnthropicNonStreamProvider();
    (provider as any)._client.messages.create = vi.fn().mockResolvedValue({
      id: 'msg_ns_trunc',
      content: [{ type: 'text', text: 'part' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'max_tokens',
    });

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('truncated');
    expect(stream.rawFinishReason).toBe('max_tokens');
  });

  it('returns null finishReason when non-stream response omits stop_reason', async () => {
    const provider = createAnthropicNonStreamProvider();
    (provider as any)._client.messages.create = vi.fn().mockResolvedValue({
      id: 'msg_ns_null',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      // stop_reason omitted
    });

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBeNull();
    expect(stream.rawFinishReason).toBeNull();
  });
});

// =====================================================================
// Google GenAI — normalization table + stream + fallback (A-D)
// =====================================================================

function googleStreamFromChunks(chunks: Array<Record<string, unknown>>) {
  async function* gen() {
    for (const chunk of chunks) {
      yield chunk;
    }
  }
  return gen();
}

describe('GoogleGenAIStreamedMessage finish reason', () => {
  // A: every documented raw Gemini finishReason string.
  it.each<[string, FinishReason | null, string | null]>([
    ['STOP', 'completed', 'STOP'],
    ['MAX_TOKENS', 'truncated', 'MAX_TOKENS'],
    ['SAFETY', 'filtered', 'SAFETY'],
    ['RECITATION', 'filtered', 'RECITATION'],
    ['BLOCKLIST', 'filtered', 'BLOCKLIST'],
    ['PROHIBITED_CONTENT', 'filtered', 'PROHIBITED_CONTENT'],
    ['SPII', 'filtered', 'SPII'],
    ['IMAGE_SAFETY', 'filtered', 'IMAGE_SAFETY'],
    ['MALFORMED_FUNCTION_CALL', 'other', 'MALFORMED_FUNCTION_CALL'],
    ['OTHER', 'other', 'OTHER'],
    ['LANGUAGE', 'other', 'LANGUAGE'],
    ['UNRECOGNIZED', 'other', 'UNRECOGNIZED'],
    ['FINISH_REASON_UNSPECIFIED', null, null],
  ])('raw Gemini finishReason %j maps to %j (raw=%j)', async (raw, expectedFinish, expectedRaw) => {
    const stream = new GoogleGenAIStreamedMessage(
      googleStreamFromChunks([
        {
          candidates: [
            {
              content: { parts: [{ text: 'hi' }], role: 'model' },
              finishReason: raw,
            },
          ],
        },
      ]),
      true,
    );
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe(expectedFinish);
    expect(stream.rawFinishReason).toBe(expectedRaw);
  });

  // Case-insensitivity: lowercase `stop` still maps to `completed`.
  it('accepts lowercase raw value and upper-cases it', async () => {
    const stream = new GoogleGenAIStreamedMessage(
      googleStreamFromChunks([
        {
          candidates: [
            {
              content: { parts: [{ text: 'hi' }], role: 'model' },
              finishReason: 'stop',
            },
          ],
        },
      ]),
      true,
    );
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('completed');
    expect(stream.rawFinishReason).toBe('STOP');
  });

  // Executor偏离点: non-string raw values must fall back to null.
  it('falls back to null when raw finishReason is a non-string object', async () => {
    const stream = new GoogleGenAIStreamedMessage(
      googleStreamFromChunks([
        {
          candidates: [
            {
              content: { parts: [{ text: 'hi' }], role: 'model' },
              // The SDK may hand us an enum-like object; we must not emit
              // `[object Object]` into rawFinishReason.
              finishReason: { code: 'STOP' },
            },
          ],
        },
      ]),
      true,
    );
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBeNull();
    expect(stream.rawFinishReason).toBeNull();
  });

  // Executor偏离点: UNSPECIFIED chunks must not overwrite an already
  // captured real signal.
  it('does not overwrite a previously captured finishReason with UNSPECIFIED', async () => {
    // First chunk emits STOP, later chunk emits UNSPECIFIED. The
    // normalized signal must remain `completed`.
    const stream = new GoogleGenAIStreamedMessage(
      googleStreamFromChunks([
        {
          candidates: [
            {
              content: { parts: [{ text: 'hi' }], role: 'model' },
              finishReason: 'STOP',
            },
          ],
        },
        {
          candidates: [
            {
              content: { parts: [{ text: '!' }], role: 'model' },
              finishReason: 'FINISH_REASON_UNSPECIFIED',
            },
          ],
        },
      ]),
      true,
    );
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('completed');
    expect(stream.rawFinishReason).toBe('STOP');
  });

  // Executor偏离点: UNSPECIFIED chunks do not *block* later real signals.
  it('allows a later real finishReason to overwrite an earlier UNSPECIFIED', async () => {
    const stream = new GoogleGenAIStreamedMessage(
      googleStreamFromChunks([
        {
          candidates: [
            {
              content: { parts: [{ text: 'a' }], role: 'model' },
              finishReason: 'FINISH_REASON_UNSPECIFIED',
            },
          ],
        },
        {
          candidates: [
            {
              content: { parts: [{ text: 'b' }], role: 'model' },
              finishReason: 'STOP',
            },
          ],
        },
      ]),
      true,
    );
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('completed');
    expect(stream.rawFinishReason).toBe('STOP');
  });

  // D: stream never carries a finishReason at all.
  it('returns null when no chunk carries finishReason', async () => {
    const stream = new GoogleGenAIStreamedMessage(
      googleStreamFromChunks([
        { candidates: [{ content: { parts: [{ text: 'hi' }], role: 'model' } }] },
      ]),
      true,
    );
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBeNull();
    expect(stream.rawFinishReason).toBeNull();
  });

  // Tolerate the snake_case key some SDK builds still emit.
  it('accepts snake_case `finish_reason` key on the candidate object', async () => {
    const stream = new GoogleGenAIStreamedMessage(
      googleStreamFromChunks([
        {
          candidates: [
            {
              content: { parts: [{ text: 'hi' }], role: 'model' },
              finish_reason: 'MAX_TOKENS',
            },
          ],
        },
      ]),
      true,
    );
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('truncated');
    expect(stream.rawFinishReason).toBe('MAX_TOKENS');
  });
});

describe('GoogleGenAIChatProvider finish reason (end-to-end)', () => {
  // B + C: end-to-end through the provider's generate() wrapper.
  it('captures finishReason from the provider.generate stream wrapper', async () => {
    const provider = new GoogleGenAIChatProvider({
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      stream: true,
    });
    async function* mockStream() {
      yield {
        candidates: [
          {
            content: { parts: [{ text: 'hi' }], role: 'model' },
            finishReason: 'MAX_TOKENS',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      };
    }
    const mockModels = (provider as any)._client.models as Record<string, unknown>;
    mockModels['generateContentStream'] = vi.fn().mockResolvedValue(mockStream());

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('truncated');
    expect(stream.rawFinishReason).toBe('MAX_TOKENS');
  });

  it('captures finishReason from a non-stream provider.generate response', async () => {
    const provider = new GoogleGenAIChatProvider({
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      stream: false,
    });
    const mockModels = (provider as any)._client.models as Record<string, unknown>;
    mockModels['generateContent'] = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: { parts: [{ text: 'hi' }], role: 'model' },
          finishReason: 'SAFETY',
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });

    const stream = await provider.generate('', [], [USER_MSG]);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('filtered');
    expect(stream.rawFinishReason).toBe('SAFETY');
  });
});

// =====================================================================
// E. generate() / step() propagation via MockChatProvider.
// =====================================================================

describe('MockChatProvider finishReason defaults and propagation', () => {
  const parts: StreamedMessagePart[] = [{ type: 'text', text: 'hi' }];

  it('defaults to completed/stop when constructor options omit the field', async () => {
    const provider = new MockChatProvider(parts);
    const stream = await provider.generate('', [], []);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('completed');
    expect(stream.rawFinishReason).toBe('stop');
  });

  it('accepts an explicit null finishReason override', async () => {
    const provider = new MockChatProvider(parts, {
      finishReason: null,
      rawFinishReason: null,
    });
    const stream = await provider.generate('', [], []);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBeNull();
    expect(stream.rawFinishReason).toBeNull();
  });

  it('propagates custom finishReason through generate()', async () => {
    const provider = new MockChatProvider(parts, {
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    const result = await generate(provider, '', [], [USER_MSG]);
    expect(result.finishReason).toBe('truncated');
    expect(result.rawFinishReason).toBe('length');
  });

  it('propagates default finishReason through generate() when not overridden', async () => {
    const provider = new MockChatProvider(parts);
    const result = await generate(provider, '', [], [USER_MSG]);
    expect(result.finishReason).toBe('completed');
    expect(result.rawFinishReason).toBe('stop');
  });

  it('propagates null finishReason through generate()', async () => {
    const provider = new MockChatProvider(parts, {
      finishReason: null,
      rawFinishReason: null,
    });
    const result = await generate(provider, '', [], [USER_MSG]);
    expect(result.finishReason).toBeNull();
    expect(result.rawFinishReason).toBeNull();
  });

  it('propagates custom finishReason through step()', async () => {
    const provider = new MockChatProvider(parts, {
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    const result = await step(provider, '', EMPTY_TOOLSET, [USER_MSG]);
    expect(result.finishReason).toBe('truncated');
    expect(result.rawFinishReason).toBe('length');
    // Make sure we also don't mutate the message propagation semantics.
    await result.toolResults();
  });

  it('propagates default finishReason through step()', async () => {
    const provider = new MockChatProvider(parts);
    const result = await step(provider, '', EMPTY_TOOLSET, [USER_MSG]);
    expect(result.finishReason).toBe('completed');
    expect(result.rawFinishReason).toBe('stop');
    await result.toolResults();
  });

  it('propagates null finishReason through step()', async () => {
    const provider = new MockChatProvider(parts, {
      finishReason: null,
      rawFinishReason: null,
    });
    const result = await step(provider, '', EMPTY_TOOLSET, [USER_MSG]);
    expect(result.finishReason).toBeNull();
    expect(result.rawFinishReason).toBeNull();
    await result.toolResults();
  });

  it('preserves finishReason when withThinking() is invoked', async () => {
    const provider = new MockChatProvider(parts, {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    const clone = provider.withThinking('high');
    const stream = await clone.generate('', [], []);
    for await (const _ of stream) {
      // drain
    }
    expect(stream.finishReason).toBe('filtered');
    expect(stream.rawFinishReason).toBe('content_filter');
  });
});
