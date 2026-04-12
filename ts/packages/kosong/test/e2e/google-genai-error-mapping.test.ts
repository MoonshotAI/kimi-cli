import { GoogleGenAI } from '@google/genai';
import { describe, expect, it } from 'vitest';

import { APIStatusError } from '../../src/errors.js';
import type { Message } from '../../src/message.js';
import { GoogleGenAIChatProvider } from '../../src/providers/google-genai.js';
import type { Tool } from '../../src/tool.js';
import { createFakeProviderHarness } from './fake-provider-harness.js';

const SUM_TOOL: Tool = {
  name: 'sum',
  description: 'Sum two integers.',
  parameters: {
    type: 'object',
    properties: {
      left: { type: 'integer' },
      right: { type: 'integer' },
    },
    required: ['left', 'right'],
  },
};

describe('e2e: Google GenAI error mapping', () => {
  it('sends the non-stream request body and maps HTTP status errors', async () => {
    const harness = await createFakeProviderHarness();
    try {
      harness.route(
        'POST',
        '/v1beta/models/gemini-2.5-flash:generateContent',
        async (request, reply) => {
          const body = request.bodyJson as Record<string, unknown>;

          expect(request.pathname).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
          expect(request.search).toBe('');
          expect(request.headers['x-goog-api-key']).toBe('test-key');
          expect(body['generationConfig']).toEqual({});
          expect(body['tools']).toHaveLength(1);
          expect(body['contents']).toEqual([
            {
              role: 'user',
              parts: [{ text: 'Add 7 and 11.' }],
            },
          ]);

          await reply.json(503, {
            error: {
              code: 503,
              message: 'upstream temporarily unavailable',
              status: 'UNAVAILABLE',
            },
          });
        },
      );

      const provider = new GoogleGenAIChatProvider({
        model: 'gemini-2.5-flash',
        apiKey: 'test-key',
        stream: false,
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
          content: [{ type: 'text', text: 'Add 7 and 11.' }],
          toolCalls: [],
        },
      ];

      const pending = provider.generate('You are a careful calculator.', [SUM_TOOL], history);

      await expect(pending).rejects.toBeInstanceOf(APIStatusError);
      await expect(pending).rejects.toMatchObject({
        name: 'APIStatusError',
        statusCode: 503,
        message: expect.stringContaining('upstream temporarily unavailable'),
      });
    } finally {
      await harness.close();
    }
  });
});
