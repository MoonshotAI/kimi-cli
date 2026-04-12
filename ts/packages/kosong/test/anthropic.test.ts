import { describe, it, expect, vi } from 'vitest';

import { ChatProviderError } from '../src/errors.js';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '../src/message.js';
import { AnthropicChatProvider } from '../src/providers/anthropic.js';
import type { Tool } from '../src/tool.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeAnthropicResponse(model: string = 'claude-sonnet-4-20250514') {
  return {
    id: 'msg_test_123',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function createProvider(
  model: string = 'claude-sonnet-4-20250514',
  metadata?: Record<string, string>,
): AnthropicChatProvider {
  return new AnthropicChatProvider({
    model,
    apiKey: 'test-key',
    defaultMaxTokens: 1024,
    metadata,
    stream: false,
  });
}

function createStreamProvider(model: string = 'claude-sonnet-4-20250514'): AnthropicChatProvider {
  return new AnthropicChatProvider({
    model,
    apiKey: 'test-key',
    defaultMaxTokens: 1024,
    stream: true,
  });
}

type AnthropicGenerationState = {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_k?: number | undefined;
  top_p?: number | undefined;
  thinking?:
    | { type: 'disabled' }
    | { type: 'adaptive' }
    | { type: 'enabled'; budget_tokens: number }
    | undefined;
  betaFeatures?: string[] | undefined;
};

function getGenerationState(provider: AnthropicChatProvider): AnthropicGenerationState {
  return Reflect.get(provider, '_generationKwargs') as AnthropicGenerationState;
}

/** Capture the request body sent to Anthropic by mocking the client (non-stream mode). */
async function captureRequestBody(
  provider: AnthropicChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
): Promise<Record<string, unknown>> {
  let capturedParams: Record<string, unknown> | undefined;
  let capturedOptions: Record<string, unknown> | undefined;

  (provider as any)._client.messages.create = vi
    .fn()
    .mockImplementation((params: unknown, options?: unknown) => {
      capturedParams = params as Record<string, unknown>;
      capturedOptions = options as Record<string, unknown> | undefined;
      return Promise.resolve(makeAnthropicResponse());
    });

  const stream = await provider.generate(systemPrompt, tools, history);
  // Drain the stream
  for await (const _ of stream) {
    // consume
  }

  expect(capturedParams).toBeDefined();

  // Merge extra_headers into result for test inspection
  const result = { ...capturedParams! };
  if (capturedOptions !== undefined && capturedOptions['headers'] !== undefined) {
    result['_extra_headers'] = capturedOptions['headers'];
  }
  return result;
}

/** Create a mock stream that yields the given events as an async iterable. */
function mockStream(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

/** Collect all parts from a StreamedMessage. */
async function collectParts(
  streamedMessage: AsyncIterable<StreamedMessagePart>,
): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of streamedMessage) {
    parts.push(part);
  }
  return parts;
}

// ── Test data ────────────────────────────────────────────────────────

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

const B64_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA' +
  'DUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ── Tests ────────────────────────────────────────────────────────────

