import { describe, it, expect, vi } from 'vitest';

import { generate } from '../src/generate.js';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '../src/message.js';
import { OpenAILegacyChatProvider } from '../src/providers/openai-legacy.js';
import type { Tool } from '../src/tool.js';

// ── Helpers ──────────────────────────────────────────────────────────

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

function createProvider(
  options?: Partial<{
    stream: boolean;
    reasoningKey: string;
    model: string;
  }>,
): OpenAILegacyChatProvider {
  return new OpenAILegacyChatProvider({
    model: options?.model ?? 'gpt-4.1',
    apiKey: 'test-key',
    stream: options?.stream ?? false,
    reasoningKey: options?.reasoningKey,
  });
}

/** Capture the request body sent to OpenAI by mocking the client. */
async function captureRequestBody(
  provider: OpenAILegacyChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
): Promise<Record<string, unknown>> {
  let capturedBody: Record<string, unknown> | undefined;

  (provider as any)._client.chat.completions.create = vi
    .fn()
    .mockImplementation((params: unknown) => {
      capturedBody = params as Record<string, unknown>;
      return Promise.resolve(makeChatCompletionResponse());
    });

  const stream = await provider.generate(systemPrompt, tools, history);
  for await (const _ of stream) {
    // drain
  }

  expect(capturedBody).toBeDefined();
  return capturedBody!;
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

// ── Tests ────────────────────────────────────────────────────────────

describe('OpenAILegacyChatProvider', () => {
  describe('message conversion (COMMON_CASES)', () => {
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
      expect(body['tools']).toBeUndefined();
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

    it('tool call with image result flattens to text to satisfy API constraints', async () => {
      // OpenAI Chat Completions `tool` messages only accept text content.
      // Even when toolMessageConversion is unset, a tool result containing
      // image_url / audio_url / video_url parts must not be serialized as a
      // multimodal array — the API would reject the request with a 400.
      // The provider is expected to force `extract_text` in that case.
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

      const toolMsg = (body['messages'] as Record<string, unknown>[])[2]!;
      expect(toolMsg['role']).toBe('tool');
      expect(toolMsg['tool_call_id']).toBe('call_abc123');
      // Content must be a plain string, not a content-part array.
      expect(typeof toolMsg['content']).toBe('string');
      // The text segment must survive; the image must not appear as a
      // structured image_url part anywhere in the serialized content.
      expect(toolMsg['content']).toContain('5');
      expect(Array.isArray(toolMsg['content'])).toBe(false);
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

      // Full byte-for-byte match against the Python kosong snapshot:
      // - 4 messages in order: user, assistant (with 2 tool_calls), tool (call_add), tool (call_mul)
      // - user / assistant use compressed string content (single-TextPart compression)
      // - both tool messages preserve multi-part content arrays (not compressed)
      // - tools array preserved
      expect(body['messages']).toEqual([
        { role: 'user', content: 'Calculate 2+3 and 4*5' },
        {
          role: 'assistant',
          content: "I'll calculate both.",
          tool_calls: [
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
            {
              type: 'text',
              text: '<system-reminder>This is a system reminder</system-reminder>',
            },
            { type: 'text', text: '5' },
          ],
          tool_call_id: 'call_add',
        },
        {
          role: 'tool',
          content: [
            {
              type: 'text',
              text: '<system-reminder>This is a system reminder</system-reminder>',
            },
            { type: 'text', text: '20' },
          ],
          tool_call_id: 'call_mul',
        },
      ]);
      expect(body['tools']).toHaveLength(2);
    });
  });

  describe('reasoning content', () => {
    it('converts ThinkPart to configured reasoning key', async () => {
      const provider = createProvider({ reasoningKey: 'reasoning_content' });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Thinking...' },
            { type: 'text', text: '4.' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'Thanks!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['messages']).toEqual([
        { role: 'user', content: 'What is 2+2?' },
        {
          role: 'assistant',
          content: '4.',
          reasoning_content: 'Thinking...',
        },
        { role: 'user', content: 'Thanks!' },
      ]);
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
  });

  describe('maxTokens option', () => {
    it('wires OpenAILegacyOptions.maxTokens into the request body as max_tokens', async () => {
      const provider = new OpenAILegacyChatProvider({
        model: 'gpt-4.1',
        apiKey: 'test-key',
        stream: false,
        maxTokens: 1024,
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      expect(body['max_tokens']).toBe(1024);
    });

    it('does not inject max_tokens when maxTokens option is omitted', async () => {
      const provider = new OpenAILegacyChatProvider({
        model: 'gpt-4.1',
        apiKey: 'test-key',
        stream: false,
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      expect(body['max_tokens']).toBeUndefined();
    });

    it('exposes max_tokens via modelParameters', () => {
      const provider = new OpenAILegacyChatProvider({
        model: 'gpt-4.1',
        apiKey: 'test-key',
        maxTokens: 2048,
      });
      expect(provider.modelParameters['max_tokens']).toBe(2048);
    });
  });

  describe('toolMessageConversion option', () => {
    it('flattens tool message content to a string when set to extract_text', async () => {
      const provider = new OpenAILegacyChatProvider({
        model: 'gpt-4.1',
        apiKey: 'test-key',
        stream: false,
        toolMessageConversion: 'extract_text',
      });
      const toolCall: ToolCall = {
        type: 'function',
        id: 'call_abc123',
        function: { name: 'add', arguments: '{"a": 2, "b": 3}' },
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: "I'll add them." }],
          toolCalls: [toolCall],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'part-1' },
            { type: 'text', text: 'part-2' },
          ],
          toolCallId: 'call_abc123',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as Record<string, unknown>[];
      const toolMsg = messages[2]!;
      expect(toolMsg['role']).toBe('tool');
      // With extract_text, content must be a plain string (concatenated text),
      // not an array of content parts.
      expect(typeof toolMsg['content']).toBe('string');
      expect(toolMsg['content']).toBe('part-1part-2');
    });

    it('forces string content when tool result contains audio_url even with default conversion', async () => {
      const provider = createProvider();
      const toolCall: ToolCall = {
        type: 'function',
        id: 'call_audio',
        function: { name: 'fetch_audio', arguments: '{}' },
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Play it' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          toolCalls: [toolCall],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'audio result' },
            { type: 'audio_url', audioUrl: { url: 'https://example.com/a.mp3' } },
          ] satisfies ContentPart[],
          toolCallId: 'call_audio',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const toolMsg = (body['messages'] as Record<string, unknown>[])[2]!;
      expect(typeof toolMsg['content']).toBe('string');
    });

    it('forces string content when tool result contains video_url even with default conversion', async () => {
      const provider = createProvider();
      const toolCall: ToolCall = {
        type: 'function',
        id: 'call_video',
        function: { name: 'fetch_video', arguments: '{}' },
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Show it' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          toolCalls: [toolCall],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'video result' },
            { type: 'video_url', videoUrl: { url: 'https://example.com/v.mp4' } },
          ] satisfies ContentPart[],
          toolCallId: 'call_video',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const toolMsg = (body['messages'] as Record<string, unknown>[])[2]!;
      expect(typeof toolMsg['content']).toBe('string');
    });

    it('keeps default text-only tool message as plain string', async () => {
      const provider = createProvider();
      const toolCall: ToolCall = {
        type: 'function',
        id: 'call_text',
        function: { name: 'add', arguments: '{"a":1,"b":2}' },
      };
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 1 2' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          toolCalls: [toolCall],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '3' }],
          toolCallId: 'call_text',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const toolMsg = (body['messages'] as Record<string, unknown>[])[2]!;
      // Single-text tool result with default conversion stays as a plain string.
      expect(toolMsg['content']).toBe('3');
    });

    it('preserves default tool message content as array when option is omitted', async () => {
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
          content: [{ type: 'text', text: "I'll add them." }],
          toolCalls: [toolCall],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'part-1' },
            { type: 'text', text: 'part-2' },
          ],
          toolCallId: 'call_abc123',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);
      const messages = body['messages'] as Record<string, unknown>[];
      const toolMsg = messages[2]!;
      // Default behavior: two text parts stay as a content-part array.
      expect(Array.isArray(toolMsg['content'])).toBe(true);
    });
  });

  describe('with thinking', () => {
    it('.withThinking("high") sets reasoning_effort', async () => {
      const provider = createProvider().withThinking('high');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['reasoning_effort']).toBe('high');
    });
  });

  describe('auto reasoning_effort', () => {
    it('auto-injects reasoning_effort when history has ThinkPart and reasoningKey is set', async () => {
      const provider = createProvider({
        model: 'kimi-k2.5',
        reasoningKey: 'reasoning_content',
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Let me think...' },
            { type: 'text', text: 'Hi!' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'How are you?' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      // reasoning_effort should be auto-set because history contains ThinkPart
      expect(body['reasoning_effort']).toBe('medium');
      // reasoning_content should still be present in the message
      const messages = body['messages'] as Record<string, unknown>[];
      expect(messages[1]!['reasoning_content']).toBe('Let me think...');
    });

    it('does not auto-inject reasoning_effort when history has no ThinkPart', async () => {
      const provider = createProvider({
        model: 'kimi-k2.5',
        reasoningKey: 'reasoning_content',
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'How are you?' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['reasoning_effort']).toBeUndefined();
    });

    it('does not auto-inject reasoning_effort when reasoningKey is not set', async () => {
      // No reasoningKey configured
      const provider = createProvider({ model: 'some-model' });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Thinking...' },
            { type: 'text', text: 'Hi!' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'How are you?' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['reasoning_effort']).toBeUndefined();
    });
  });

  // ── Streaming: parallel tool call index routing (P1 regression) ─────
  //
  // OpenAI Chat Completions streams parallel tool calls with interleaved
  // argument deltas. Each delta carries `index` to identify the owning
  // tool call. The provider must preserve `index` on the yielded
  // ToolCallPart (and `_streamIndex` on the ToolCall header) so that
  // generate() can route deltas correctly.

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
      id: 'chatcmpl-parallel',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'gpt-4.1',
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
    for (const c of chunks) {
      yield c;
    }
  }

  it('routes interleaved parallel tool_call arguments by streaming index', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      stream: true,
    });

    // Interleave argument deltas across index 0 and 1. In the real
    // pre-fix code these deltas would all pile onto whichever tool call
    // was "most recently pending", corrupting both sets of arguments.
    const chunks = [
      makeChunk([{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '' } }]),
      makeChunk([{ index: 1, id: 'call_b', function: { name: 'write_file', arguments: '' } }]),
      makeChunk([{ index: 0, function: { arguments: '{"path":"' } }]),
      makeChunk([{ index: 1, function: { arguments: '{"path":"' } }]),
      makeChunk([{ index: 0, function: { arguments: '/a.txt"' } }]),
      makeChunk([{ index: 1, function: { arguments: '/b.txt","content":"hi"' } }]),
      makeChunk([{ index: 0, function: { arguments: '}' } }]),
      makeChunk([{ index: 1, function: { arguments: '}' } }]),
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
        id: 'call_a',
        function: { name: 'read_file', arguments: '{"path":"/a.txt"}' },
      },
      {
        type: 'function',
        id: 'call_b',
        function: { name: 'write_file', arguments: '{"path":"/b.txt","content":"hi"}' },
      },
    ]);

    // _streamIndex must not leak into the stored ToolCall shape.
    for (const tc of result.message.toolCalls) {
      expect(tc).not.toHaveProperty('_streamIndex');
    }
  });

  it('preserves index on ToolCallPart when streaming single tool call', async () => {
    // Single-tool-call path: verify `index` is present on yielded parts
    // so generate() can still use the map-based routing if it chooses.
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      stream: true,
    });

    const chunks = [
      makeChunk([{ index: 0, id: 'call_x', function: { name: 'f', arguments: '' } }]),
      makeChunk([{ index: 0, function: { arguments: '{"a":' } }]),
      makeChunk([{ index: 0, function: { arguments: '1}' } }]),
      makeChunk([], { finishReason: 'tool_calls', usage: true }),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any)._client.chat.completions.create = vi
      .fn()
      .mockResolvedValue(mockStream(chunks));

    const stream = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'x' }], toolCalls: [] }],
    );

    const parts: StreamedMessagePart[] = [];
    for await (const part of stream) {
      parts.push(part);
    }

    // First part should be the ToolCall header with _streamIndex = 0.
    const header = parts.find((p) => p.type === 'function') as
      | (ToolCall & { _streamIndex?: number | string })
      | undefined;
    expect(header).toBeDefined();
    expect(header!._streamIndex).toBe(0);

    // Every ToolCallPart must carry index = 0.
    const partDeltas = parts.filter((p) => p.type === 'tool_call_part');
    expect(partDeltas.length).toBeGreaterThan(0);
    for (const p of partDeltas) {
      expect((p as { index?: number | string }).index).toBe(0);
    }
  });

  it('buffers indexed argument deltas until the real tool name arrives', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      stream: true,
    });

    const chunks = [
      makeChunk([{ index: 0, id: 'call_delayed', function: { name: '', arguments: '' } }]),
      makeChunk([{ index: 0, function: { arguments: '{"a' } }]),
      makeChunk([{ index: 0, function: { name: 'foo' } }]),
      makeChunk([{ index: 0, function: { arguments: '":1}' } }]),
      makeChunk([], { finishReason: 'tool_calls', usage: true }),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any)._client.chat.completions.create = vi
      .fn()
      .mockResolvedValue(mockStream(chunks));

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

