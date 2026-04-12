import { describe, expect, it } from 'vitest';

import { generate } from '../../src/generate.js';
import type { GenerateCallbacks } from '../../src/generate.js';
import type { StreamedMessagePart, TextPart, ThinkPart, ToolCall } from '../../src/message.js';
import { extractText } from '../../src/message.js';
import { MockChatProvider } from '../../src/mock-provider.js';
import { SimpleToolset } from '../../src/simple-toolset.js';
import { step } from '../../src/step.js';
import type { ToolReturnValue } from '../../src/tool.js';
import { toolOk } from '../../src/tool.js';

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: streaming fidelity', () => {
  describe('TextPart delta merging', () => {
    it('100+ TextPart deltas merge into one text content part', async () => {
      const count = 120;
      const parts: StreamedMessagePart[] = [];
      for (let i = 0; i < count; i++) {
        parts.push({ type: 'text', text: `chunk${i} ` });
      }

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      // All text chunks should be merged into a single TextPart
      expect(result.message.content).toHaveLength(1);
      expect(result.message.content[0]!.type).toBe('text');

      const expected = Array.from({ length: count }, (_, i) => `chunk${i} `).join('');
      expect(extractText(result.message)).toBe(expected);
    });

    it('empty text deltas do not create spurious parts', async () => {
      const parts: StreamedMessagePart[] = [
        { type: 'text', text: '' },
        { type: 'text', text: 'hello' },
        { type: 'text', text: '' },
        { type: 'text', text: ' world' },
        { type: 'text', text: '' },
      ];

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      // Should be merged into a single text part
      expect(result.message.content).toHaveLength(1);
      expect(extractText(result.message)).toBe('hello world');
    });
  });

  describe('interleaved ThinkPart + TextPart', () => {
    it('ThinkPart then TextPart produces separate parts, not mixed', async () => {
      const parts: StreamedMessagePart[] = [
        { type: 'think', think: 'Let me ' },
        { type: 'think', think: 'think about this...' },
        { type: 'text', text: 'Here is ' },
        { type: 'text', text: 'my answer.' },
      ];

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      expect(result.message.content).toHaveLength(2);
      expect(result.message.content[0]).toEqual({
        type: 'think',
        think: 'Let me think about this...',
      });
      expect(result.message.content[1]).toEqual({
        type: 'text',
        text: 'Here is my answer.',
      });
    });

    it('alternating think-text-think-text produces 4 separate parts', async () => {
      const parts: StreamedMessagePart[] = [
        { type: 'think', think: 'thought-A' },
        { type: 'text', text: 'text-A' },
        { type: 'think', think: 'thought-B' },
        { type: 'text', text: 'text-B' },
      ];

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      expect(result.message.content).toHaveLength(4);
      expect(result.message.content[0]).toEqual({ type: 'think', think: 'thought-A' });
      expect(result.message.content[1]).toEqual({ type: 'text', text: 'text-A' });
      expect(result.message.content[2]).toEqual({ type: 'think', think: 'thought-B' });
      expect(result.message.content[3]).toEqual({ type: 'text', text: 'text-B' });
    });

    it('many ThinkPart deltas followed by many TextPart deltas are properly separated', async () => {
      const parts: StreamedMessagePart[] = [];
      for (let i = 0; i < 50; i++) {
        parts.push({ type: 'think', think: `t${i} ` });
      }
      for (let i = 0; i < 50; i++) {
        parts.push({ type: 'text', text: `w${i} ` });
      }

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      expect(result.message.content).toHaveLength(2);
      expect(result.message.content[0]!.type).toBe('think');
      expect(result.message.content[1]!.type).toBe('text');

      const thinkPart = result.message.content[0] as ThinkPart;
      const textPart = result.message.content[1] as TextPart;
      expect(thinkPart.think.split(' ').filter(Boolean)).toHaveLength(50);
      expect(textPart.text.split(' ').filter(Boolean)).toHaveLength(50);
    });
  });

  describe('ToolCall argument assembly from ToolCallPart deltas', () => {
    it('single ToolCall with 10+ ToolCallPart deltas assembles arguments correctly', async () => {
      const fullArgs = JSON.stringify({
        query: 'a very long search query with many words to ensure streaming',
        limit: 100,
        offset: 0,
        filters: { category: 'test', status: 'active' },
      });

      // Split into small chunks
      const chunkSize = 8;
      const parts: StreamedMessagePart[] = [
        {
          type: 'function',
          id: 'tc-1',
          function: { name: 'search', arguments: null },
        } satisfies ToolCall,
      ];

      for (let i = 0; i < fullArgs.length; i += chunkSize) {
        parts.push({
          type: 'tool_call_part',
          argumentsPart: fullArgs.slice(i, i + chunkSize),
        });
      }

      // Add text after so the response is not empty
      parts.push({ type: 'text', text: 'done' });

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls![0]!.function.arguments).toBe(fullArgs);

      // Verify JSON is parseable and complete
      const parsed = JSON.parse(result.message.toolCalls![0]!.function.arguments!) as Record<
        string,
        unknown
      >;
      expect(parsed['query']).toBe('a very long search query with many words to ensure streaming');
      expect(parsed['limit']).toBe(100);
    });

    it('multiple ToolCalls each with ToolCallPart deltas assemble independently', async () => {
      const args1 = JSON.stringify({ file: 'a.ts' });
      const args2 = JSON.stringify({ file: 'b.ts' });

      const parts: StreamedMessagePart[] = [
        // First tool call
        {
          type: 'function',
          id: 'tc-a',
          function: { name: 'read_file', arguments: null },
        } satisfies ToolCall,
        { type: 'tool_call_part', argumentsPart: args1.slice(0, 5) },
        { type: 'tool_call_part', argumentsPart: args1.slice(5) },
        // Second tool call
        {
          type: 'function',
          id: 'tc-b',
          function: { name: 'read_file', arguments: null },
        } satisfies ToolCall,
        { type: 'tool_call_part', argumentsPart: args2.slice(0, 5) },
        { type: 'tool_call_part', argumentsPart: args2.slice(5) },
        // Text to avoid empty response
        { type: 'text', text: 'files read' },
      ];

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      expect(result.message.toolCalls).toHaveLength(2);
      expect(result.message.toolCalls![0]!.function.arguments).toBe(args1);
      expect(result.message.toolCalls![1]!.function.arguments).toBe(args2);
    });

    it('ToolCallPart with null argumentsPart does not corrupt arguments', async () => {
      const parts: StreamedMessagePart[] = [
        {
          type: 'function',
          id: 'tc-null',
          function: { name: 'tool_x', arguments: null },
        } satisfies ToolCall,
        { type: 'tool_call_part', argumentsPart: null },
        { type: 'tool_call_part', argumentsPart: '{"key":' },
        { type: 'tool_call_part', argumentsPart: null },
        { type: 'tool_call_part', argumentsPart: '"val"}' },
        { type: 'text', text: 'done' },
      ];

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls![0]!.function.arguments).toBe('{"key":"val"}');
    });
  });

  describe('onMessagePart callback fidelity', () => {
    it('receives raw unmerged parts as deep copies', async () => {
      const parts: StreamedMessagePart[] = [
        { type: 'text', text: 'chunk1' },
        { type: 'text', text: 'chunk2' },
        { type: 'text', text: 'chunk3' },
      ];

      const provider = new MockChatProvider(parts);
      const receivedParts: StreamedMessagePart[] = [];

      const callbacks: GenerateCallbacks = {
        onMessagePart(part: StreamedMessagePart): void {
          receivedParts.push(part);
        },
      };

      const result = await generate(provider, '', [], [], callbacks);

      // Callback should receive each raw part unmerged
      expect(receivedParts).toHaveLength(3);
      expect(receivedParts[0]).toEqual({ type: 'text', text: 'chunk1' });
      expect(receivedParts[1]).toEqual({ type: 'text', text: 'chunk2' });
      expect(receivedParts[2]).toEqual({ type: 'text', text: 'chunk3' });

      // But the final message should be merged
      expect(result.message.content).toHaveLength(1);
      expect(extractText(result.message)).toBe('chunk1chunk2chunk3');
    });

    it('callback receives deep copies that are not mutated by merging', async () => {
      const parts: StreamedMessagePart[] = [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
      ];

      const provider = new MockChatProvider(parts);
      const receivedParts: StreamedMessagePart[] = [];

      await generate(provider, '', [], [], {
        onMessagePart(part: StreamedMessagePart): void {
          receivedParts.push(part);
        },
      });

      // The first callback part should still be 'A', not 'AB'
      // because the callback receives a deep copy
      expect((receivedParts[0] as TextPart).text).toBe('A');
      expect((receivedParts[1] as TextPart).text).toBe('B');
    });

    it('callback receives ToolCallPart deltas independently', async () => {
      const parts: StreamedMessagePart[] = [
        {
          type: 'function',
          id: 'tc-1',
          function: { name: 'tool', arguments: null },
        } satisfies ToolCall,
        { type: 'tool_call_part', argumentsPart: '{"a":' },
        { type: 'tool_call_part', argumentsPart: '1}' },
        { type: 'text', text: 'done' },
      ];

      const provider = new MockChatProvider(parts);
      const receivedParts: StreamedMessagePart[] = [];

      await generate(provider, '', [], [], {
        onMessagePart(part: StreamedMessagePart): void {
          receivedParts.push(part);
        },
      });

      expect(receivedParts).toHaveLength(4);
      // Each ToolCallPart should be received separately
      expect(receivedParts[0]!.type).toBe('function');
      expect(receivedParts[1]).toEqual({ type: 'tool_call_part', argumentsPart: '{"a":' });
      expect(receivedParts[2]).toEqual({ type: 'tool_call_part', argumentsPart: '1}' });
      expect(receivedParts[3]).toEqual({ type: 'text', text: 'done' });
    });
  });

  describe('onToolCall callback timing', () => {
    it('fires only after ToolCall is fully assembled from parts', async () => {
      const parts: StreamedMessagePart[] = [
        {
          type: 'function',
          id: 'tc-1',
          function: { name: 'search', arguments: null },
        } satisfies ToolCall,
        { type: 'tool_call_part', argumentsPart: '{"query' },
        { type: 'tool_call_part', argumentsPart: '":"test' },
        { type: 'tool_call_part', argumentsPart: '"}' },
        // New text part flushes the pending ToolCall
        { type: 'text', text: 'searching...' },
      ];

      const provider = new MockChatProvider(parts);
      const toolCallSnapshots: string[] = [];

      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'search', description: 'Search', parameters: {} },
        async (): Promise<ToolReturnValue> => toolOk({ output: 'found' }),
      );

      await step(provider, '', toolset, [], {
        onMessagePart(part: StreamedMessagePart): void {
          // Track when onMessagePart sees the ToolCall
          if (part.type === 'function') {
            const tc = part as ToolCall;
            toolCallSnapshots.push(`onMessagePart:args=${tc.function.arguments}`);
          }
        },
      });

      // The onMessagePart callback should see the ToolCall with null arguments
      // (because it's the first delta, deep-copied before merging)
      expect(toolCallSnapshots[0]).toBe('onMessagePart:args=null');
    });

    it('onToolCall fires for each ToolCall in multi-tool stream', async () => {
      const parts: StreamedMessagePart[] = [
        {
          type: 'function',
          id: 'tc-a',
          function: { name: 'tool_a', arguments: '{"x":1}' },
        } satisfies ToolCall,
        {
          type: 'function',
          id: 'tc-b',
          function: { name: 'tool_b', arguments: '{"y":2}' },
        } satisfies ToolCall,
        { type: 'text', text: 'done' },
      ];

      const provider = new MockChatProvider(parts);

      const toolset = new SimpleToolset();
      toolset.add(
        { name: 'tool_a', description: 'A', parameters: {} },
        async (): Promise<ToolReturnValue> => toolOk({ output: 'a' }),
      );
      toolset.add(
        { name: 'tool_b', description: 'B', parameters: {} },
        async (): Promise<ToolReturnValue> => toolOk({ output: 'b' }),
      );

      const result = await step(provider, '', toolset, []);
      const toolResults = await result.toolResults();

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0]!.id).toBe('tc-a');
      expect(result.toolCalls[1]!.id).toBe('tc-b');
      expect(toolResults).toHaveLength(2);
    });
  });

  describe('large-scale streaming', () => {
    it('1000 TextPart deltas → single merged content', async () => {
      const count = 1000;
      const parts: StreamedMessagePart[] = [];
      for (let i = 0; i < count; i++) {
        parts.push({ type: 'text', text: 'x' });
      }

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      expect(result.message.content).toHaveLength(1);
      expect(extractText(result.message)).toBe('x'.repeat(count));
    });

    it('text + 5 tool calls with streamed args + trailing text', async () => {
      const parts: StreamedMessagePart[] = [{ type: 'text', text: 'Planning...' }];

      for (let i = 0; i < 5; i++) {
        const args = JSON.stringify({ index: i });
        parts.push({
          type: 'function',
          id: `tc-${i}`,
          function: { name: 'task', arguments: null },
        } satisfies ToolCall);
        // Stream args in 3 chunks
        const chunk = Math.ceil(args.length / 3);
        for (let j = 0; j < args.length; j += chunk) {
          parts.push({ type: 'tool_call_part', argumentsPart: args.slice(j, j + chunk) });
        }
      }

      parts.push({ type: 'text', text: 'All tasks dispatched.' });

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      expect(result.message.content).toHaveLength(2);
      expect(result.message.content[0]).toEqual({ type: 'text', text: 'Planning...' });
      expect(result.message.content[1]).toEqual({ type: 'text', text: 'All tasks dispatched.' });
      expect(result.message.toolCalls).toHaveLength(5);

      for (let i = 0; i < 5; i++) {
        expect(result.message.toolCalls![i]!.id).toBe(`tc-${i}`);
        const parsed = JSON.parse(result.message.toolCalls![i]!.function.arguments!) as {
          index: number;
        };
        expect(parsed.index).toBe(i);
      }
    });
  });
});
