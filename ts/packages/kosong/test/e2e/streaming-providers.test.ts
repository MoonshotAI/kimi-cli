import { describe, expect, it } from 'vitest';

import { generate } from '../../src/generate.js';
import type { GenerateCallbacks } from '../../src/generate.js';
import type {
  Message,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
} from '../../src/message.js';
import { extractText } from '../../src/message.js';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '../../src/provider.js';
import type { Tool } from '../../src/tool.js';
import type { TokenUsage } from '../../src/usage.js';

// ── Helpers ────────��────────────────────────���────────────────────────

/**
 * Build a StreamedMessage from an array of parts plus metadata.
 * Simulates what a provider adapter would produce.
 */
function buildStream(
  parts: StreamedMessagePart[],
  opts?: { id?: string; usage?: TokenUsage },
): StreamedMessage {
  return {
    get id(): string | null {
      return opts?.id ?? null;
    },
    get usage(): TokenUsage | null {
      return opts?.usage ?? null;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

/**
 * A test provider that returns a single pre-built StreamedMessage.
 */
class SingleStreamProvider implements ChatProvider {
  readonly name: string;
  readonly modelName: string;
  readonly thinkingEffort: ThinkingEffort | null = null;
  private readonly _stream: StreamedMessage;

  constructor(stream: StreamedMessage, name: string = 'test') {
    this._stream = stream;
    this.name = name;
    this.modelName = name;
  }

  async generate(
    _systemPrompt: string,
    _tools: Tool[],
    _history: Message[],
  ): Promise<StreamedMessage> {
    return this._stream;
  }

  withThinking(_effort: ThinkingEffort): ChatProvider {
    return this;
  }
}

// ── Tests: synthetic Kimi-style streaming ─────────────────────────────

describe('integration: streaming provider contracts', () => {
  describe('synthetic Kimi-style SSE streaming', () => {
    it('multi-chunk text + tool_call + tool_call_part + usage', async () => {
      const usage: TokenUsage = {
        inputOther: 100,
        output: 50,
        inputCacheRead: 20,
        inputCacheCreation: 0,
      };

      // Simulate: text delta -> text delta -> tool_call -> tool_call_part -> (usage on stream)
      const parts: StreamedMessagePart[] = [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world!' },
        {
          type: 'function',
          id: 'tc-kimi-1',
          function: { name: 'search', arguments: null },
        } satisfies ToolCall,
        { type: 'tool_call_part', argumentsPart: '{"query":' },
        { type: 'tool_call_part', argumentsPart: '"vitest"}' },
      ];

      const stream = buildStream(parts, { id: 'kimi-resp-1', usage });
      const provider = new SingleStreamProvider(stream, 'kimi');

      const receivedParts: StreamedMessagePart[] = [];
      const callbacks: GenerateCallbacks = {
        onMessagePart(part: StreamedMessagePart): void {
          receivedParts.push(part);
        },
      };

      const result = await generate(provider, 'system', [], [], callbacks);

      // onMessagePart called in correct order: text, text, tool_call, part, part
      expect(receivedParts).toHaveLength(5);
      expect(receivedParts[0]!.type).toBe('text');
      expect(receivedParts[1]!.type).toBe('text');
      expect(receivedParts[2]!.type).toBe('function');
      expect(receivedParts[3]!.type).toBe('tool_call_part');
      expect(receivedParts[4]!.type).toBe('tool_call_part');

      // Final message.content should merge text deltas
      expect(result.message.content).toHaveLength(1);
      expect(extractText(result.message)).toBe('Hello world!');

      // ToolCall assembled correctly
      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls[0]!.function.arguments).toBe('{"query":"vitest"}');

      // Usage extracted from the stream metadata
      expect(result.usage).toEqual(usage);
      expect(result.id).toBe('kimi-resp-1');
    });

    it('reasoning_content chunks interleave with text', async () => {
      const parts: StreamedMessagePart[] = [
        { type: 'think', think: 'Let me ' },
        { type: 'think', think: 'reason about this.' },
        { type: 'text', text: 'The answer is 42.' },
      ];

      const stream = buildStream(parts, { id: 'kimi-think-1' });
      const provider = new SingleStreamProvider(stream, 'kimi');
      const result = await generate(provider, '', [], []);

      expect(result.message.content).toHaveLength(2);
      expect(result.message.content[0]!.type).toBe('think');
      expect((result.message.content[0] as ThinkPart).think).toBe('Let me reason about this.');
      expect(result.message.content[1]!.type).toBe('text');
      expect((result.message.content[1] as TextPart).text).toBe('The answer is 42.');
    });
  });

  // ── Tests: Anthropic streaming ────────────────────────────────────

  describe('Anthropic-style event streaming', () => {
    it('message_start -> content_block_delta[text] -> thinking + signature -> tool_use', async () => {
      // Simulate Anthropic stream events mapped to StreamedMessagePart sequence.
      // In the real provider, events like message_start, content_block_start, etc.
      // are converted to StreamedMessagePart by AnthropicStreamedMessage.
      // Here we simulate the output of that conversion.

      const parts: StreamedMessagePart[] = [
        // content_block_start(text) => text with initial empty
        { type: 'text', text: '' },
        // content_block_delta(text_delta)
        { type: 'text', text: 'Here is my response.' },
        // content_block_start(thinking) => think part
        { type: 'think', think: '' },
        // content_block_delta(thinking_delta)
        { type: 'think', think: 'I need to analyze this carefully.' },
        // content_block_delta(signature_delta) => think with encrypted
        { type: 'think', think: '', encrypted: 'sig-abc123' },
        // content_block_start(tool_use)
        {
          type: 'function',
          id: 'toolu_01',
          function: { name: 'read_file', arguments: '' },
        } satisfies ToolCall,
        // content_block_delta(input_json_delta)
        { type: 'tool_call_part', argumentsPart: '{"path":"/src/main.ts"}' },
      ];

      const usage: TokenUsage = {
        inputOther: 200,
        output: 100,
        inputCacheRead: 50,
        inputCacheCreation: 10,
      };

      const stream = buildStream(parts, { id: 'msg_anthropic_1', usage });
      const provider = new SingleStreamProvider(stream, 'anthropic');
      const result = await generate(provider, '', [], []);

      // Text parts should merge: '' + 'Here is my response.'
      const textParts = result.message.content.filter((p) => p.type === 'text');
      expect(textParts).toHaveLength(1);
      expect((textParts[0] as TextPart).text).toBe('Here is my response.');

      // Think part should have encrypted set after signature_delta
      const thinkParts = result.message.content.filter((p) => p.type === 'think');
      expect(thinkParts).toHaveLength(1);
      const thinkPart = thinkParts[0] as ThinkPart;
      expect(thinkPart.think).toBe('I need to analyze this carefully.');
      expect(thinkPart.encrypted).toBe('sig-abc123');

      // ToolCall assembled
      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls[0]!.id).toBe('toolu_01');
      expect(result.message.toolCalls[0]!.function.name).toBe('read_file');
      expect(result.message.toolCalls[0]!.function.arguments).toBe('{"path":"/src/main.ts"}');
    });

    it('redacted_thinking yields ThinkPart with encrypted and empty think', async () => {
      const parts: StreamedMessagePart[] = [
        // redacted_thinking block
        { type: 'think', think: '', encrypted: 'redacted-data-blob' },
        // Then a normal text response
        { type: 'text', text: 'I have processed the request.' },
      ];

      const stream = buildStream(parts);
      const provider = new SingleStreamProvider(stream, 'anthropic');
      const result = await generate(provider, '', [], []);

      expect(result.message.content).toHaveLength(2);
      const redacted = result.message.content[0] as ThinkPart;
      expect(redacted.type).toBe('think');
      expect(redacted.think).toBe('');
      expect(redacted.encrypted).toBe('redacted-data-blob');
    });

    it('multiple content blocks in Anthropic style', async () => {
      const parts: StreamedMessagePart[] = [
        // First thinking block
        { type: 'think', think: 'Step 1: analyze.' },
        { type: 'think', think: '', encrypted: 'sig-1' },
        // First text block
        { type: 'text', text: 'First part.' },
        // Second thinking block (new block, can not merge with first due to encrypted)
        { type: 'think', think: 'Step 2: synthesize.' },
        { type: 'think', think: '', encrypted: 'sig-2' },
        // Second text block
        { type: 'text', text: 'Second part.' },
      ];

      const stream = buildStream(parts);
      const provider = new SingleStreamProvider(stream, 'anthropic');
      const result = await generate(provider, '', [], []);

      // Think blocks cannot merge once encrypted is set, so we get:
      // think(step1 + sig), text(first), think(step2 + sig), text(second)
      expect(result.message.content).toHaveLength(4);
      expect(result.message.content[0]!.type).toBe('think');
      expect((result.message.content[0] as ThinkPart).encrypted).toBe('sig-1');
      expect(result.message.content[1]!.type).toBe('text');
      expect(result.message.content[2]!.type).toBe('think');
      expect((result.message.content[2] as ThinkPart).encrypted).toBe('sig-2');
      expect(result.message.content[3]!.type).toBe('text');
    });
  });

  // ── Tests: Google GenAI streaming ────���────────────────────────────

  describe('Google GenAI-style streaming', () => {
    it('multi-chunk with text + functionCall + thought', async () => {
      // Google GenAI streaming yields chunks that the GoogleGenAIStreamedMessage
      // converts to StreamedMessagePart. Simulate the output.

      const parts: StreamedMessagePart[] = [
        // Thought chunk
        { type: 'think', think: 'Analyzing the request...' },
        // Text chunk
        { type: 'text', text: 'I will help you with that.' },
        // Function call chunk - Google format uses {name}_{id} for toolCallId
        {
          type: 'function',
          id: 'search_12345',
          function: { name: 'search', arguments: '{"query":"vitest docs"}' },
        } satisfies ToolCall,
      ];

      const usage: TokenUsage = {
        inputOther: 150,
        output: 80,
        inputCacheRead: 30,
        inputCacheCreation: 0,
      };

      const stream = buildStream(parts, { id: 'resp-google-1', usage });
      const provider = new SingleStreamProvider(stream, 'google_genai');
      const result = await generate(provider, '', [], []);

      // Think part
      expect(result.message.content).toHaveLength(2);
      expect(result.message.content[0]!.type).toBe('think');
      expect((result.message.content[0] as ThinkPart).think).toBe('Analyzing the request...');

      // Text part
      expect(result.message.content[1]!.type).toBe('text');
      expect((result.message.content[1] as TextPart).text).toBe('I will help you with that.');

      // Function call with correct ID format
      expect(result.message.toolCalls).toHaveLength(1);
      const tc = result.message.toolCalls[0]!;
      expect(tc.id).toBe('search_12345');
      expect(tc.id).toMatch(/^search_\d+$/);
      expect(tc.function.name).toBe('search');
      expect(tc.function.arguments).toBe('{"query":"vitest docs"}');
    });

    it('Google function_call ID format: {name}_{id}', async () => {
      const parts: StreamedMessagePart[] = [
        {
          type: 'function',
          id: 'read_file_9876',
          function: { name: 'read_file', arguments: '{"path":"/tmp/test.ts"}' },
        } satisfies ToolCall,
        { type: 'text', text: 'Reading the file.' },
      ];

      const stream = buildStream(parts);
      const provider = new SingleStreamProvider(stream, 'google_genai');
      const result = await generate(provider, '', [], []);

      expect(result.message.toolCalls).toHaveLength(1);
      const tc = result.message.toolCalls[0]!;
      // Verify the ID follows the {name}_{id} pattern
      expect(tc.id.startsWith(`${tc.function.name}_`)).toBe(true);
    });

    it('Google multiple function calls in single response', async () => {
      const parts: StreamedMessagePart[] = [
        { type: 'text', text: 'Fetching multiple files.' },
        {
          type: 'function',
          id: 'read_file_001',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
        } satisfies ToolCall,
        {
          type: 'function',
          id: 'read_file_002',
          function: { name: 'read_file', arguments: '{"path":"b.ts"}' },
        } satisfies ToolCall,
        {
          type: 'function',
          id: 'write_file_003',
          function: { name: 'write_file', arguments: '{"path":"c.ts","content":"x"}' },
        } satisfies ToolCall,
      ];

      const stream = buildStream(parts);
      const provider = new SingleStreamProvider(stream, 'google_genai');
      const result = await generate(provider, '', [], []);

      expect(result.message.toolCalls).toHaveLength(3);
      expect(result.message.toolCalls[0]!.id).toBe('read_file_001');
      expect(result.message.toolCalls[1]!.id).toBe('read_file_002');
      expect(result.message.toolCalls[2]!.id).toBe('write_file_003');
    });
  });

  // ── Cross-provider edge cases ─────────────────────────────────────

  describe('cross-provider edge cases', () => {
    it('empty text deltas are merged without creating extra parts', async () => {
      const parts: StreamedMessagePart[] = [
        { type: 'text', text: '' },
        { type: 'text', text: '' },
        { type: 'text', text: 'actual content' },
        { type: 'text', text: '' },
      ];

      const stream = buildStream(parts);
      const provider = new SingleStreamProvider(stream);
      const result = await generate(provider, '', [], []);

      expect(result.message.content).toHaveLength(1);
      expect(extractText(result.message)).toBe('actual content');
    });

    it('think-only response throws APIEmptyResponseError', async () => {
      const parts: StreamedMessagePart[] = [{ type: 'think', think: 'Just thinking...' }];

      const stream = buildStream(parts);
      const provider = new SingleStreamProvider(stream);

      await expect(generate(provider, '', [], [])).rejects.toThrow(/only thinking content/);
    });

    it('usage metadata is correctly passed through from stream', async () => {
      const usage: TokenUsage = {
        inputOther: 500,
        output: 200,
        inputCacheRead: 100,
        inputCacheCreation: 50,
      };

      const parts: StreamedMessagePart[] = [{ type: 'text', text: 'response' }];

      const stream = buildStream(parts, { id: 'test-id', usage });
      const provider = new SingleStreamProvider(stream);
      const result = await generate(provider, '', [], []);

      expect(result.usage).toEqual(usage);
      expect(result.id).toBe('test-id');
    });
  });
});
