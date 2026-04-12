import { describe, it, expect, vi } from 'vitest';

import { generate } from '../src/generate.js';
import type { ContentPart, Message, ToolCall } from '../src/message.js';
import { KimiChatProvider } from '../src/providers/kimi.js';
import { extractUsageFromChunk } from '../src/providers/kimi.js';
import { extractUsage } from '../src/providers/openai-common.js';
import type { Tool } from '../src/tool.js';

// ── Helpers ───���───────────────────────────────────────────────────────

function makeChatCompletionResponse(model: string = 'test-model') {
  return {
    id: 'chatcmpl-test123',
    object: 'chat.completion',
    created: 1234567890,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function createProvider(stream: boolean = false): KimiChatProvider {
  return new KimiChatProvider({
    model: 'kimi-k2-turbo-preview',
    apiKey: 'test-key',
    stream,
  });
}

type KimiGenerationState = {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  reasoning_effort?: string | undefined;
  extra_body?: Record<string, unknown> | undefined;
};

function getGenerationState(provider: KimiChatProvider): KimiGenerationState {
  return Reflect.get(provider, '_generationKwargs') as KimiGenerationState;
}

/** Capture the request body sent to OpenAI by mocking the client. */
async function captureRequestBody(
  provider: KimiChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
): Promise<Record<string, unknown>> {
  let capturedBody: Record<string, unknown> | undefined;

  // Mock the OpenAI client's create method
  (provider as any)._client.chat.completions.create = vi
    .fn()
    .mockImplementation((params: unknown) => {
      capturedBody = params as Record<string, unknown>;
      return Promise.resolve(makeChatCompletionResponse('kimi-k2'));
    });

  const stream = await provider.generate(systemPrompt, tools, history);
  // Drain the stream
  for await (const _ of stream) {
    // consume
  }

  expect(capturedBody).toBeDefined();
  return capturedBody!;
}

// ── Test data ──────��──────────────────────────────────────────────────

const ADD_TOOL: Tool = {
  name: 'add',
  description: 'Add two integers.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'integer', description: 'First number' },
      b: { type: 'integer', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
};

const MUL_TOOL: Tool = {
  name: 'multiply',
  description: 'Multiply two integers.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'integer', description: 'First number' },
      b: { type: 'integer', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
};

const BUILTIN_TOOL: Tool = {
  name: '$web_search',
  description: 'Search the web',
  parameters: { type: 'object', properties: {} },
};

// ── Tests ────────────────────────────���────────────────────────────────

describe('KimiChatProvider', () => {
  describe('message conversion', () => {
    it('simple user message with system prompt', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, 'You are helpful.', [], history);

      expect(body['messages']).toEqual([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello!' },
      ]);
    });

    it('multi-turn conversation', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '2+2 equals 4.' },
        { role: 'user', content: 'And 3+3?' },
      ]);
    });

    it('multi-turn with system prompt', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, 'You are a math tutor.', [], history);

      expect(body['messages']).toEqual([
        { role: 'system', content: 'You are a math tutor.' },
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '2+2 equals 4.' },
        { role: 'user', content: 'And 3+3?' },
      ]);
    });

    it('image url content', async () => {
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: "What's in this image?" },
            { type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } },
          ] satisfies ContentPart[],
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: "What's in this image?" },
            { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
          ],
        },
      ]);
    });

    it('tool definitions', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      expect(body['tools']).toEqual([
        {
          type: 'function',
          function: {
            name: 'add',
            description: 'Add two integers.',
            parameters: {
              type: 'object',
              properties: {
                a: { type: 'integer', description: 'First number' },
                b: { type: 'integer', description: 'Second number' },
              },
              required: ['a', 'b'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'multiply',
            description: 'Multiply two integers.',
            parameters: {
              type: 'object',
              properties: {
                a: { type: 'integer', description: 'First number' },
                b: { type: 'integer', description: 'Second number' },
              },
              required: ['a', 'b'],
            },
          },
        },
      ]);
    });

    it('tool call and tool result', async () => {
      const provider = createProvider();
      const toolCall: ToolCall = {
        type: 'function',
        id: 'call_abc123',
        function: { name: 'add', arguments: '{"a": 2, "b": 3}' },
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: "I'll add those numbers for you." }],
          toolCalls: [toolCall],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '5' }],
          toolCallId: 'call_abc123',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([
        { role: 'user', content: 'Add 2 and 3' },
        {
          role: 'assistant',
          content: "I'll add those numbers for you.",
          tool_calls: [
            {
              type: 'function',
              id: 'call_abc123',
              function: { name: 'add', arguments: '{"a": 2, "b": 3}' },
            },
          ],
        },
        { role: 'tool', content: '5', tool_call_id: 'call_abc123' },
      ]);
    });

    it('tool call with image result', async () => {
      const provider = createProvider();
      const toolCall: ToolCall = {
        type: 'function',
        id: 'call_abc123',
        function: { name: 'add', arguments: '{"a": 2, "b": 3}' },
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: "I'll add those numbers for you." }],
          toolCalls: [toolCall],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: '5' },
            { type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } },
          ] satisfies ContentPart[],
          toolCallId: 'call_abc123',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect((body['messages'] as unknown[])[2]).toEqual({
        role: 'tool',
        content: [
          { type: 'text', text: '5' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
        ],
        tool_call_id: 'call_abc123',
      });
    });

    it('parallel tool calls', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Calculate 2+3 and 4*5' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: "I'll calculate both." }],
          toolCalls: [
            {
              type: 'function',
              id: 'call_add',
              function: { name: 'add', arguments: '{"a": 2, "b": 3}' },
            },
            {
              type: 'function',
              id: 'call_mul',
              function: { name: 'multiply', arguments: '{"a": 4, "b": 5}' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: '<system-reminder>This is a system reminder</system-reminder>' },
            { type: 'text', text: '5' },
          ],
          toolCallId: 'call_add',
          toolCalls: [],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: '<system-reminder>This is a system reminder</system-reminder>' },
            { type: 'text', text: '20' },
          ],
          toolCallId: 'call_mul',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      // Verify the assistant message has parallel tool calls
      const messages = body['messages'] as Record<string, unknown>[];
      expect(messages[1]!['tool_calls']).toEqual([
        {
          type: 'function',
          id: 'call_add',
          function: { name: 'add', arguments: '{"a": 2, "b": 3}' },
        },
        {
          type: 'function',
          id: 'call_mul',
          function: { name: 'multiply', arguments: '{"a": 4, "b": 5}' },
        },
      ]);

      // Verify tools are sent
      expect(body['tools']).toBeDefined();
    });

    it('builtin tool ($web_search)', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Search for something' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [BUILTIN_TOOL], history);

      expect(body['tools']).toEqual([
        {
          type: 'builtin_function',
          function: { name: '$web_search' },
        },
      ]);
    });

    it('assistant with reasoning content', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Let me think...' },
            { type: 'text', text: 'The answer is 4.' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'Thanks!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect((body['messages'] as unknown[])[1]).toEqual({
        role: 'assistant',
        content: 'The answer is 4.',
        reasoning_content: 'Let me think...',
      });
    });
  });

  describe('generation kwargs', () => {
    it('applies temperature and max_tokens', async () => {
      const provider = createProvider().withGenerationKwargs({
        temperature: 0.7,
        max_tokens: 2048,
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['temperature']).toBe(0.7);
      expect(body['max_tokens']).toBe(2048);
    });

    it('default max_tokens is 32000', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['max_tokens']).toBe(32000);
    });

    it('combines thinking and max_tokens in internal state', () => {
      const provider = createProvider()
        .withThinking('high')
        .withGenerationKwargs({ max_tokens: 512 });

      expect(getGenerationState(provider)).toEqual({
        reasoning_effort: 'high',
        extra_body: {
          thinking: { type: 'enabled' },
        },
        max_tokens: 512,
      });
    });

    it('keeps the same internal state regardless of withThinking/withGenerationKwargs order', () => {
      const thinkingThenKwargs = getGenerationState(
        createProvider().withThinking('high').withGenerationKwargs({ max_tokens: 512 }),
      );
      const kwargsThenThinking = getGenerationState(
        createProvider().withGenerationKwargs({ max_tokens: 512 }).withThinking('high'),
      );

      expect(kwargsThenThinking).toEqual(thinkingThenKwargs);
    });

    it('shallow-merges repeated withGenerationKwargs calls and replaces extra_body wholesale', () => {
      const provider = createProvider()
        .withGenerationKwargs({
          temperature: 0.1,
          extra_body: { first: true },
        })
        .withGenerationKwargs({
          max_tokens: 512,
          extra_body: { second: true },
        });

      expect(getGenerationState(provider)).toEqual({
        temperature: 0.1,
        max_tokens: 512,
        extra_body: { second: true },
      });
    });
  });

  describe('with thinking', () => {
    it('sets reasoning_effort and extra_body.thinking for high', async () => {
      const provider = createProvider().withThinking('high');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['reasoning_effort']).toBe('high');
      expect(body['extra_body']).toEqual({
        thinking: { type: 'enabled' },
      });
    });

    it('sets thinking disabled for off', async () => {
      const provider = createProvider().withThinking('off');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      // reasoning_effort should be removed (undefined)
      expect(body['reasoning_effort']).toBeUndefined();
      expect(body['extra_body']).toEqual({
        thinking: { type: 'disabled' },
      });
    });

    it('thinkingEffort property reflects current state', () => {
      const provider = createProvider();
      expect(provider.thinkingEffort).toBeNull();

      const withHigh = provider.withThinking('high');
      expect(withHigh.thinkingEffort).toBe('high');

      const withLow = provider.withThinking('low');
      expect(withLow.thinkingEffort).toBe('low');
    });

    it('replaces the previous thinking effort when called again', () => {
      const provider = createProvider().withThinking('high').withThinking('off');

      expect(getGenerationState(provider)).toEqual({
        reasoning_effort: undefined,
        extra_body: {
          thinking: { type: 'disabled' },
        },
      });
    });
  });

  describe('provider properties', () => {
    it('has correct name and model', () => {
      const provider = createProvider();
      expect(provider.name).toBe('kimi');
      expect(provider.modelName).toBe('kimi-k2-turbo-preview');
    });

    it('throws when no API key is provided', () => {
      // Save and clear env var
      const saved = process.env['KIMI_API_KEY'];
      delete process.env['KIMI_API_KEY'];
      try {
        expect(() => new KimiChatProvider({ model: 'test' })).toThrow(/apiKey.*KIMI_API_KEY/);
      } finally {
        if (saved !== undefined) {
          process.env['KIMI_API_KEY'] = saved;
        }
      }
    });

    it('withThinking returns a new instance', () => {
      const provider = createProvider();
      const newProvider = provider.withThinking('high');
      expect(newProvider).toBeInstanceOf(KimiChatProvider);
      expect(newProvider).not.toBe(provider);
    });

    it('withGenerationKwargs returns a new instance', () => {
      const provider = createProvider();
      const newProvider = provider.withGenerationKwargs({ temperature: 0.5 });
      expect(newProvider).toBeInstanceOf(KimiChatProvider);
      expect(newProvider).not.toBe(provider);
    });

    it('withGenerationKwargs does not mutate the original', () => {
      const provider = createProvider();
      const newProvider = provider.withGenerationKwargs({ temperature: 0.5 });
      expect(getGenerationState(provider)).toEqual({});
      expect(getGenerationState(newProvider)).toEqual({ temperature: 0.5 });
    });
  });

  describe('non-stream response parsing', () => {
    it('yields text content from non-stream response', async () => {
      const provider = createProvider();
      (provider as any)._client.chat.completions.create = vi.fn().mockResolvedValue({
        id: 'chatcmpl-123',
        choices: [{ message: { role: 'assistant', content: 'Hello world' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const stream = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      const parts = [];
      for await (const part of stream) {
        parts.push(part);
      }

      expect(parts).toEqual([{ type: 'text', text: 'Hello world' }]);
      expect(stream.id).toBe('chatcmpl-123');
      expect(stream.usage).toEqual({
        inputOther: 10,
        output: 5,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
    });

    it('yields reasoning_content as ThinkPart', async () => {
      const provider = createProvider();
      (provider as any)._client.chat.completions.create = vi.fn().mockResolvedValue({
        id: 'chatcmpl-123',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'The answer is 4.',
              reasoning_content: 'Let me think about this...',
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const stream = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] }],
      );

      const parts = [];
      for await (const part of stream) {
        parts.push(part);
      }

      expect(parts).toEqual([
        { type: 'think', think: 'Let me think about this...' },
        { type: 'text', text: 'The answer is 4.' },
      ]);
    });
  });

  describe('streaming tool call routing', () => {
    interface MockToolCallDelta {
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }

    function makeChunk(
      toolCalls: MockToolCallDelta[],
      opts?: { finishReason?: string; usage?: boolean },
    ): Record<string, unknown> {
      const chunk: Record<string, unknown> = {
        id: 'chatcmpl-kimi-stream',
        object: 'chat.completion.chunk',
        created: 1234567890,
        model: 'kimi-k2-turbo-preview',
        choices: [
          {
            index: 0,
            delta: { tool_calls: toolCalls },
            finish_reason: opts?.finishReason ?? null,
          },
        ],
      };
      if (opts?.usage) {
        chunk['usage'] = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
      }
      return chunk;
    }

    async function* mockStream(
      chunks: Record<string, unknown>[],
    ): AsyncIterable<Record<string, unknown>> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    it('buffers indexed argument deltas until the real tool name arrives', async () => {
      const provider = createProvider(true);

      const chunks = [
        makeChunk([{ index: 0, id: 'call_delayed', function: { name: '', arguments: '' } }]),
        makeChunk([{ index: 0, function: { arguments: '{"a' } }]),
        makeChunk([{ index: 0, function: { name: 'foo' } }]),
        makeChunk([{ index: 0, function: { arguments: '":1}' } }]),
        makeChunk([], { finishReason: 'tool_calls', usage: true }),
      ];

      (
        provider as unknown as { _client: { chat: { completions: { create: unknown } } } }
      )._client.chat.completions.create = vi.fn().mockResolvedValue(mockStream(chunks));

      const result = await generate(
        provider,
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'do it' }], toolCalls: [] }],
      );

      expect(result.message.toolCalls).toEqual([
        {
          type: 'function',
          id: 'call_delayed',
          function: { name: 'foo', arguments: '{"a":1}' },
        },
      ]);
    });
  });
});

