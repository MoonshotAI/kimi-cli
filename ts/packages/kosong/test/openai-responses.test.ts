import { describe, it, expect, vi } from 'vitest';

import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '../src/message.js';
import {
  OpenAIResponsesChatProvider,
  OpenAIResponsesStreamedMessage,
} from '../src/providers/openai-responses.js';
import type { Tool } from '../src/tool.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeResponsesAPIResponse() {
  return {
    id: 'resp_test123',
    object: 'response',
    created_at: 1234567890,
    status: 'completed',
    model: 'gpt-4.1',
    output: [
      {
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

function createProvider(): OpenAIResponsesChatProvider {
  return new OpenAIResponsesChatProvider({
    model: 'gpt-4.1',
    apiKey: 'test-key',
  });
}

/** Capture the request body sent to the Responses API by mocking the client.
 *  Forces non-stream mode so the mock can return a plain response object. */
async function captureRequestBody(
  provider: OpenAIResponsesChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
): Promise<Record<string, unknown>> {
  let capturedBody: Record<string, unknown> | undefined;

  // Force non-stream so mock returns a plain object
  (provider as any)._stream = false;

  // Mock the responses.create method
  ((provider as any)._client.responses as unknown as Record<string, unknown>)['create'] = vi
    .fn()
    .mockImplementation((params: unknown) => {
      capturedBody = params as Record<string, unknown>;
      return Promise.resolve(makeResponsesAPIResponse());
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

describe('OpenAIResponsesChatProvider', () => {
  describe('message conversion', () => {
    it('simple user message with system prompt', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, 'You are helpful.', [], history);

      expect(body['input']).toEqual([
        // gpt-4.1 is an OpenAI model -> developer role
        { role: 'developer', content: 'You are helpful.' },
        {
          content: [{ type: 'input_text', text: 'Hello!' }],
          role: 'user',
          type: 'message',
        },
      ]);
      expect(body['tools']).toEqual([]);
    });

    it('multi-turn conversation', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['input']).toEqual([
        {
          content: [{ type: 'input_text', text: 'What is 2+2?' }],
          role: 'user',
          type: 'message',
        },
        {
          content: [{ type: 'output_text', text: '2+2 equals 4.', annotations: [] }],
          role: 'assistant',
          type: 'message',
        },
        {
          content: [{ type: 'input_text', text: 'And 3+3?' }],
          role: 'user',
          type: 'message',
        },
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

      expect(body['input']).toEqual([
        { role: 'developer', content: 'You are a math tutor.' },
        {
          content: [{ type: 'input_text', text: 'What is 2+2?' }],
          role: 'user',
          type: 'message',
        },
        {
          content: [{ type: 'output_text', text: '2+2 equals 4.', annotations: [] }],
          role: 'assistant',
          type: 'message',
        },
        {
          content: [{ type: 'input_text', text: 'And 3+3?' }],
          role: 'user',
          type: 'message',
        },
      ]);
    });

    it('image url in user message is encoded as input_image', async () => {
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: "What's in this image?" },
            { type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } },
          ],
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['input']).toEqual([
        {
          content: [
            { type: 'input_text', text: "What's in this image?" },
            {
              type: 'input_image',
              detail: 'auto',
              image_url: 'https://example.com/image.png',
            },
          ],
          role: 'user',
          type: 'message',
        },
      ]);
    });

    it('parallel tool calls produce multiple function_call and function_call_output items', async () => {
      const provider = createProvider();
      const history: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Calculate 2+3 and 4*5' }],
          toolCalls: [],
        },
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
            {
              type: 'text',
              text: '<system-reminder>This is a system reminder</system-reminder>',
            },
            { type: 'text', text: '5' },
          ],
          toolCallId: 'call_add',
          toolCalls: [],
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
          toolCallId: 'call_mul',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      const input = body['input'] as unknown[];

      // user
      expect(input[0]).toEqual({
        content: [{ type: 'input_text', text: 'Calculate 2+3 and 4*5' }],
        role: 'user',
        type: 'message',
      });
      // assistant text
      expect(input[1]).toEqual({
        content: [{ type: 'output_text', text: "I'll calculate both.", annotations: [] }],
        role: 'assistant',
        type: 'message',
      });
      // function_call #1
      expect(input[2]).toEqual({
        arguments: '{"a": 2, "b": 3}',
        call_id: 'call_add',
        name: 'add',
        type: 'function_call',
      });
      // function_call #2
      expect(input[3]).toEqual({
        arguments: '{"a": 4, "b": 5}',
        call_id: 'call_mul',
        name: 'multiply',
        type: 'function_call',
      });
      // function_call_output #1
      expect(input[4]).toEqual({
        call_id: 'call_add',
        output: [
          {
            type: 'input_text',
            text: '<system-reminder>This is a system reminder</system-reminder>',
          },
          { type: 'input_text', text: '5' },
        ],
        type: 'function_call_output',
      });
      // function_call_output #2
      expect(input[5]).toEqual({
        call_id: 'call_mul',
        output: [
          {
            type: 'input_text',
            text: '<system-reminder>This is a system reminder</system-reminder>',
          },
          { type: 'input_text', text: '20' },
        ],
        type: 'function_call_output',
      });

      // tools array preserved
      expect(body['tools']).toHaveLength(2);
    });

    it('tool definitions include strict: false', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      expect(body['tools']).toEqual([
        {
          type: 'function',
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
          strict: false,
        },
        {
          type: 'function',
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
          strict: false,
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

      const input = body['input'] as unknown[];
      // user message
      expect(input[0]).toEqual({
        content: [{ type: 'input_text', text: 'Add 2 and 3' }],
        role: 'user',
        type: 'message',
      });
      // assistant message
      expect(input[1]).toEqual({
        content: [
          {
            type: 'output_text',
            text: "I'll add those numbers for you.",
            annotations: [],
          },
        ],
        role: 'assistant',
        type: 'message',
      });
      // function_call
      expect(input[2]).toEqual({
        arguments: '{"a": 2, "b": 3}',
        call_id: 'call_abc123',
        name: 'add',
        type: 'function_call',
      });
      // function_call_output
      expect(input[3]).toEqual({
        call_id: 'call_abc123',
        output: [{ type: 'input_text', text: '5' }],
        type: 'function_call_output',
      });
    });

    it('assistant with reasoning (ThinkPart with encrypted)', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Thinking...', encrypted: 'enc_abc' },
            { type: 'text', text: '4.' },
          ],
          toolCalls: [],
        },
        { role: 'user', content: [{ type: 'text', text: 'Thanks!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      const input = body['input'] as unknown[];
      expect(input[0]).toEqual({
        content: [{ type: 'input_text', text: 'What is 2+2?' }],
        role: 'user',
        type: 'message',
      });
      // reasoning item
      expect(input[1]).toEqual({
        summary: [{ type: 'summary_text', text: 'Thinking...' }],
        type: 'reasoning',
        encrypted_content: 'enc_abc',
      });
      // assistant text after reasoning
      expect(input[2]).toEqual({
        content: [{ type: 'output_text', text: '4.', annotations: [] }],
        role: 'assistant',
        type: 'message',
      });
      expect(input[3]).toEqual({
        content: [{ type: 'input_text', text: 'Thanks!' }],
        role: 'user',
        type: 'message',
      });
    });

    it('audio url in tool result is encoded as input_file', async () => {
      // Regression (Codex Round 9 P2): `messageContentToFunctionOutputItems`
      // only handled text + image_url, so audio returned by a tool would
      // be silently dropped in the next turn. Now audio_url parts must be
      // routed through the same `mapAudioUrlToInputItem` encoder used for
      // user messages.
      const provider = createProvider();
      const toolCall: ToolCall = {
        type: 'function',
        id: 'call_audio',
        function: { name: 'tts', arguments: '{"text":"hi"}' },
      };
      const dataUrl = 'data:audio/mp3;base64,QUJD';
      const httpsUrl = 'https://example.com/speech.wav';
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Say hi' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [],
          toolCalls: [toolCall],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'done' },
            { type: 'audio_url', audioUrl: { url: dataUrl } },
            { type: 'audio_url', audioUrl: { url: httpsUrl } },
          ] satisfies ContentPart[],
          toolCallId: 'call_audio',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      const input = body['input'] as unknown[];
      // Locate the function_call_output item.
      const functionCallOutput = input.find(
        (item) => (item as Record<string, unknown>)['type'] === 'function_call_output',
      ) as Record<string, unknown> | undefined;
      expect(functionCallOutput).toBeDefined();

      const output = functionCallOutput!['output'] as unknown[];
      expect(output).toEqual([
        { type: 'input_text', text: 'done' },
        { type: 'input_file', file_data: 'QUJD', filename: 'inline.mp3' },
        { type: 'input_file', file_url: httpsUrl },
      ]);
    });

    it('image url in tool result', async () => {
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

      const input = body['input'] as unknown[];
      expect(input[3]).toEqual({
        call_id: 'call_abc123',
        output: [
          { type: 'input_text', text: '5' },
          { type: 'input_image', image_url: 'https://example.com/image.png' },
        ],
        type: 'function_call_output',
      });
    });
  });

  describe('generation kwargs', () => {
    it('applies temperature and max_output_tokens', async () => {
      const provider = createProvider().withGenerationKwargs({
        temperature: 0.7,
        max_output_tokens: 2048,
      });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['temperature']).toBe(0.7);
      expect(body['max_output_tokens']).toBe(2048);
    });
  });

  describe('reasoning configuration', () => {
    it('omits reasoning by default', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['reasoning']).toBeUndefined();
      expect(body['include']).toBeUndefined();
    });

    it('with_thinking("off") omits reasoning', async () => {
      const provider = createProvider().withThinking('off');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['reasoning']).toBeUndefined();
      expect(body['include']).toBeUndefined();
    });

    it('with_thinking("low") sends reasoning with effort=low', async () => {
      const provider = createProvider().withThinking('low');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['reasoning']).toEqual({ effort: 'low', summary: 'auto' });
      expect(body['include']).toEqual(['reasoning.encrypted_content']);
    });

    it('with_thinking("high") sends reasoning with effort=high', async () => {
      const provider = createProvider().withThinking('high');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['reasoning']).toEqual({ effort: 'high', summary: 'auto' });
      expect(body['include']).toEqual(['reasoning.encrypted_content']);
    });
  });

  describe('provider properties', () => {
    it('has correct name and model', () => {
      const provider = createProvider();
      expect(provider.name).toBe('openai-responses');
      expect(provider.modelName).toBe('gpt-4.1');
    });

    it('thinkingEffort is null by default', () => {
      const provider = createProvider();
      expect(provider.thinkingEffort).toBeNull();
    });

    it('thinkingEffort reflects withThinking', () => {
      const provider = createProvider();
      expect(provider.withThinking('high').thinkingEffort).toBe('high');
      expect(provider.withThinking('low').thinkingEffort).toBe('low');
    });

    it('withThinking returns a new instance', () => {
      const provider = createProvider();
      const newProvider = provider.withThinking('high');
      expect(newProvider).toBeInstanceOf(OpenAIResponsesChatProvider);
      expect(newProvider).not.toBe(provider);
    });

    it('throws a clear error when the SDK client lacks Responses API support', async () => {
      const provider = createProvider();
      (provider as unknown as { _client: Record<string, unknown> })._client = {};

      await expect(
        provider.generate(
          '',
          [],
          [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
        ),
      ).rejects.toThrow(
        'OpenAI SDK version does not support Responses API. Upgrade to >=4.x with responses support.',
      );
    });
  });

  describe('response parsing', () => {
    it('yields text from non-stream response', async () => {
      const provider = createProvider();
      (provider as any)._stream = false;
      ((provider as any)._client.responses as unknown as Record<string, unknown>)['create'] = vi
        .fn()
        .mockResolvedValue(makeResponsesAPIResponse());

      const stream = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      const parts = [];
      for await (const part of stream) {
        parts.push(part);
      }

      expect(parts).toEqual([{ type: 'text', text: 'Hello' }]);
      expect(stream.id).toBe('resp_test123');
      expect(stream.usage).toEqual({
        inputOther: 10,
        output: 5,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
    });
  });

  describe('streaming', () => {
    it('generate sends stream: true and returns streaming parts', async () => {
      const provider = createProvider();

      // The provider has _stream = true by default; mock create to return an async iterable
      const events = [
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: ' world' },
        {
          type: 'response.completed',
          response: {
            id: 'resp_stream_1',
            usage: {
              input_tokens: 20,
              output_tokens: 10,
              input_tokens_details: { cached_tokens: 5 },
            },
          },
        },
      ];

      let capturedParams: Record<string, unknown> | undefined;
      ((provider as any)._client.responses as unknown as Record<string, unknown>)['create'] = vi
        .fn()
        .mockImplementation((params: unknown) => {
          capturedParams = params as Record<string, unknown>;
          return Promise.resolve(makeAsyncIterable(events));
        });

      const stream = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      const parts: StreamedMessagePart[] = [];
      for await (const part of stream) {
        parts.push(part);
      }

      // Verify stream: true was sent
      expect(capturedParams!['stream']).toBe(true);

      expect(parts).toEqual([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ]);

      expect(stream.usage).toEqual({
        inputOther: 15,
        output: 10,
        inputCacheRead: 5,
        inputCacheCreation: 0,
      });
    });

    it('streams tool call with arguments delta', async () => {
      const events = [
        {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            call_id: 'call_123',
            name: 'add',
            arguments: '',
          },
        },
        { type: 'response.function_call_arguments.delta', delta: '{"a":' },
        { type: 'response.function_call_arguments.delta', delta: ' 2, "b": 3}' },
        {
          type: 'response.completed',
          response: { id: 'resp_tc', usage: { input_tokens: 5, output_tokens: 3 } },
        },
      ];

      const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true);

      const parts: StreamedMessagePart[] = [];
      for await (const part of stream) {
        parts.push(part);
      }

      expect(parts).toEqual([
        {
          type: 'function',
          id: 'call_123',
          function: { name: 'add', arguments: '' },
        },
        { type: 'tool_call_part', argumentsPart: '{"a":' },
        { type: 'tool_call_part', argumentsPart: ' 2, "b": 3}' },
      ]);

      expect(stream.usage).toEqual({
        inputOther: 5,
        output: 3,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
    });

    it('streams reasoning with encrypted_content', async () => {
      const events = [
        { type: 'response.reasoning_summary_part.added' },
        { type: 'response.reasoning_summary_text.delta', delta: 'Thinking about' },
        { type: 'response.reasoning_summary_text.delta', delta: ' the answer...' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'reasoning',
            id: 'rs_1',
            encrypted_content: 'enc_xyz',
            summary: [{ type: 'summary_text', text: 'Thinking about the answer...' }],
          },
        },
        { type: 'response.output_text.delta', delta: '42' },
        {
          type: 'response.completed',
          response: { id: 'resp_r', usage: { input_tokens: 8, output_tokens: 4 } },
        },
      ];

      const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true);

      const parts: StreamedMessagePart[] = [];
      for await (const part of stream) {
        parts.push(part);
      }

      expect(parts).toEqual([
        { type: 'think', think: '' },
        { type: 'think', think: 'Thinking about' },
        { type: 'think', think: ' the answer...' },
        { type: 'think', think: '', encrypted: 'enc_xyz' },
        { type: 'text', text: '42' },
      ]);
    });

    it('stream.id is response.id, not output item id (tool call)', async () => {
      // Regression: previously `output_item.added` / `output_item.done`
      // overwrote `_id` with the item id (or undefined for tool-call items
      // that have no `item.id`), clobbering the real `response.id`.
      const events = [
        { type: 'response.created', response: { id: 'resp_001' } },
        {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            id: 'item_a',
            call_id: 'call_a',
            name: 'tool_a',
            arguments: '',
          },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'item_a', delta: '{}' },
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', id: 'item_a' },
        },
        {
          type: 'response.completed',
          response: { id: 'resp_001', usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ];

      const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true);
      for await (const _ of stream) {
        // drain
      }

      expect(stream.id).toBe('resp_001');
    });

    it('stream.id stays as response.id across multiple output items', async () => {
      const events = [
        { type: 'response.in_progress', response: { id: 'resp_multi' } },
        {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            id: 'item_1',
            call_id: 'call_1',
            name: 'tool_1',
            arguments: '',
          },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{}' },
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', id: 'item_1' },
        },
        {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            id: 'item_2',
            call_id: 'call_2',
            name: 'tool_2',
            arguments: '',
          },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'item_2', delta: '{}' },
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', id: 'item_2' },
        },
        {
          type: 'response.completed',
          response: { id: 'resp_multi', usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ];

      const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true);
      for await (const _ of stream) {
        // drain
      }

      expect(stream.id).toBe('resp_multi');
    });

    it('stream.id is set from response.created even if tool-call items lack id', async () => {
      // Some providers emit `output_item.added` without an `item.id` for
      // function_call items. Before the fix, this would set `_id` to
      // undefined, erasing the real response id captured earlier.
      const events = [
        { type: 'response.created', response: { id: 'resp_no_item_id' } },
        {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            call_id: 'call_x',
            name: 'tool_x',
            arguments: '',
          },
        },
        { type: 'response.function_call_arguments.delta', delta: '{}' },
        {
          type: 'response.completed',
          response: {
            id: 'resp_no_item_id',
            usage: { input_tokens: 2, output_tokens: 1 },
          },
        },
      ];

      const stream = new OpenAIResponsesStreamedMessage(makeAsyncIterable(events), true);
      for await (const _ of stream) {
        // drain
      }

      expect(stream.id).toBe('resp_no_item_id');
    });

    it('converts errors during streaming', async () => {
      const { APIError } = await import('openai');

      async function* failingStream(): AsyncIterable<Record<string, unknown>> {
        yield { type: 'response.output_text.delta', delta: 'partial' };
        throw new APIError(
          500,
          { message: 'Internal Server Error' },
          'server error',
          new Headers(),
        );
      }

      const stream = new OpenAIResponsesStreamedMessage(failingStream(), true);

      const parts: StreamedMessagePart[] = [];
      let caughtError: Error | undefined;
      try {
        for await (const part of stream) {
          parts.push(part);
        }
      } catch (error) {
        caughtError = error as Error;
      }

      // Should have yielded the partial text before the error
      expect(parts).toEqual([{ type: 'text', text: 'partial' }]);
      // Error should be converted to a kosong error
      expect(caughtError).toBeDefined();
      expect(caughtError!.name).toBe('APIStatusError');
    });
  });
});

// ── Stream test helpers ─────────────────────────────────────────────

function makeAsyncIterable(
  events: Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<Record<string, unknown>>> {
          if (index < events.length) {
            return Promise.resolve({ value: events[index++]!, done: false });
          }
          return Promise.resolve({
            value: undefined as unknown as Record<string, unknown>,
            done: true,
          });
        },
      };
    },
  };
}