describe('OpenAILegacyChatProvider — non-stream response parsing', () => {
  function makeNonStreamResponse(message: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'chatcmpl-test123',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4.1',
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }

  async function collectFromMockedResponse(
    provider: OpenAILegacyChatProvider,
    response: Record<string, unknown>,
  ): Promise<StreamedMessagePart[]> {
    (provider as any)._client.chat.completions.create = vi.fn().mockResolvedValue(response);

    const stream = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
    );
    const parts: StreamedMessagePart[] = [];
    for await (const part of stream) parts.push(part);
    return parts;
  }

  it('yields ThinkPart from non-stream response when reasoningKey content is present', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'deepseek-reasoner',
      apiKey: 'test-key',
      stream: false,
      reasoningKey: 'reasoning_content',
    });

    const parts = await collectFromMockedResponse(
      provider,
      makeNonStreamResponse({
        role: 'assistant',
        content: 'Final answer',
        reasoning_content: 'Some thinking here.',
      }),
    );

    expect(parts).toEqual([
      { type: 'think', think: 'Some thinking here.' },
      { type: 'text', text: 'Final answer' },
    ]);
  });

  it('non-stream response yields ToolCall parts when tool_calls present', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      stream: false,
    });

    const parts = await collectFromMockedResponse(
      provider,
      makeNonStreamResponse({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_x',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"hi"}' },
          },
        ],
      }),
    );

    const toolCall = parts.find((p) => p.type === 'function');
    expect(toolCall).toMatchObject({
      type: 'function',
      id: 'call_x',
      function: { name: 'lookup', arguments: '{"q":"hi"}' },
    });
  });

  it('non-stream response generates a fresh ID when tool_call has no id', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      stream: false,
    });

    const parts = await collectFromMockedResponse(
      provider,
      makeNonStreamResponse({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
      }),
    );

    const toolCall = parts.find((p) => p.type === 'function');
    expect(toolCall).toBeDefined();
    expect((toolCall as ToolCall).id).toBeTruthy();
    expect((toolCall as ToolCall).id.length).toBeGreaterThan(0);
  });

  it('non-stream response yields reasoning_content as ThinkPart', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'deepseek-reasoner',
      apiKey: 'test-key',
      stream: false,
      reasoningKey: 'reasoning_content',
    });

    const parts = await collectFromMockedResponse(
      provider,
      makeNonStreamResponse({
        role: 'assistant',
        content: 'Final answer',
        reasoning_content: 'Let me think step by step',
      }),
    );

    expect(parts).toEqual([
      { type: 'think', think: 'Let me think step by step' },
      { type: 'text', text: 'Final answer' },
    ]);
  });
});

