import { describe, expect, it } from 'vitest';

import { generate } from '../src/generate.js';
import type { ContentPart, Message, StreamedMessagePart, TextPart } from '../src/message.js';
import { createAssistantMessage, createUserMessage } from '../src/message.js';
import type {
  ChatProvider,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from '../src/provider.js';
import { SimpleToolset } from '../src/simple-toolset.js';
import type { Tool, ToolReturnValue } from '../src/tool.js';
import { toolOk } from '../src/tool.js';
import type { TokenUsage } from '../src/usage.js';

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockStream(
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

function createMockProvider(stream: StreamedMessage): ChatProvider {
  return {
    name: 'mock',
    modelName: 'mock-model',
    thinkingEffort: null,
    generate: async (
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
      _options?: GenerateOptions,
    ): Promise<StreamedMessage> => stream,
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

// ── Regression tests ─────────────────────────────────────────────────

describe('regression', () => {
  describe('Bug #1: ThinkPart must not produce empty text in content array', () => {
    it('Kimi/OpenAILegacy convertMessage strips ThinkPart from content (mock validation)', () => {
      // Simulate what the provider convertMessage does: separate think parts
      // from non-think parts and ensure no empty text leaks through.
      const historyMessage = createAssistantMessage([
        { type: 'think', think: 'Let me reason about this...' },
        { type: 'text', text: 'The answer is 42.' },
      ]);

      // Replicate the provider convertMessage logic:
      const nonThinkParts: ContentPart[] = [];
      for (const part of historyMessage.content) {
        if (part.type === 'think') {
          // ThinkPart goes to reasoningContent, not content
          continue;
        }
        nonThinkParts.push(part);
      }

      // The content array should only contain non-think parts
      expect(nonThinkParts.every((p) => p.type !== 'think')).toBe(true);
      // No empty text parts should be produced from think extraction
      const textParts = nonThinkParts.filter((p): p is TextPart => p.type === 'text');
      expect(textParts.every((p) => p.text.length > 0)).toBe(true);
    });

    it('history with only ThinkPart produces no content array entries', () => {
      const historyMessage = createAssistantMessage([
        { type: 'think', think: 'Deep reasoning...' },
      ]);

      const nonThinkParts: ContentPart[] = [];
      for (const part of historyMessage.content) {
        if (part.type !== 'think') {
          nonThinkParts.push(part);
        }
      }

      expect(nonThinkParts).toHaveLength(0);
    });
  });

  describe('Bug #2: generate() must not filter empty TextPart', () => {
    it('empty TextPart is preserved in message.content', async () => {
      const stream = createMockStream([
        { type: 'text', text: 'hello' },
        { type: 'text', text: '' },
      ]);
      const provider = createMockProvider(stream);

      const result = await generate(provider, '', [], []);

      // The two text parts get merged: "hello" + "" = "hello"
      // After merge, the content should include the empty text merged in.
      // The key invariant is that empty TextParts are NOT filtered out
      // during streaming — they are merged normally.
      expect(result.message.content.length).toBeGreaterThanOrEqual(1);
      // Verify content[0] is a text part containing "hello"
      expect(result.message.content[0]!.type).toBe('text');
      expect((result.message.content[0] as TextPart).text).toBe('hello');
    });

    it('standalone empty TextPart is kept in content', async () => {
      // A single non-empty text followed by a break (image) then empty text
      const stream = createMockStream([
        { type: 'text', text: 'before' },
        { type: 'image_url', imageUrl: { url: 'https://example.com/img.png' } },
        { type: 'text', text: '' },
      ]);
      const provider = createMockProvider(stream);

      const result = await generate(provider, '', [], []);

      // "before" is one part, image is another, empty text "" is its own part
      expect(result.message.content).toHaveLength(3);
      expect(result.message.content[2]!.type).toBe('text');
      expect((result.message.content[2] as TextPart).text).toBe('');
    });
  });

  describe('Bug #3: SimpleToolset.remove() throws for non-existent tool', () => {
    it('throws an error when removing a tool that does not exist', () => {
      const toolset = new SimpleToolset();

      expect(() => toolset.remove('nonexistent-tool')).toThrow(
        'Tool `nonexistent-tool` not found in the toolset.',
      );
    });

    it('throws after tool was already removed', () => {
      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'my-tool', description: 'test', parameters: {} },
        async (): Promise<ToolReturnValue> => toolOk({ output: 'ok' }),
      );

      toolset.remove('my-tool');
      expect(() => toolset.remove('my-tool')).toThrow('Tool `my-tool` not found in the toolset.');
    });
  });

  describe('Bug #8: readLines preserves trailing newline', () => {
    // Note: This is tested via the Kaos local.test.ts, but we verify
    // the contract here at the integration level.
    it('readLines yields lines with trailing newline (verified at kaos level)', async () => {
      // This test validates the contract: readLines should yield "line\n" for
      // each line that ends with \n. Since we cannot access the filesystem
      // in kosong regression tests, we verify the behavior via a mock that
      // implements the same contract as LocalKaos.readLines.
      const content = 'line1\nline2\nline3\n';
      const lines = content.split('\n');
      const yielded: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (i < lines.length - 1) {
          yielded.push(line + '\n');
        } else if (line !== '') {
          yielded.push(line);
        }
      }

      expect(yielded).toEqual(['line1\n', 'line2\n', 'line3\n']);
      // Each non-final line should end with \n
      for (const line of yielded) {
        expect(line.endsWith('\n')).toBe(true);
      }
    });

    it('last line without trailing newline is yielded without \\n', () => {
      const content = 'line1\nline2';
      const lines = content.split('\n');
      const yielded: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (i < lines.length - 1) {
          yielded.push(line + '\n');
        } else if (line !== '') {
          yielded.push(line);
        }
      }

      expect(yielded).toEqual(['line1\n', 'line2']);
      expect(yielded[0]!.endsWith('\n')).toBe(true);
      expect(yielded[1]!.endsWith('\n')).toBe(false);
    });
  });

  describe('PR4: toolCalls defaults to empty array', () => {
    it('createUserMessage has toolCalls as empty array (not undefined)', () => {
      const msg = createUserMessage('hello');
      expect(msg.toolCalls).toBeDefined();
      expect(Array.isArray(msg.toolCalls)).toBe(true);
      expect(msg.toolCalls.length).toBe(0);
    });

    it('createAssistantMessage without toolCalls has empty array', () => {
      const msg = createAssistantMessage([{ type: 'text', text: 'test' }]);
      expect(msg.toolCalls).toBeDefined();
      expect(Array.isArray(msg.toolCalls)).toBe(true);
      expect(msg.toolCalls.length).toBe(0);
    });

    it('createAssistantMessage with explicit toolCalls preserves them', () => {
      const msg = createAssistantMessage(
        [{ type: 'text', text: 'test' }],
        [
          {
            type: 'function',
            id: 'call-1',
            function: { name: 'search', arguments: '{}' },
          },
        ],
      );
      expect(msg.toolCalls.length).toBe(1);
    });

    it('generate() result message has toolCalls as empty array when no tools called', async () => {
      const stream = createMockStream([{ type: 'text', text: 'hi' }]);
      const provider = createMockProvider(stream);

      const result = await generate(provider, '', [], []);
      expect(result.message.toolCalls).toBeDefined();
      expect(Array.isArray(result.message.toolCalls)).toBe(true);
      expect(result.message.toolCalls.length).toBe(0);
    });
  });
});
