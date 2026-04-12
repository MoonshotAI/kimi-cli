import { describe, expect, it } from 'vitest';

import type { Message, StreamedMessagePart, ToolCall } from '../../src/message.js';
import type { StreamedMessage } from '../../src/provider.js';
import { OpenAIResponsesChatProvider } from '../../src/providers/openai-responses.js';
import type { Tool } from '../../src/tool.js';
import { createFakeProviderHarness, type FakeProviderHarness } from './fake-provider-harness.js';

function createProvider(baseUrl: string): OpenAIResponsesChatProvider {
  return new OpenAIResponsesChatProvider({
    model: 'gpt-4.1',
    apiKey: 'test-key',
    baseUrl,
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
  provider: OpenAIResponsesChatProvider,
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

describe('e2e: openai-responses adapter', () => {
  it('sends Responses API requests, streams function-call deltas, and preserves usage', async () => {
    await withHarness(async (harness) => {
      let capturedRequest: Record<string, unknown> | null = null;
      const responseSnapshot = {
        id: 'resp_openai_1',
        object: 'response',
        created_at: 1234567890,
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          {
            type: 'message',
            id: 'item_msg',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'All set. ', annotations: [] }],
          },
          {
            type: 'function_call',
            id: 'item_weather',
            call_id: 'call_weather',
            name: 'lookup_weather',
            arguments: '{"city":"Shanghai"}',
            status: 'completed',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      };

      harness.route('POST', '/v1/responses', async (request, reply) => {
        capturedRequest = request.bodyJson as Record<string, unknown>;
        await reply.json(200, responseSnapshot);
      });

      const provider = createProvider(`${harness.baseUrl}/v1`);
      (provider as any)._stream = false;
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
        stream: false,
        store: false,
        input: [
          { role: 'developer', content: 'You are helpful.' },
          {
            role: 'user',
            type: 'message',
            content: [{ type: 'input_text', text: 'Check the weather.' }],
          },
          {
            role: 'assistant',
            type: 'message',
            content: [{ type: 'output_text', text: 'I will look it up.', annotations: [] }],
          },
          {
            type: 'function_call',
            call_id: 'call_weather',
            name: 'lookup_weather',
            arguments: '{"city":"Shanghai"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_weather',
            output: [{ type: 'input_text', text: 'sunny and 26C' }],
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'lookup_weather',
            description: 'Look up the weather for a city.',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
              additionalProperties: false,
            },
            strict: false,
          },
        ],
      });

      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0]!.pathname).toBe('/v1/responses');
      expect(harness.requests[0]!.headers['authorization']).toBe('Bearer test-key');
      expect(result.id).toBe('resp_openai_1');
      expect(result.usage).toEqual({
        inputOther: 10,
        output: 4,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
      expect(result.parts).toHaveLength(2);
      expect(result.parts[0]).toMatchObject({ type: 'text', text: 'All set. ' });
      expect(result.parts[1]).toMatchObject({
        type: 'function',
        id: 'call_weather',
        function: { name: 'lookup_weather', arguments: '{"city":"Shanghai"}' },
      });
    });
  });

  it('propagates upstream HTTP failures as APIStatusError', async () => {
    await withHarness(async (harness) => {
      let capturedRequest: Record<string, unknown> | null = null;

      harness.route('POST', '/v1/responses', async (request, reply) => {
        capturedRequest = request.bodyJson as Record<string, unknown>;
        await reply.json(503, {
          error: {
            message: 'upstream unavailable',
            type: 'server_error',
          },
        });
      });

      const provider = createProvider(`${harness.baseUrl}/v1`);
      (provider as any)._stream = false;
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
        stream: false,
        store: false,
      });
      expect(harness.requests.length).toBeGreaterThanOrEqual(1);
    });
  });
});