describe('OpenAILegacyChatProvider — non-indexed streaming tool_calls', () => {
  async function* mockStream(
    chunks: Record<string, unknown>[],
  ): AsyncIterable<Record<string, unknown>> {
    for (const c of chunks) yield c;
  }

  it('handles non-indexed tool_call delta with concrete name', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      stream: true,
    });

    const chunks = [
      {
        id: 'chatcmpl-noidx',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: 'call_noidx',
                  function: { name: 'foo', arguments: '{"a":1}' },
                  // No index!
                },
              ],
            },
          },
        ],
      },
    ];

    (
      provider as unknown as { _client: { chat: { completions: { create: unknown } } } }
    )._client.chat.completions.create = vi.fn().mockResolvedValue(mockStream(chunks));

    const result = await generate(
      provider,
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'do' }], toolCalls: [] }],
    );

    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'call_noidx',
        function: { name: 'foo', arguments: '{"a":1}' },
      },
    ]);
  });

  it('handles non-indexed tool_call delta with arguments only emits tool_call_part', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      stream: true,
    });

    const chunks = [
      {
        id: 'chatcmpl-argonly',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ function: { arguments: '{"x":1}' } }],
            },
          },
        ],
      },
    ];

    (
      provider as unknown as { _client: { chat: { completions: { create: unknown } } } }
    )._client.chat.completions.create = vi.fn().mockResolvedValue(mockStream(chunks));

    const stream = await provider.generate('', [], []);
    const parts: Array<Record<string, unknown>> = [];
    for await (const p of stream) parts.push(p as unknown as Record<string, unknown>);

    expect(parts).toEqual([{ type: 'tool_call_part', argumentsPart: '{"x":1}' }]);
  });

  it('handles tool_call delta with no function field (early return)', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      stream: true,
    });

    const chunks = [
      {
        id: 'chatcmpl-nofn',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0 }], // no function field
            },
          },
        ],
      },
    ];

    (
      provider as unknown as { _client: { chat: { completions: { create: unknown } } } }
    )._client.chat.completions.create = vi.fn().mockResolvedValue(mockStream(chunks));

    const stream = await provider.generate('', [], []);
    const parts: Array<Record<string, unknown>> = [];
    for await (const p of stream) parts.push(p as unknown as Record<string, unknown>);

    // No parts yielded — the tool_call without function is silently ignored.
    expect(parts).toEqual([]);
  });
});
