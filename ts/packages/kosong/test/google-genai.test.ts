import { describe, it, expect, vi } from 'vitest';

import type { Message, StreamedMessagePart, ToolCall } from '../src/message.js';
import {
  GoogleGenAIChatProvider,
  GoogleGenAIStreamedMessage,
  messagesToGoogleGenAIContents,
} from '../src/providers/google-genai.js';
import type { Tool } from '../src/tool.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeGenerateContentResponse() {
  return {
    candidates: [
      {
        content: { parts: [{ text: 'Hello' }], role: 'model' },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
    modelVersion: 'gemini-2.5-flash',
  };
}

function createProvider(
  options?: Partial<{ model: string; vertexai: boolean; stream: boolean }>,
): GoogleGenAIChatProvider {
  return new GoogleGenAIChatProvider({
    model: options?.model ?? 'gemini-2.5-flash',
    apiKey: 'test-key',
    vertexai: options?.vertexai,
    stream: options?.stream,
  });
}

/** Capture the request body by mocking the client's generateContentStream. */
async function captureRequestBody(
  provider: GoogleGenAIChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
): Promise<Record<string, unknown>> {
  let capturedBody: Record<string, unknown> | undefined;

  const mockModels = (provider as any)._client.models as Record<string, unknown>;

  // Mock both endpoints - the provider defaults to stream mode
  async function* mockStream() {
    yield makeGenerateContentResponse();
  }

  mockModels['generateContentStream'] = vi.fn().mockImplementation((params: unknown) => {
    capturedBody = params as Record<string, unknown>;
    return Promise.resolve(mockStream());
  });

  mockModels['generateContent'] = vi.fn().mockImplementation((params: unknown) => {
    capturedBody = params as Record<string, unknown>;
    return Promise.resolve(makeGenerateContentResponse());
  });

  const stream = await provider.generate(systemPrompt, tools, history);
  for await (const _ of stream) {
    // drain
  }

  expect(capturedBody).toBeDefined();
  return capturedBody!;
}

/** Collect all parts from a StreamedMessage. */
async function collectParts(msg: {
  [Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart>;
}): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of msg) {
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

// ── Tests ────────────────────────────────────────────────────────────

describe('GoogleGenAIChatProvider', () => {
  describe('message conversion', () => {
    it('simple user message with system prompt', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, 'You are helpful.', [], history);

      expect(body['contents']).toEqual([{ parts: [{ text: 'Hello!' }], role: 'user' }]);
      const config = body['config'] as Record<string, unknown>;
      expect(config['system_instruction']).toBe('You are helpful.');
    });

    it('system messages in history are wrapped and emitted as user content', () => {
      // Regression: Google GenAI's Content.role only accepts "user" or
      // "model", so a `system` message sitting in the replay history (from
      // session restore or cross-provider migration) would be rejected by
      // the API. messagesToGoogleGenAIContents must transform it into a
      // user turn wrapped in <system>...</system> tags so the information
      // survives without provoking a 400.
      const messages: Message[] = [
        {
          role: 'system',
          content: [{ type: 'text', text: 'You are helpful.' }],
          toolCalls: [],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hi' }],
          toolCalls: [],
        },
      ];

      const contents = messagesToGoogleGenAIContents(messages);

      expect(contents).toHaveLength(2);
      const first = contents[0] as unknown as {
        role: string;
        parts: Array<{ text?: string }>;
      };
      expect(first.role).toBe('user');
      expect(first.parts).toHaveLength(1);
      expect(first.parts[0]!.text).toBe('<system>You are helpful.</system>');
      // Original user turn is untouched.
      const second = contents[1] as unknown as {
        role: string;
        parts: Array<{ text?: string }>;
      };
      expect(second.role).toBe('user');
      expect(second.parts[0]!.text).toBe('Hi');
      // No emitted content carries the unsupported "system" role.
      for (const c of contents) {
        expect((c as unknown as { role: string }).role).not.toBe('system');
      }
    });

    it('empty system messages in history are dropped', () => {
      // A system message with no textual content contributes nothing; it
      // would be pointless (and arguably confusing to models) to emit an
      // empty <system></system> user turn, so we skip it entirely.
      const messages: Message[] = [
        {
          role: 'system',
          content: [],
          toolCalls: [],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hi' }],
          toolCalls: [],
        },
      ];

      const contents = messagesToGoogleGenAIContents(messages);
      expect(contents).toHaveLength(1);
      expect((contents[0] as unknown as { role: string }).role).toBe('user');
    });

    it('multi-turn conversation with assistant mapped to model', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: '2+2 equals 4.' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      expect(body['contents']).toEqual([
        { parts: [{ text: 'What is 2+2?' }], role: 'user' },
        { parts: [{ text: '2+2 equals 4.' }], role: 'model' },
        { parts: [{ text: 'And 3+3?' }], role: 'user' },
      ]);
    });

    it('tool definitions use parameters_json_schema', async () => {
      const provider = createProvider();
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      const config = body['config'] as Record<string, unknown>;
      expect(config['tools']).toEqual([
        {
          function_declarations: [
            {
              name: 'add',
              description: 'Add two integers.',
              parameters_json_schema: {
                type: 'object',
                properties: {
                  a: { type: 'integer', description: 'First number' },
                  b: { type: 'integer', description: 'Second number' },
                },
                required: ['a', 'b'],
              },
            },
          ],
        },
        {
          function_declarations: [
            {
              name: 'multiply',
              description: 'Multiply two integers.',
              parameters_json_schema: {
                type: 'object',
                properties: {
                  a: { type: 'integer', description: 'First number' },
                  b: { type: 'integer', description: 'Second number' },
                },
                required: ['a', 'b'],
              },
            },
          ],
        },
      ]);
    });

    it('tool call and tool result packed into user Content', async () => {
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

      expect(body['contents']).toEqual([
        { parts: [{ text: 'Add 2 and 3' }], role: 'user' },
        {
          parts: [
            { text: "I'll add those numbers for you." },
            { function_call: { name: 'add', args: { a: 2, b: 3 } } },
          ],
          role: 'model',
        },
        {
          parts: [
            {
              function_response: {
                name: 'add',
                response: { output: '5' },
                parts: [],
              },
            },
          ],
          role: 'user',
        },
      ]);
    });

    it('tool message with image_url result yields function_response + inline data part', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'tc_001',
              function: { name: 'fetch_image', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'Found image:' },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
          toolCalls: [],
          toolCallId: 'tc_001',
        },
      ];

      const contents = messagesToGoogleGenAIContents(messages);

      // Should have assistant Content + one user Content with 2 parts
      expect(contents).toHaveLength(2);
      const userContent = contents[1] as unknown as {
        role: string;
        parts: Array<Record<string, unknown>>;
      };
      expect(userContent.role).toBe('user');
      expect(userContent.parts.length).toBeGreaterThanOrEqual(2);

      const fnResp = userContent.parts.find((p) => 'function_response' in p) as
        | { function_response: { name: string; response: { output: string } } }
        | undefined;
      expect(fnResp).toBeDefined();
      expect(fnResp!.function_response.response.output).toBe('Found image:');
      expect(fnResp!.function_response.name).toBe('fetch_image');

      const inlineData = userContent.parts.find((p) => 'inlineData' in p) as
        | { inlineData: { mimeType: string; data: string } }
        | undefined;
      expect(inlineData).toBeDefined();
      expect(inlineData!.inlineData.mimeType).toBe('image/png');
      expect(inlineData!.inlineData.data).toBe('iVBORw0KGgo=');
    });

    it('tool message with audio_url and video_url results yields independent parts', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'tc_002',
              function: { name: 'fetch_media', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'Got audio and video:' },
            { type: 'audio_url', audioUrl: { url: 'https://example.com/sound.mp3' } },
            { type: 'video_url', videoUrl: { url: 'https://example.com/clip.mp4' } },
          ],
          toolCalls: [],
          toolCallId: 'tc_002',
        },
      ];

      const contents = messagesToGoogleGenAIContents(messages);

      expect(contents).toHaveLength(2);
      const userContent = contents[1] as unknown as {
        role: string;
        parts: Array<Record<string, unknown>>;
      };
      expect(userContent.role).toBe('user');
      // function_response + audio + video
      expect(userContent.parts).toHaveLength(3);

      const fnResp = userContent.parts.find((p) => 'function_response' in p) as
        | { function_response: { response: { output: string } } }
        | undefined;
      expect(fnResp).toBeDefined();
      expect(fnResp!.function_response.response.output).toBe('Got audio and video:');

      const fileDataParts = userContent.parts.filter((p) => 'fileData' in p) as Array<{
        fileData: { fileUri: string; mimeType: string };
      }>;
      expect(fileDataParts).toHaveLength(2);
      const mimeTypes = fileDataParts.map((p) => p.fileData.mimeType).toSorted();
      expect(mimeTypes).toEqual(['audio/mpeg', 'video/mp4']);
    });

    it('forwards video_url parts in regular messages as fileData', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Please inspect this clip.' },
            { type: 'video_url', videoUrl: { url: 'https://example.com/demo.mp4' } },
          ],
          toolCalls: [],
        },
      ];

      const contents = messagesToGoogleGenAIContents(messages);

      expect(contents).toHaveLength(1);
      expect(contents[0]).toEqual({
        role: 'user',
        parts: [
          { text: 'Please inspect this clip.' },
          { fileData: { fileUri: 'https://example.com/demo.mp4', mimeType: 'video/mp4' } },
        ],
      });
    });

    it('parallel tool calls packed into single user Content', async () => {
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
          content: [{ type: 'text', text: '5' }],
          toolCallId: 'call_add',
          toolCalls: [],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '20' }],
          toolCallId: 'call_mul',
          toolCalls: [],
        },
      ];
      const body = await captureRequestBody(provider, '', [ADD_TOOL, MUL_TOOL], history);

      const contents = body['contents'] as unknown[];
      // The tool results should be packed in a single user Content
      expect(contents[2]).toEqual({
        parts: [
          {
            function_response: {
              name: 'add',
              response: { output: '5' },
              parts: [],
            },
          },
          {
            function_response: {
              name: 'multiply',
              response: { output: '20' },
              parts: [],
            },
          },
        ],
        role: 'user',
      });
    });
  });

  describe('vertexai message conversion', () => {
    it('vertexai provider converts messages the same way', async () => {
      const provider = createProvider({ vertexai: true });
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello!' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, 'You are helpful.', [], history);

      expect(body['contents']).toEqual([{ parts: [{ text: 'Hello!' }], role: 'user' }]);
      const config = body['config'] as Record<string, unknown>;
      expect(config['system_instruction']).toBe('You are helpful.');
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

      const config = body['config'] as Record<string, unknown>;
      expect(config['temperature']).toBe(0.7);
      expect(config['max_output_tokens']).toBe(2048);
    });
  });

  describe('tool name inference from tool_call_id (orphan tool messages)', () => {
    // When a tool message arrives without a preceding assistant message
    // carrying the tool_call (e.g. after history compaction), the provider
    // falls back to parsing the name out of the tool_call_id. Google IDs
    // produced by this provider have the shape "{tool_name}_{id_suffix}"
    // where the suffix is a single non-underscored token, so stripping the
    // first underscore truncates multi-word tool names such as
    // `fetch_image_<id>` down to `fetch`.
    function firstFunctionResponseName(history: Message[]): string | undefined {
      const contents = messagesToGoogleGenAIContents(history);
      for (const content of contents) {
        for (const part of content.parts) {
          if (part.function_response) return part.function_response.name;
        }
      }
      return undefined;
    }

    it('preserves underscores in multi-word tool names like fetch_image', () => {
      const history: Message[] = [
        {
          role: 'tool',
          content: [{ type: 'text', text: 'ok' }],
          toolCallId: 'fetch_image_abc123',
          toolCalls: [],
        },
      ];
      expect(firstFunctionResponseName(history)).toBe('fetch_image');
    });

    it('preserves underscores in read_file_<id>', () => {
      const history: Message[] = [
        {
          role: 'tool',
          content: [{ type: 'text', text: 'ok' }],
          toolCallId: 'read_file_xyz',
          toolCalls: [],
        },
      ];
      expect(firstFunctionResponseName(history)).toBe('read_file');
    });

    it('handles single-word tool names with a trailing suffix', () => {
      const history: Message[] = [
        {
          role: 'tool',
          content: [{ type: 'text', text: 'ok' }],
          toolCallId: 'simple_abc',
          toolCalls: [],
        },
      ];
      expect(firstFunctionResponseName(history)).toBe('simple');
    });

    it('returns the whole id when there is no underscore to split on', () => {
      const history: Message[] = [
        {
          role: 'tool',
          content: [{ type: 'text', text: 'ok' }],
          toolCallId: 'bareid',
          toolCalls: [],
        },
      ];
      expect(firstFunctionResponseName(history)).toBe('bareid');
    });
  });

  describe('no id in function_call or function_response', () => {
    it('does not include id in function_call or function_response parts', () => {
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Sure.' }],
          toolCalls: [
            {
              type: 'function',
              id: 'call_xyz',
              function: { name: 'add', arguments: '{"a": 2, "b": 3}' },
            },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '5' }],
          toolCallId: 'call_xyz',
          toolCalls: [],
        },
      ];

      const contents = messagesToGoogleGenAIContents(history);

      for (const content of contents) {
        for (const part of content.parts) {
          if (part.function_call) {
            expect(part.function_call).not.toHaveProperty('id');
          }
          if (part.function_response) {
            expect(part.function_response).not.toHaveProperty('id');
          }
        }
      }
    });
  });

  describe('with thinking', () => {
    it('non-gemini-3 model uses thinking_budget', async () => {
      const provider = createProvider({ model: 'gemini-2.5-flash' }).withThinking('high');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      const config = body['config'] as Record<string, unknown>;
      expect(config['thinking_config']).toEqual({
        include_thoughts: true,
        thinking_budget: 32_000,
      });
    });

    it('gemini-3 model uses thinking_level', async () => {
      const provider = createProvider({ model: 'gemini-3-pro-preview' }).withThinking('high');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      const config = body['config'] as Record<string, unknown>;
      expect(config['thinking_config']).toEqual({
        include_thoughts: true,
        thinking_level: 'HIGH',
      });
    });

    it('thinking effort off for non-gemini-3 disables thinking', async () => {
      const provider = createProvider({ model: 'gemini-2.5-flash' }).withThinking('off');
      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
      ];
      const body = await captureRequestBody(provider, '', [], history);

      const config = body['config'] as Record<string, unknown>;
      expect(config['thinking_config']).toEqual({
        include_thoughts: false,
        thinking_budget: 0,
      });
    });

    describe('Gemini 3 thinking effort mapping', () => {
      async function captureThinkingConfig(
        effort: 'off' | 'low' | 'medium' | 'high',
      ): Promise<Record<string, unknown> | undefined> {
        const provider = createProvider({ model: 'gemini-3-pro-preview' }).withThinking(effort);
        const history: Message[] = [
          { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
        ];
        const body = await captureRequestBody(provider, '', [], history);
        const config = body['config'] as Record<string, unknown>;
        return config['thinking_config'] as Record<string, unknown> | undefined;
      }

      it('off minimizes thinking and hides thoughts (not just default config)', async () => {
        const thinkingConfig = await captureThinkingConfig('off');
        // Gemini 3 cannot be fully disabled, but we should request the lowest
        // available level (MINIMAL) and suppress thought output.
        expect(thinkingConfig).toEqual({
          include_thoughts: false,
          thinking_level: 'MINIMAL',
        });
      });

      it('low maps to LOW', async () => {
        const thinkingConfig = await captureThinkingConfig('low');
        expect(thinkingConfig).toEqual({
          include_thoughts: true,
          thinking_level: 'LOW',
        });
      });

      it('medium maps to MEDIUM (not HIGH)', async () => {
        const thinkingConfig = await captureThinkingConfig('medium');
        expect(thinkingConfig).toEqual({
          include_thoughts: true,
          thinking_level: 'MEDIUM',
        });
      });

      it('high maps to HIGH', async () => {
        const thinkingConfig = await captureThinkingConfig('high');
        expect(thinkingConfig).toEqual({
          include_thoughts: true,
          thinking_level: 'HIGH',
        });
      });
    });
  });

  describe('provider properties', () => {
    it('has correct name and model', () => {
      const provider = createProvider();
      expect(provider.name).toBe('google_genai');
      expect(provider.modelName).toBe('gemini-2.5-flash');
    });

    it('thinkingEffort is null by default', () => {
      const provider = createProvider();
      expect(provider.thinkingEffort).toBeNull();
    });

    it('thinkingEffort reflects budget for non-gemini-3', () => {
      const provider = createProvider().withThinking('high');
      expect(provider.thinkingEffort).toBe('high');
    });

    it('withThinking returns a new instance', () => {
      const provider = createProvider();
      const newProvider = provider.withThinking('high');
      expect(newProvider).toBeInstanceOf(GoogleGenAIChatProvider);
      expect(newProvider).not.toBe(provider);
    });
  });

  describe('response parsing (non-stream)', () => {
    it('yields text from non-stream response', async () => {
      const provider = createProvider({ stream: false });
      ((provider as any)._client.models as Record<string, unknown>)['generateContent'] = vi
        .fn()
        .mockResolvedValue(makeGenerateContentResponse());

      const stream = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      const parts = await collectParts(stream);

      expect(parts).toEqual([{ type: 'text', text: 'Hello' }]);
      expect(stream.usage).toEqual({
        inputOther: 10,
        output: 5,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
    });
  });

  describe('streaming', () => {
    it('defaults to stream mode', () => {
      const provider = createProvider();
      expect((provider as any)._stream).toBe(true);
    });

    it('can be set to non-stream mode', () => {
      const provider = createProvider({ stream: false });
      expect((provider as any)._stream).toBe(false);
    });

    it('calls generateContentStream when stream is true', async () => {
      const provider = createProvider({ stream: true });
      const mockModels = (provider as any)._client.models as Record<string, unknown>;

      async function* mockStream() {
        yield makeGenerateContentResponse();
      }

      const streamFn = vi.fn().mockImplementation(() => Promise.resolve(mockStream()));
      const nonStreamFn = vi.fn();

      mockModels['generateContentStream'] = streamFn;
      mockModels['generateContent'] = nonStreamFn;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      await collectParts(result);

      expect(streamFn).toHaveBeenCalledOnce();
      expect(nonStreamFn).not.toHaveBeenCalled();
    });

    it('calls generateContent when stream is false', async () => {
      const provider = createProvider({ stream: false });
      const mockModels = (provider as any)._client.models as Record<string, unknown>;

      const streamFn = vi.fn();
      const nonStreamFn = vi.fn().mockResolvedValue(makeGenerateContentResponse());

      mockModels['generateContentStream'] = streamFn;
      mockModels['generateContent'] = nonStreamFn;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      await collectParts(result);

      expect(nonStreamFn).toHaveBeenCalledOnce();
      expect(streamFn).not.toHaveBeenCalled();
    });

    it('yields text chunks from stream', async () => {
      async function* mockStream() {
        yield { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] };
        yield { candidates: [{ content: { parts: [{ text: ' world' }] } }] };
      }

      const msg = new GoogleGenAIStreamedMessage(mockStream(), true);
      const parts = await collectParts(msg);

      expect(parts).toEqual([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ]);
    });

    it('yields think parts from stream', async () => {
      async function* mockStream() {
        yield {
          candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }] } }],
        };
        yield {
          candidates: [{ content: { parts: [{ text: 'visible answer' }] } }],
        };
      }

      const msg = new GoogleGenAIStreamedMessage(mockStream(), true);
      const parts = await collectParts(msg);

      expect(parts).toEqual([
        { type: 'think', think: 'thinking...' },
        { type: 'text', text: 'visible answer' },
      ]);
    });

    it('yields function call from stream', async () => {
      async function* mockStream() {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'add',
                      id: 'call_1',
                      args: { a: 2, b: 3 },
                    },
                  },
                ],
              },
            },
          ],
        };
      }

      const msg = new GoogleGenAIStreamedMessage(mockStream(), true);
      const parts = await collectParts(msg);

      expect(parts).toEqual([
        {
          type: 'function',
          id: 'add_call_1',
          function: { name: 'add', arguments: '{"a":2,"b":3}' },
        },
      ]);
    });

    it('yields function call with thought signature from stream', async () => {
      async function* mockStream() {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: 'search', id: 'fc_1', args: { q: 'test' } },
                    thoughtSignature: 'sig_abc123',
                  },
                ],
              },
            },
          ],
        };
      }

      const msg = new GoogleGenAIStreamedMessage(mockStream(), true);
      const parts = await collectParts(msg);

      expect(parts).toEqual([
        {
          type: 'function',
          id: 'search_fc_1',
          function: { name: 'search', arguments: '{"q":"test"}' },
          extras: { thought_signature_b64: 'sig_abc123' },
        },
      ]);
    });

    it('accumulates usage from last chunk', async () => {
      async function* mockStream() {
        yield { candidates: [{ content: { parts: [{ text: 'chunk1' }] } }] };
        yield {
          candidates: [{ content: { parts: [{ text: 'chunk2' }] } }],
          usageMetadata: {
            promptTokenCount: 20,
            candidatesTokenCount: 10,
            cachedContentTokenCount: 5,
          },
        };
      }

      const msg = new GoogleGenAIStreamedMessage(mockStream(), true);
      await collectParts(msg);

      expect(msg.usage).toEqual({
        inputOther: 20,
        output: 10,
        inputCacheRead: 5,
        inputCacheCreation: 0,
      });
    });

    it('extracts responseId from stream chunk', async () => {
      async function* mockStream() {
        yield {
          responseId: 'resp-abc',
          candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        };
      }

      const msg = new GoogleGenAIStreamedMessage(mockStream(), true);
      await collectParts(msg);

      expect(msg.id).toBe('resp-abc');
    });

    it('handles multiple parts in a single stream chunk', async () => {
      async function* mockStream() {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'thinking step', thought: true },
                  { text: 'answer' },
                  {
                    functionCall: { name: 'calc', id: 'fc_1', args: { x: 1 } },
                  },
                ],
              },
            },
          ],
        };
      }

      const msg = new GoogleGenAIStreamedMessage(mockStream(), true);
      const parts = await collectParts(msg);

      expect(parts).toHaveLength(3);
      expect(parts[0]).toEqual({ type: 'think', think: 'thinking step' });
      expect(parts[1]).toEqual({ type: 'text', text: 'answer' });
      expect(parts[2]).toMatchObject({
        type: 'function',
        function: { name: 'calc' },
      });
    });

    it('yields unique ids for parallel function calls without id in same chunk', async () => {
      async function* mockStream() {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'read_file',
                      args: { path: '/a.txt' },
                    },
                  },
                  {
                    functionCall: {
                      name: 'read_file',
                      args: { path: '/b.txt' },
                    },
                  },
                ],
              },
            },
          ],
        };
      }

      const msg = new GoogleGenAIStreamedMessage(mockStream(), true);
      const parts = await collectParts(msg);

      expect(parts).toHaveLength(2);
      const ids = parts.map((p) => (p as ToolCall).id);
      // The two tool calls must have distinct IDs
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('handles empty stream gracefully', async () => {
      async function* mockStream() {
        // no chunks
      }

      const msg = new GoogleGenAIStreamedMessage(mockStream(), true);
      const parts = await collectParts(msg);

      expect(parts).toEqual([]);
      expect(msg.id).toBeNull();
      expect(msg.usage).toBeNull();
    });

    it('handles chunk with no candidates', async () => {
      async function* mockStream() {
        yield { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } };
        yield { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
      }

      const msg = new GoogleGenAIStreamedMessage(mockStream(), true);
      const parts = await collectParts(msg);

      expect(parts).toEqual([{ type: 'text', text: 'ok' }]);
    });

    it('end-to-end: provider.generate returns streaming response', async () => {
      const provider = createProvider({ stream: true });
      const mockModels = (provider as any)._client.models as Record<string, unknown>;

      async function* mockStream() {
        yield {
          responseId: 'resp-e2e',
          candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
        };
        yield {
          candidates: [{ content: { parts: [{ text: ' World' }] } }],
          usageMetadata: {
            promptTokenCount: 8,
            candidatesTokenCount: 4,
          },
        };
      }

      mockModels['generateContentStream'] = vi
        .fn()
        .mockImplementation(() => Promise.resolve(mockStream()));

      const result = await provider.generate(
        'system',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );

      const parts = await collectParts(result);

      expect(parts).toEqual([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' World' },
      ]);
      expect(result.id).toBe('resp-e2e');
      expect(result.usage).toEqual({
        inputOther: 8,
        output: 4,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      });
    });
  });

  describe('tool result validation for assistant tool calls', () => {
    it('throws on unexpected extra tool results', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Running tools' }],
          toolCalls: [
            {
              type: 'function',
              id: 'call_known',
              function: { name: 'add', arguments: '{"a":1,"b":2}' },
            },
          ],
        },
        // A tool result that matches the assistant's known tool call
        {
          role: 'tool',
          content: [{ type: 'text', text: '3' }],
          toolCallId: 'call_known',
          toolCalls: [],
        },
        // An "extra" tool result whose id is NOT in expectedToolCallIds.
        // Previously dropped by the buggy be-tolerant branch; must now be
        // preserved.
        {
          role: 'tool',
          content: [{ type: 'text', text: '42' }],
          toolCallId: 'call_extra_unknown',
          toolCalls: [],
        },
      ];

      expect(() => messagesToGoogleGenAIContents(messages)).toThrow(/Unexpected tool responses/);
    });

    it('throws on missing tool results', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'call_a',
              function: { name: 'tool_a', arguments: '{}' },
            },
            {
              type: 'function',
              id: 'call_b',
              function: { name: 'tool_b', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'A' }],
          toolCallId: 'call_a',
          toolCalls: [],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'orphaned' }],
          toolCallId: 'call_missing_elsewhere',
          toolCalls: [],
        },
      ];

      expect(() => messagesToGoogleGenAIContents(messages)).toThrow(/Missing tool responses/);
    });

    it('throws on duplicate tool results', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'call_a',
              function: { name: 'tool_a', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'A1' }],
          toolCallId: 'call_a',
          toolCalls: [],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'A2' }],
          toolCallId: 'call_a',
          toolCalls: [],
        },
      ];

      expect(() => messagesToGoogleGenAIContents(messages)).toThrow(/Duplicate tool response/);
    });
  });

  describe('abort signal handling', () => {
    it('throws AbortError synchronously when signal is already aborted on entry', async () => {
      const provider = createProvider({ stream: true });
      const mockModels = (provider as any)._client.models as Record<string, unknown>;

      // If the provider forwards to the SDK at all despite a pre-aborted
      // signal, this spy will flag the regression.
      const streamFn = vi.fn();
      mockModels['generateContentStream'] = streamFn;

      const controller = new AbortController();
      controller.abort();

      await expect(
        provider.generate(
          '',
          [],
          [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(streamFn).not.toHaveBeenCalled();
    });

    it('rejects promptly if the signal aborts before the first stream response resolves', async () => {
      const provider = createProvider({ stream: true });
      const mockModels = (provider as unknown as { _client: { models: Record<string, unknown> } })
        ._client.models;
      const controller = new AbortController();

      mockModels['generateContentStream'] = vi.fn().mockImplementation(
        () =>
          new Promise<AsyncGenerator<unknown>>(() => {
            // Intentionally never resolves: reproduces the "stuck before first
            // chunk" window where cancellation must still win the race.
          }),
      );

      const pending = provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
        { signal: controller.signal },
      );

      controller.abort();

      const result = await Promise.race([
        pending.then(
          () => ({ settled: 'resolved' as const }),
          (error: unknown) => ({ settled: 'rejected' as const, error }),
        ),
        new Promise<{ settled: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ settled: 'timeout' }), 100),
        ),
      ]);

      expect(result.settled).toBe('rejected');
      if (result.settled === 'rejected') {
        expect(result.error).toBeInstanceOf(DOMException);
        expect((result.error as DOMException).name).toBe('AbortError');
      }
    });

    it('throws AbortError at the next chunk boundary when aborted mid-stream', async () => {
      const provider = createProvider({ stream: true });
      const mockModels = (provider as any)._client.models as Record<string, unknown>;
      const controller = new AbortController();

      async function* mockStream() {
        yield { candidates: [{ content: { parts: [{ text: 'chunk-1' }] } }] };
        // Simulate the caller aborting between chunks
        controller.abort();
        yield { candidates: [{ content: { parts: [{ text: 'chunk-2' }] } }] };
      }

      mockModels['generateContentStream'] = vi
        .fn()
        .mockImplementation(() => Promise.resolve(mockStream()));

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
        { signal: controller.signal },
      );

      const received: StreamedMessagePart[] = [];
      let caught: unknown;
      try {
        for await (const part of result) {
          received.push(part);
        }
      } catch (error) {
        caught = error;
      }

      // The first chunk should have been yielded before the abort triggered.
      expect(received).toEqual([{ type: 'text', text: 'chunk-1' }]);
      // The post-abort chunk must never be observed — the second loop
      // iteration checks the signal and throws AbortError.
      expect(caught).toBeInstanceOf(DOMException);
      expect((caught as DOMException).name).toBe('AbortError');
    });

    it('non-stream path throws AbortError if signal fires before iteration', async () => {
      const provider = createProvider({ stream: false });
      const mockModels = (provider as any)._client.models as Record<string, unknown>;

      mockModels['generateContent'] = vi.fn().mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'done' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });

      const controller = new AbortController();
      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
        { signal: controller.signal },
      );

      // Abort AFTER generate() resolves but BEFORE we drain the iterator.
      controller.abort();

      let caught: unknown;
      try {
        for await (const _ of result) {
          // drain — but the first pre-check inside the generator should fire
        }
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DOMException);
      expect((caught as DOMException).name).toBe('AbortError');
    });
  });

  describe('RetryableChatProvider.onRetryableError', () => {
    it('rebuilds the Google GenAI client', () => {
      const provider = createProvider();
      const oldClient = (provider as any)._client;

      const result = provider.onRetryableError(new Error('transient'));

      expect(result).toBe(true);
      expect((provider as any)._client).not.toBe(oldClient);
    });

    it('next generate() uses the freshly rebuilt client', async () => {
      const provider = createProvider({ stream: true });

      // Install a mock on the original client. After onRetryableError the
      // client is replaced, so this original mock must NEVER be called.
      const originalMockModels = (provider as any)._client.models as Record<string, unknown>;
      const originalStreamFn = vi.fn();
      originalMockModels['generateContentStream'] = originalStreamFn;

      provider.onRetryableError(new Error('transient'));

      const newMockModels = (provider as any)._client.models as Record<string, unknown>;
      const newStreamFn = vi.fn().mockImplementation(() => {
        async function* gen() {
          // Capture `provider` from the enclosing scope so this generator
          // is not flagged as scope-independent by eslint-plugin-unicorn.
          void provider;
          yield { candidates: [{ content: { parts: [{ text: 'fresh' }] } }] };
        }
        return Promise.resolve(gen());
      });
      newMockModels['generateContentStream'] = newStreamFn;

      const result = await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      const parts = await collectParts(result);

      expect(parts).toEqual([{ type: 'text', text: 'fresh' }]);
      expect(newStreamFn).toHaveBeenCalledTimes(1);
      expect(originalStreamFn).not.toHaveBeenCalled();
    });

    it('preserves apiKey across rebuilds (no re-read of env)', () => {
      const provider = new GoogleGenAIChatProvider({
        model: 'gemini-2.5-flash',
        apiKey: 'stored-key',
      });

      // Temporarily scrub env to ensure rebuild uses the stored key, not env.
      const prevEnv = process.env['GOOGLE_API_KEY'];
      delete process.env['GOOGLE_API_KEY'];
      try {
        expect(() => provider.onRetryableError(new Error('transient'))).not.toThrow();
        expect((provider as any)._client).toBeDefined();
      } finally {
        if (prevEnv !== undefined) process.env['GOOGLE_API_KEY'] = prevEnv;
      }
    });

    it('preserves vertexai / project / location across rebuilds', () => {
      // vertexai mode does not take an apiKey in the SDK — it relies on
      // gcloud credentials, so we verify the provider stores project /
      // location and rebuilds a vertex client without throwing.
      const provider = new GoogleGenAIChatProvider({
        model: 'gemini-2.5-flash',
        vertexai: true,
        project: 'my-project',
        location: 'us-central1',
      });

      expect(() => provider.onRetryableError(new Error('transient'))).not.toThrow();
      expect((provider as any)._client).toBeDefined();
    });
  });
});
