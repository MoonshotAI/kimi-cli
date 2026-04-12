import { describe, expect, it } from 'vitest';

import type { Message, StreamedMessagePart, ToolCall } from '../../src/message.js';
import type { StreamedMessage } from '../../src/provider.js';
import { OpenAILegacyChatProvider } from '../../src/providers/openai-legacy.js';
import type { Tool } from '../../src/tool.js';
import { createFakeProviderHarness, type FakeProviderHarness } from './fake-provider-harness.js';

function createProvider(baseUrl: string): OpenAILegacyChatProvider {
  return new OpenAILegacyChatProvider({
    model: 'gpt-4.1',
    apiKey: 'test-key',
    baseUrl,
    stream: true,
  });
}

async function withHarness<T>(fn: (harness: FakeProviderHarness) => Promise<T>): Promise<T> {
  const harness = await createFakeProviderHarness();
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

async function collectStream(
  provider: OpenAILegacyChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
): Promise<{ id: string | null; usage: unknown; parts: StreamedMessagePart[] }> {
  const stream: StreamedMessage = await provider.generate(systemPrompt, tools, history);
  const parts: StreamedMessagePart[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return { id: stream.id, usage: stream.usage, parts };
}

const LOOKUP_TOOL: Tool = {
  name: 'lookup_weather',
  description: 'Look up the weather for a city.',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string' },
    },
    required: ['city'],
    additionalProperties: false,
  },
};

function makeChunk(
  delta: Record<string, unknown>,
  opts?: { id?: string; finishReason?: string; usage?: Record<string, unknown> },
): Record<string, unknown> {
  const chunk: Record<string, unknown> = {
    id: opts?.id ?? 'chatcmpl-openai-legacy-1',
    object: 'chat.completion.chunk',
    created: 1234567890,
    model: 'gpt-4.1',
    choices: [
      {
        index: 0,
        delta,
        finish_reason: opts?.finishReason ?? null,
      },
    ],
  };
  if (opts?.usage !== undefined) {
    chunk['usage'] = opts.usage;
  }
  return chunk;
}

describe('e2e: openai-legacy adapter', () => {
  it('sends chat-completion requests, streams tool-call deltas, and preserves usage', async () => {
    await withHarness(async (harness) => {
      let capturedRequest: Record<string, unknown> | null = null;

      harness.route('POST', '/v1/chat/completions', async (request, reply) => {
        capturedRequest = request.bodyJson as Record<string, unknown>;
        await reply.sseJson(200, [
          makeChunk({ content: 'Checking weather. ' }),
          makeChunk({
            tool_calls: [
              {
                index: 0,
                id: 'call_weather',
                function: { name: 'lookup_weather', arguments: '{"city":"' },
              },
            ],
          }),
          makeChunk({
            tool_calls: [{ index: 0, function: { arguments: 'Shanghai"}' } }],
          }),
          makeChunk(
            {},
            {
              finishReason: 'tool_calls',
              usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
            },
          ),
        ]);
      });

      const provider = createProvider(`${harness.baseUrl}/v1`);
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Check the weather.' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will look it up.' }],
          toolCalls: [
            {
              type: 'function',
              id: 'call_weather',
              function: { name: 'lookup_weather', arguments: '{"city":"Shanghai"}' },
            } satisfies ToolCall,
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'sunny and 26C' }],
          toolCallId: 'call_weather',
          toolCalls: [],
        },
      ];

      const result = await collectStream(provider, 'You are helpful.', [LOOKUP_TOOL], history);

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest).toMatchObject({
        model: 'gpt-4.1',
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Check the weather.' },
          {
            role: 'assistant',
            content: 'I will look it up.',
            tool_calls: [
              {
                type: 'function',
                id: 'call_weather',
                function: { name: 'lookup_weather', arguments: '{"city":"Shanghai"}' },
              },
            ],
          },
          { role: 'tool', content: 'sunny and 26C', tool_call_id: 'call_weather' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_weather',
              description: 'Look up the weather for a city.',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
                additionalProperties: false,
              },
            },
          },
        ],
      });

      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0]!.pathname).toBe('/v1/chat/completions');
      expect(harness.requests[0]!.headers['authorization']).toBe('Bearer test-key');
      expect(result.id).toBe('chatcmpl-openai-legacy-1');
      expect(result.usage).toEqual({
        inputOther: 12,
        output: 6,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
      expect(result.parts).toHaveLength(3);
      expect(result.parts[0]).toMatchObject({ type: 'text', text: 'Checking weather. ' });
      expect(result.parts[1]).toMatchObject({
        type: 'function',
        id: 'call_weather',
        function: { name: 'lookup_weather', arguments: '{"city":"' },
      });
      expect(result.parts[1]).toHaveProperty('_streamIndex', 0);
      expect(result.parts[2]).toMatchObject({
        type: 'tool_call_part',
        argumentsPart: 'Shanghai"}',
      });
      expect(result.parts[2]).toHaveProperty('index', 0);
    });
  });

  it('propagates upstream HTTP failures as APIStatusError', async () => {
    await withHarness(async (harness) => {
      let capturedRequest: Record<string, unknown> | null = null;

      harness.route('POST', '/v1/chat/completions', async (request, reply) => {
        capturedRequest = request.bodyJson as Record<string, unknown>;
        await reply.json(503, {
          error: {
            message: 'upstream unavailable',
            type: 'server_error',
          },
        });
      });

      const provider = createProvider(`${harness.baseUrl}/v1`);
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Check the weather.' }], toolCalls: [] },
      ];

      await expect(collectStream(provider, '', [LOOKUP_TOOL], history)).rejects.toMatchObject({
        name: 'APIStatusError',
        statusCode: 503,
      });

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest).toMatchObject({
        model: 'gpt-4.1',
        stream: true,
        stream_options: { include_usage: true },
      });
      expect(harness.requests.length).toBeGreaterThanOrEqual(1);
    });
  });
});