describe('AnthropicChatProvider', () => {
  describe('message conversion', () => {
    it('simple user message with system prompt', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, 'You are helpful.', [], history);

      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello!', cache_control: { type: 'ephemeral' } }],
        },
      ]);
      expect(body['system']).toEqual([
        { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
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
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }] },
        {
          role: 'user',
          content: [{ type: 'text', text: 'And 3+3?', cache_control: { type: 'ephemeral' } }],
        },
      ]);
      // No system when empty
      expect(body['system']).toBeUndefined();
    });

    it('multi-turn with system prompt', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, 'You are a math tutor.', [], history);

      expect(body['system']).toEqual([
        { type: 'text', text: 'You are a math tutor.', cache_control: { type: 'ephemeral' } },
      ]);
      expect(body['messages']).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }] },
        {
          role: 'user',
          content: [{ type: 'text', text: 'And 3+3?', cache_control: { type: 'ephemeral' } }],
        },
      ]);
    });

    it('image url content (url source)', async () => {
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
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.com/image.png' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('tool definitions with cache_control on last tool', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      expect(body['tools']).toEqual([
        {
          name: 'add',
          description: 'Add two integers.',
          input_schema: {
            type: 'object',
            properties: {
              a: { type: 'integer', description: 'First number' },
              b: { type: 'integer', description: 'Second number' },
            },
            required: ['a', 'b'],
          },
        },
        {
          name: 'multiply',
          description: 'Multiply two integers.',
          input_schema: {
            type: 'object',
            properties: {
              a: { type: 'integer', description: 'First number' },
              b: { type: 'integer', description: 'Second number' },
            },
            required: ['a', 'b'],
          },
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('tool call and tool result (Anthropic wire format)', async () => {
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
      const messages = body['messages'] as unknown[];

      // Assistant message has tool_use blocks
      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll add those numbers for you." },
          { type: 'tool_use', id: 'call_abc123', name: 'add', input: { a: 2, b: 3 } },
        ],
      });

      // Tool result is a user message with tool_result block
      expect(messages[2]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_abc123',
            content: [{ type: 'text', text: '5' }],
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('assistant with thinking (has encrypted -> ThinkingBlockParam)', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Let me think...', encrypted: 'sig_abc123' },
            { type: 'text', text: 'The answer is 4.' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'Thanks!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as unknown[];

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think...', signature: 'sig_abc123' },
          { type: 'text', text: 'The answer is 4.' },
        ],
      });
    });

    it('thinking without signature is stripped', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Thinking...' },
            { type: 'text', text: 'Hello!' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'Bye' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as unknown[];

      // Assistant message should have thinking stripped (no encrypted)
      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
      });
    });

    it('base64 image', async () => {
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe:' },
            {
              type: 'image_url',
              imageUrl: { url: `data:image/png;base64,${B64_PNG}` },
            },
          ] satisfies ContentPart[],
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe:' },
            {
              type: 'image',
              source: { type: 'base64', data: B64_PNG, media_type: 'image/png' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('redacted thinking (empty think with encrypted)', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: '', encrypted: 'enc_redacted_sig_xyz' },
            { type: 'text', text: '4.' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'Thanks!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as unknown[];

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'enc_redacted_sig_xyz' },
          { type: 'text', text: '4.' },
        ],
      });
    });
  });

  describe('generation kwargs', () => {
    it('applies temperature, top_p, and max_tokens', async () => {
      const provider = createProvider().withGenerationKwargs({
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 2048,
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['temperature']).toBe(0.7);
      expect(body['top_p']).toBe(0.9);
      expect(body['max_tokens']).toBe(2048);
    });

    it('combines thinking and max_tokens in internal state', () => {
      const provider = createProvider()
        .withThinking('high')
        .withGenerationKwargs({ max_tokens: 512 });
      const state = getGenerationState(provider);

      expect(state).toMatchObject({
        max_tokens: 512,
        thinking: { type: 'enabled', budget_tokens: 32_000 },
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

    it('shallow-merges repeated withGenerationKwargs calls and replaces duplicate keys', () => {
      const provider = createProvider()
        .withGenerationKwargs({ max_tokens: 256, temperature: 0.1 })
        .withGenerationKwargs({ max_tokens: 512 });

      expect(getGenerationState(provider)).toMatchObject({
        max_tokens: 512,
        temperature: 0.1,
      });
    });
  });

  describe('with thinking', () => {
    it('pre-4.6 model: high -> budget_tokens=32000', async () => {
      const provider = createProvider('claude-sonnet-4-20250514').withThinking('high');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32000 });
    });

    it('opus-4-6: uses adaptive thinking', async () => {
      const provider = createProvider('claude-opus-4-6-20260205').withThinking('high');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['thinking']).toEqual({ type: 'adaptive' });
      // Adaptive should remove interleaved-thinking beta
      const headers = body['_extra_headers'] as Record<string, string> | undefined;
      if (headers !== undefined && headers['anthropic-beta'] !== undefined) {
        expect(headers['anthropic-beta']).not.toContain('interleaved-thinking-2025-05-14');
      }
    });

    it('opus-4-6 with thinking off -> disabled', async () => {
      const provider = createProvider('claude-opus-4-6-20260205').withThinking('off');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['thinking']).toEqual({ type: 'disabled' });
    });

    it('replaces the previous thinking config when called again', () => {
      const provider = createProvider().withThinking('high').withThinking('off');

      expect(getGenerationState(provider).thinking).toEqual({ type: 'disabled' });
    });
  });

  describe('metadata', () => {
    it('forwards metadata to the request', async () => {
      const provider = createProvider('claude-sonnet-4-20250514', {
        user_id: 'test-session-id',
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['metadata']).toEqual({ user_id: 'test-session-id' });
    });

    it('omits metadata when not provided', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['metadata']).toBeUndefined();
    });
  });

  describe('thinkingEffort property', () => {
    it('returns null when no thinking configured', () => {
      const provider = createProvider();
      expect(provider.thinkingEffort).toBeNull();
    });

    it('opus-4-6 with thinking high -> "high" (adaptive)', () => {
      const provider = createProvider('claude-opus-4-6-20260205').withThinking('high');
      expect(provider.thinkingEffort).toBe('high');
    });

    it('opus-4-6 with thinking off -> "off"', () => {
      const provider = createProvider('claude-opus-4-6-20260205').withThinking('off');
      expect(provider.thinkingEffort).toBe('off');
    });

    it('pre-4.6 budget-based levels', () => {
      const low = createProvider().withThinking('low');
      expect(low.thinkingEffort).toBe('low');

      const med = createProvider().withThinking('medium');
      expect(med.thinkingEffort).toBe('medium');

      const high = createProvider().withThinking('high');
      expect(high.thinkingEffort).toBe('high');
    });
  });

  describe('provider properties', () => {
    it('has correct name and model', () => {
      const provider = createProvider();
      expect(provider.name).toBe('anthropic');
      expect(provider.modelName).toBe('claude-sonnet-4-20250514');
    });

    it('withThinking returns a new instance', () => {
      const provider = createProvider();
      const newProvider = provider.withThinking('high');
      expect(newProvider).toBeInstanceOf(AnthropicChatProvider);
      expect(newProvider).not.toBe(provider);
    });
  });

  describe('non-stream response parsing', () => {
    it('yields text content from non-stream response', async () => {
      const provider = createProvider();
      (provider as any)._client.messages.create = vi.fn().mockResolvedValue({
        id: 'msg_123',
        content: [{ type: 'text', text: 'Hello world' }],
        usage: { input_tokens: 10, output_tokens: 5 },
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
      expect(stream.id).toBe('msg_123');
      expect(stream.usage).toEqual({
        inputOther: 10,
        output: 5,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
    });

    it('yields thinking and tool_use from non-stream response', async () => {
      const provider = createProvider();
      (provider as any)._client.messages.create = vi.fn().mockResolvedValue({
        id: 'msg_456',
        content: [
          { type: 'thinking', thinking: 'Let me think...', signature: 'sig_abc' },
          { type: 'text', text: 'The answer is 4.' },
          { type: 'tool_use', id: 'tool_1', name: 'add', input: { a: 2, b: 3 } },
        ],
        usage: { input_tokens: 15, output_tokens: 10, cache_read_input_tokens: 5 },
      });

      const stream = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'What is 2+3?' }], toolCalls: [] }],
      );

      const parts = [];
      for await (const part of stream) {
        parts.push(part);
      }

      expect(parts).toEqual([
        { type: 'think', think: 'Let me think...', encrypted: 'sig_abc' },
        { type: 'text', text: 'The answer is 4.' },
        {
          type: 'function',
          id: 'tool_1',
          function: { name: 'add', arguments: '{"a":2,"b":3}' },
        },
      ]);
      expect(stream.usage).toEqual({
        inputOther: 15,
        output: 10,
        inputCacheRead: 5,
        inputCacheCreation: 0,
      });
    });
  });

  describe('stream response parsing', () => {
    it('yields text delta from stream events', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: {
            id: 'msg_stream_001',
            usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
        { type: 'message_delta', delta: {}, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.stream = vi.fn().mockReturnValue(stream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      const parts = await collectParts(result);

      expect(parts).toEqual([
        { type: 'text', text: '' },
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ]);
      expect(result.id).toBe('msg_stream_001');
      expect(result.usage).toEqual({
        inputOther: 10,
        output: 5,
        inputCacheRead: 3,
        inputCacheCreation: 2,
      });
    });

    it('yields thinking delta and signature from stream events', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_stream_002', usage: { input_tokens: 20 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me think' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: ' about this' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig_xyz' },
        },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'The answer is 4.' },
        },
        { type: 'message_delta', delta: {}, usage: { output_tokens: 15 } },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.stream = vi.fn().mockReturnValue(stream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] }],
      );

      const parts = await collectParts(result);

      expect(parts).toEqual([
        { type: 'think', think: '' },
        { type: 'think', think: 'Let me think' },
        { type: 'think', think: ' about this' },
        { type: 'think', think: '', encrypted: 'sig_xyz' },
        { type: 'text', text: '' },
        { type: 'text', text: 'The answer is 4.' },
      ]);
      expect(result.id).toBe('msg_stream_002');
      expect(result.usage).toEqual({
        inputOther: 20,
        output: 15,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
    });

    it('yields tool_use start and argument deltas from stream events', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_stream_003', usage: { input_tokens: 15 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: "I'll add those." },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_abc', name: 'add' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"a":' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '2,"b":3}' },
        },
        { type: 'message_delta', delta: {}, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.stream = vi.fn().mockReturnValue(stream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] }],
      );

      const parts = await collectParts(result);

      expect(parts).toEqual([
        { type: 'text', text: '' },
        { type: 'text', text: "I'll add those." },
        {
          type: 'function',
          id: 'toolu_abc',
          function: { name: 'add', arguments: '' },
          _streamIndex: 1,
        },
        { type: 'tool_call_part', argumentsPart: '{"a":', index: 1 },
        { type: 'tool_call_part', argumentsPart: '2,"b":3}', index: 1 },
      ]);
      expect(result.id).toBe('msg_stream_003');
    });

    it('streaming: parallel tool_use blocks route input_json_delta by block index', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_parallel_001', usage: { input_tokens: 10 } },
        },
        // Two tool_use blocks opened in order at index 0 and 1.
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_a', name: 'tool_a', input: {} },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_b', name: 'tool_b', input: {} },
        },
        // Interleaved input_json_delta chunks across the two blocks.
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"x":' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"y":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '1}' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '2}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.stream = vi.fn().mockReturnValue(stream) as never;

      const result = await provider.generate(
        '',
        [ADD_TOOL, MUL_TOOL],
        [{ role: 'user', content: [{ type: 'text', text: 'Run both tools' }], toolCalls: [] }],
      );

      // Raw stream parts carry block index on both ToolCall and ToolCallPart.
      const parts = await collectParts(result);
      expect(parts).toEqual([
        {
          type: 'function',
          id: 'toolu_a',
          function: { name: 'tool_a', arguments: '' },
          _streamIndex: 0,
        },
        {
          type: 'function',
          id: 'toolu_b',
          function: { name: 'tool_b', arguments: '' },
          _streamIndex: 1,
        },
        { type: 'tool_call_part', argumentsPart: '{"x":', index: 0 },
        { type: 'tool_call_part', argumentsPart: '{"y":', index: 1 },
        { type: 'tool_call_part', argumentsPart: '1}', index: 0 },
        { type: 'tool_call_part', argumentsPart: '2}', index: 1 },
      ]);
    });

    it('streaming: generate() assembles parallel tool calls via index routing', async () => {
      // End-to-end: verify that generate() routes interleaved deltas to the
      // correct ToolCall using the block index, producing fully-assembled
      // arguments per tool.
      const { generate } = await import('../src/generate.js');

      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_parallel_002', usage: { input_tokens: 10 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_a', name: 'tool_a', input: {} },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_b', name: 'tool_b', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"x":' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"y":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '1}' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '2}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.stream = vi.fn().mockReturnValue(stream) as never;

      const { message } = await generate(
        provider,
        '',
        [ADD_TOOL, MUL_TOOL],
        [{ role: 'user', content: [{ type: 'text', text: 'Run both' }], toolCalls: [] }],
      );

      expect(message.toolCalls.length).toBe(2);
      expect(message.toolCalls[0]!.id).toBe('toolu_a');
      expect(message.toolCalls[0]!.function.name).toBe('tool_a');
      expect(message.toolCalls[0]!.function.arguments).toBe('{"x":1}');
      expect(message.toolCalls[1]!.id).toBe('toolu_b');
      expect(message.toolCalls[1]!.function.name).toBe('tool_b');
      expect(message.toolCalls[1]!.function.arguments).toBe('{"y":2}');
      // _streamIndex should be stripped from stored tool calls.
      expect(
        (message.toolCalls[0] as ToolCall & { _streamIndex?: number })._streamIndex,
      ).toBeUndefined();
      expect(
        (message.toolCalls[1] as ToolCall & { _streamIndex?: number })._streamIndex,
      ).toBeUndefined();
    });

    it('converts stream errors to ChatProviderError', async () => {
      const provider = createStreamProvider();
      const errorStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'message_start',
            message: { id: 'msg_err', usage: { input_tokens: 5 } },
          };
          throw new Error('stream interrupted');
        },
      };

      (provider as any)._client.messages.stream = vi.fn().mockReturnValue(errorStream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      await expect(collectParts(result)).rejects.toThrow(ChatProviderError);
    });

    it('updates usage from message_delta with all fields', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: {
            id: 'msg_usage',
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 20,
            },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        {
          type: 'message_delta',
          delta: {},
          usage: {
            output_tokens: 42,
            cache_read_input_tokens: 55,
            cache_creation_input_tokens: 25,
            input_tokens: 105,
          },
        },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.stream = vi.fn().mockReturnValue(stream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      await collectParts(result);

      expect(result.usage).toEqual({
        inputOther: 105,
        output: 42,
        inputCacheRead: 55,
        inputCacheCreation: 25,
      });
    });

    it('redacted_thinking block yields encrypted think part', async () => {
      const provider = createStreamProvider();
      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_redacted', usage: { input_tokens: 10 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'redacted_thinking', data: 'enc_data_123' },
        },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } },
        { type: 'message_delta', delta: {}, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]);

      (provider as any)._client.messages.stream = vi.fn().mockReturnValue(stream) as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] }],
      );

      const parts = await collectParts(result);

      expect(parts).toEqual([
        { type: 'think', think: '', encrypted: 'enc_data_123' },
        { type: 'text', text: '' },
        { type: 'text', text: 'Done.' },
      ]);
    });
  });

  describe('stream option', () => {
    it('defaults to stream: true and calls messages.stream', async () => {
      const provider = new AnthropicChatProvider({
        model: 'claude-sonnet-4-20250514',
        apiKey: 'test-key',
        defaultMaxTokens: 1024,
      });

      const stream = mockStream([
        {
          type: 'message_start',
          message: { id: 'msg_default', usage: { input_tokens: 5 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'message_stop' },
      ]);

      const streamFn = vi.fn().mockReturnValue(stream);
      (provider as any)._client.messages.stream = streamFn as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      await collectParts(result);

      expect(streamFn).toHaveBeenCalledTimes(1);
    });

    it('stream: false calls messages.create', async () => {
      const provider = createProvider(); // stream: false
      const createFn = vi.fn().mockResolvedValue(makeAnthropicResponse());
      (provider as any)._client.messages.create = createFn as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      await collectParts(result);

      expect(createFn).toHaveBeenCalledTimes(1);
      // Verify stream: false is in the params
      const params = createFn.mock.calls[0]![0] as Record<string, unknown>;
      expect(params['stream']).toBe(false);
    });
  });

  describe('RetryableChatProvider.onRetryableError', () => {
    it('rebuilds the Anthropic client', () => {
      const provider = createProvider();
      const oldClient = (provider as any)._client;

      const result = provider.onRetryableError(new Error('transient'));

      expect(result).toBe(true);
      expect((provider as any)._client).not.toBe(oldClient);
    });

    it('next generate() uses the freshly rebuilt client', async () => {
      const provider = createProvider();

      // Mock the original client to respond normally — but we'll replace the
      // client via onRetryableError, so this mock should NEVER be called.
      const originalCreateFn = vi.fn().mockResolvedValue(makeAnthropicResponse());
      (provider as any)._client.messages.create = originalCreateFn as never;

      provider.onRetryableError(new Error('transient'));

      // Install a fresh mock on the *new* client instance.
      const newCreateFn = vi.fn().mockResolvedValue(makeAnthropicResponse());
      (provider as any)._client.messages.create = newCreateFn as never;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      await collectParts(result);

      expect(newCreateFn).toHaveBeenCalledTimes(1);
      expect(originalCreateFn).not.toHaveBeenCalled();
    });

    it('preserves apiKey across rebuilds (no re-read of env)', () => {
      const provider = new AnthropicChatProvider({
        model: 'claude-sonnet-4-20250514',
        apiKey: 'original-key',
        stream: false,
      });

      // Temporarily scrub env to ensure rebuild uses the stored key, not env.
      const prevEnv = process.env['ANTHROPIC_API_KEY'];
      delete process.env['ANTHROPIC_API_KEY'];
      try {
        expect(() => provider.onRetryableError(new Error('transient'))).not.toThrow();
        // The new client must still exist (and be reusable).
        expect((provider as any)._client).toBeDefined();
      } finally {
        if (prevEnv !== undefined) process.env['ANTHROPIC_API_KEY'] = prevEnv;
      }
    });
  });
});
