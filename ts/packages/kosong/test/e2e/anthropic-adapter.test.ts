import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import type { Message, StreamedMessagePart, ToolCall } from '../../src/message.js';
import { AnthropicChatProvider } from '../../src/providers/anthropic.js';
import type { Tool } from '../../src/tool.js';
import type { TokenUsage } from '../../src/usage.js';
import { createFakeProviderHarness } from './fake-provider-harness.js';

function anthropicSseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function collectParts(
  streamedMessage: AsyncIterable<StreamedMessagePart>,
): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of streamedMessage) {
    parts.push(part);
  }
  return parts;
}

function makeAnthropicProvider(): AnthropicChatProvider {
  return new AnthropicChatProvider({
    model: 'k25',
    apiKey: 'test-key',
    defaultMaxTokens: 1024,
    stream: true,
  });
}

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

describe('e2e: Anthropic adapter bridge', () => {
  it('sends the adapter request body and parses streamed text, tool use, and usage', async () => {
    const harness = await createFakeProviderHarness();
    try {
      harness.route('POST', '/v1/messages', async (request, reply) => {
        const body = request.bodyJson as Record<string, unknown>;
        expect(request.pathname).toBe('/v1/messages');
        expect(request.headers['anthropic-beta']).toContain('interleaved-thinking-2025-05-14');
        expect(request.headers['x-api-key']).toBe('test-key');
        expect(body['model']).toBe('k25');
        expect(body['system']).toEqual([
          { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
        ]);
        expect(body['tools']).toEqual([
          {
            name: 'add',
            description: 'Add two integers.',
            input_schema: ADD_TOOL.parameters,
          },
          {
            name: 'multiply',
            description: 'Multiply two integers.',
            input_schema: MUL_TOOL.parameters,
            cache_control: { type: 'ephemeral' },
          },
        ]);
        expect(body['messages']).toEqual([
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect the image.' },
              {
                type: 'image',
                source: { type: 'url', url: 'https://example.com/image.png' },
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ]);

        const stream = [
          anthropicSseFrame('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'k25',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: 19,
                output_tokens: 0,
                cache_read_input_tokens: 2,
                cache_creation_input_tokens: 1,
              },
            },
          }),
          anthropicSseFrame('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: 'Hello from Anthropic' },
          }),
          anthropicSseFrame('content_block_stop', {
            type: 'content_block_stop',
            index: 0,
          }),
          anthropicSseFrame('content_block_start', {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'add',
              input: {},
            },
          }),
          anthropicSseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"a":2' },
          }),
          anthropicSseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: ',"b":3}' },
          }),
          anthropicSseFrame('content_block_stop', {
            type: 'content_block_stop',
            index: 1,
          }),
          anthropicSseFrame('message_delta', {
            type: 'message_delta',
            delta: { type: 'message_delta', stop_reason: 'tool_use', stop_sequence: null },
            usage: {
              input_tokens: 19,
              output_tokens: 7,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 1,
            },
          }),
          anthropicSseFrame('message_stop', { type: 'message_stop' }),
        ].join('');

        await reply.raw(200, stream, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
      });

      const provider = makeAnthropicProvider();
      (provider as any)._client = new Anthropic({
        apiKey: 'test-key',
        baseURL: harness.baseUrl,
      });

      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect the image.' },
            { type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } },
          ],
          toolCalls: [],
        },
      ];

      const stream = await provider.generate('You are helpful.', [ADD_TOOL, MUL_TOOL], history);
      const parts = await collectParts(stream);

      expect(parts).toEqual([
        { type: 'text', text: 'Hello from Anthropic' },
        {
          type: 'function',
          id: 'toolu_1',
          function: { name: 'add', arguments: '' },
          _streamIndex: 1,
        } satisfies ToolCall,
        { type: 'tool_call_part', argumentsPart: '{"a":2', index: 1 },
        { type: 'tool_call_part', argumentsPart: ',"b":3}', index: 1 },
      ]);

      expect(stream.id).toBe('msg_1');
      expect(stream.usage).toEqual({
        inputOther: 19,
        output: 7,
        inputCacheRead: 2,
        inputCacheCreation: 1,
      } satisfies TokenUsage);

      expect(harness.requests).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