describe('extractUsageFromChunk', () => {
  it('extracts top-level usage', () => {
    const chunk = {
      id: 'test',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const usage = extractUsageFromChunk(chunk);
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('extracts choices[0].usage (Moonshot proprietary)', () => {
    const chunk = {
      id: 'chatcmpl-6970b5d02fa474c1767e8767',
      object: 'chat.completion.chunk',
      created: 1768994256,
      model: 'kimi-k2-turbo-preview',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
          usage: {
            prompt_tokens: 8,
            completion_tokens: 11,
            total_tokens: 19,
            cached_tokens: 8,
          },
        },
      ],
      system_fingerprint: 'fpv0_10a6da87',
    };

    const rawUsage = extractUsageFromChunk(chunk);
    expect(rawUsage).not.toBeNull();
    expect(rawUsage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 11,
      total_tokens: 19,
      cached_tokens: 8,
    });

    // Also verify extractUsage converts it to TokenUsage correctly
    const tokenUsage = extractUsage(rawUsage);
    expect(tokenUsage).toEqual({
      inputOther: 0, // 8 - 8 (cached)
      output: 11,
      inputCacheRead: 8,
      inputCacheCreation: 0,
    });
  });

  it('returns null when no usage is present', () => {
    const chunk = {
      id: 'test',
      choices: [{ index: 0, delta: { content: 'hello' } }],
    };
    expect(extractUsageFromChunk(chunk)).toBeNull();
  });

  it('returns null when choices is empty', () => {
    const chunk = { id: 'test', choices: [] };
    expect(extractUsageFromChunk(chunk)).toBeNull();
  });
});

describe('extractUsage', () => {
  it('extracts basic usage', () => {
    const usage = extractUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(usage).toEqual({
      inputOther: 10,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('extracts usage with Moonshot cached_tokens', () => {
    const usage = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cached_tokens: 60,
    });
    expect(usage).toEqual({
      inputOther: 40,
      output: 20,
      inputCacheRead: 60,
      inputCacheCreation: 0,
    });
  });

  it('extracts usage with OpenAI prompt_tokens_details', () => {
    const usage = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 50 },
    });
    expect(usage).toEqual({
      inputOther: 50,
      output: 20,
      inputCacheRead: 50,
      inputCacheCreation: 0,
    });
  });

  it('returns null for null/undefined', () => {
    expect(extractUsage(null)).toBeNull();
    expect(extractUsage()).toBeNull();
  });
});
