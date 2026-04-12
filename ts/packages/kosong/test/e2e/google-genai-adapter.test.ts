import { GoogleGenAI } from '@google/genai';
import { describe, expect, it } from 'vitest';

import type { Message, StreamedMessagePart, ToolCall } from '../../src/message.js';
import { GoogleGenAIChatProvider } from '../../src/providers/google-genai.js';
import type { Tool } from '../../src/tool.js';
import type { TokenUsage } from '../../src/usage.js';
import { createFakeProviderHarness } from './fake-provider-harness.js';

async function collectParts(
  streamedMessage: AsyncIterable<StreamedMessagePart>,
): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of streamedMessage) {
    parts.push(part);
  }
  return parts;
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

describe('e2e: Google GenAI adapter bridge', () => {
  it('sends the adapter request body, sorts tool responses, and parses streamed chunks', async () => {
    const harness = await createFakeProviderHarness();
    try {
      harness.route(
        'POST',
        '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
        async (request, reply) => {
          const body = request.bodyJson as Record<string, unknown>;
          expect(request.pathname).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent');
          expect(request.search).toBe('?alt=sse');
          expect(request.headers['x-goog-api-key']).toBe('test-key');
          expect(body['generationConfig']).toEqual({});
          expect(body['tools']).toHaveLength(2);
          expect(body['contents']).toHaveLength(3);
          expect(body['contents']).toEqual([
            { role: 'user', parts: [{ text: 'Add and multiply these numbers.' }] },
            {
              role: 'model',
              parts: [{ text: 'I will calculate both.' }, {}, {}],
            },
            {
              role: 'user',
              parts: [{}, {}],
            },
          ]);

          await reply.sseLines(200, [
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: 'Done.' }],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 30,
                candidatesTokenCount: 4,
                cachedContentTokenCount: 1,
              },
              responseId: 'resp-1',
            })}`,
            '',
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          name: 'notify',
                          id: 'call-1',
                          args: { ok: true },
                        },
                        thoughtSignature: 'sig-1',
                      },
                    ],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 30,
                candidatesTokenCount: 9,
                cachedContentTokenCount: 1,
              },
              responseId: 'resp-1',
            })}`,
            '',
            '',
          ]);
        },
      );

      const provider = new GoogleGenAIChatProvider({
        model: 'gemini-2.5-flash',
        apiKey: 'test-key',
        stream: true,
      });
      (provider as any)._client = new GoogleGenAI({
        apiKey: 'test-key',
        httpOptions: {
          baseUrl: harness.baseUrl,
          apiVersion: 'v1beta',
        },
      });

      const history: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Add and multiply these numbers.' }],
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will calculate both.' }],
          toolCalls: [
            {
              type: 'function',
              id: 'call_add',
              function: { name: 'add', arguments: '{"a":2,"b":3}' },
            },
            {
              type: 'function',
              id: 'call_mul',
              function: { name: 'multiply', arguments: '{"a":4,"b":5}' },
            },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '20' }],
          toolCallId: 'call_mul',
          toolCalls: [],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '5' }],
          toolCallId: 'call_add',
          toolCalls: [],
        },
      ];

      const stream = await provider.generate(
        'You are a calculator.',
        [ADD_TOOL, MUL_TOOL],
        history,
      );
      const parts = await collectParts(stream);

      expect(parts).toEqual([
        { type: 'text', text: 'Done.' },
        {
          type: 'function',
          id: 'notify_call-1',
          function: { name: 'notify', arguments: '{"ok":true}' },
          extras: { thought_signature_b64: 'sig-1' },
        } satisfies ToolCall,
      ]);

      expect(stream.id).toBe('resp-1');
      expect(stream.usage).toEqual({
        inputOther: 30,
        output: 9,
        inputCacheRead: 1,
        inputCacheCreation: 0,
      } satisfies TokenUsage);

      expect(harness.requests).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
