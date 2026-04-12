import { describe, expect, it } from 'vitest';

import { generate } from '../../src/generate.js';
import type { StreamedMessagePart } from '../../src/message.js';
import { extractText } from '../../src/message.js';
import { MockChatProvider } from '../../src/mock-provider.js';

// ── E2E: extreme streaming scenarios ──────────────────────────────────
//
// These tests exercise the stream merging pipeline at workloads an order
// of magnitude larger than what day-to-day usage produces. They catch:
//
//   - quadratic-time merges (e.g. accidentally rebuilding the whole text
//     on every delta),
//   - O(n) lookup regressions in parallel-tool-call routing,
//   - memory leaks in the pending-part accumulator,
//   - tool-call argument cross-contamination when 100+ parallel calls
//     are routed by `_streamIndex`.

describe('e2e: extreme streaming scenarios', () => {
  describe('TextPart delta merging at scale', () => {
    it('10000 TextPart deltas merge into a single content[0]', async () => {
      const count = 10000;
      const parts: StreamedMessagePart[] = [];
      for (let i = 0; i < count; i++) {
        parts.push({ type: 'text', text: 'a' });
      }

      const provider = new MockChatProvider(parts);
      const t0 = Date.now();
      const result = await generate(provider, '', [], []);
      const elapsed = Date.now() - t0;

      // Single merged text part.
      expect(result.message.content).toHaveLength(1);
      expect(result.message.content[0]!.type).toBe('text');

      const text = extractText(result.message);
      expect(text.length).toBe(count);
      // Every character is 'a'.
      expect(text).toBe('a'.repeat(count));

      // This should complete quickly — a quadratic merge would turn this
      // into tens of seconds. Give plenty of slack for CI (5s).
      expect(elapsed).toBeLessThan(5000);
    });

    it('5000 TextPart deltas interleaved with ThinkParts produce exactly two merged blocks each', async () => {
      // Alternating blocks: [text-batch, think-batch, text-batch, think-batch].
      const parts: StreamedMessagePart[] = [];
      for (let i = 0; i < 2500; i++) parts.push({ type: 'text', text: 'x' });
      for (let i = 0; i < 2500; i++) parts.push({ type: 'think', think: 'y' });
      for (let i = 0; i < 2500; i++) parts.push({ type: 'text', text: 'x' });
      for (let i = 0; i < 2500; i++) parts.push({ type: 'think', think: 'y' });

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      // 4 merged blocks (2 text, 2 think) appearing in order.
      expect(result.message.content).toHaveLength(4);
      expect(result.message.content[0]!.type).toBe('text');
      expect(result.message.content[1]!.type).toBe('think');
      expect(result.message.content[2]!.type).toBe('text');
      expect(result.message.content[3]!.type).toBe('think');

      // Each block carries exactly 2500 characters.
      const c0 = result.message.content[0]!;
      const c2 = result.message.content[2]!;
      expect(c0.type === 'text' && c0.text.length === 2500).toBe(true);
      expect(c2.type === 'text' && c2.text.length === 2500).toBe(true);

      const c1 = result.message.content[1]!;
      const c3 = result.message.content[3]!;
      expect(c1.type === 'think' && c1.think.length === 2500).toBe(true);
      expect(c3.type === 'think' && c3.think.length === 2500).toBe(true);
    });
  });

  describe('parallel tool call streaming at scale', () => {
    it('100 parallel tool calls with interleaved arg deltas route to the correct call', async () => {
      const n = 100;
      const parts: StreamedMessagePart[] = [];

      // Headers for 100 tool calls.
      for (let i = 0; i < n; i++) {
        parts.push({
          type: 'function',
          id: `tc_${i}`,
          function: { name: 'f', arguments: null },
          _streamIndex: i,
        });
      }

      // Interleaved arg deltas: three passes (open → body → close),
      // each pass walks 0..n-1, so deltas for tc_0 are at positions
      // 0, n, 2n within the interleaved arg stream.
      for (let i = 0; i < n; i++) {
        parts.push({ type: 'tool_call_part', argumentsPart: '{"i":', index: i });
      }
      for (let i = 0; i < n; i++) {
        parts.push({ type: 'tool_call_part', argumentsPart: String(i), index: i });
      }
      for (let i = 0; i < n; i++) {
        parts.push({ type: 'tool_call_part', argumentsPart: '}', index: i });
      }

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      // 100 tool calls emitted, in stream order, with fully-assembled
      // arguments and NO cross-contamination.
      expect(result.message.toolCalls).toHaveLength(n);
      for (let i = 0; i < n; i++) {
        const tc = result.message.toolCalls[i]!;
        expect(tc.id).toBe(`tc_${i}`);
        expect(tc.function.name).toBe('f');
        expect(tc.function.arguments).toBe(`{"i":${i}}`);
        // _streamIndex must be stripped from the stored ToolCall.
        expect(tc).not.toHaveProperty('_streamIndex');
      }
    });

    it('one tool call with 10,000 argument deltas assembles a 1MB+ argument string', async () => {
      // 10,000 deltas × 120-char chunk = ~1.2MB of tool arguments.
      const chunk = 'x'.repeat(120);
      const parts: StreamedMessagePart[] = [
        {
          type: 'function',
          id: 'tc_big',
          function: { name: 'writeBlob', arguments: '{"blob":"' },
          _streamIndex: 0,
        },
      ];
      for (let i = 0; i < 10000; i++) {
        parts.push({ type: 'tool_call_part', argumentsPart: chunk, index: 0 });
      }
      parts.push({ type: 'tool_call_part', argumentsPart: '"}', index: 0 });

      const provider = new MockChatProvider(parts);
      const t0 = Date.now();
      const result = await generate(provider, '', [], []);
      const elapsed = Date.now() - t0;

      expect(result.message.toolCalls).toHaveLength(1);
      const args = result.message.toolCalls[0]!.function.arguments;
      expect(args).not.toBeNull();
      expect(args!.length).toBeGreaterThan(1_200_000);
      // The assembled string is valid JSON.
      const parsed = JSON.parse(args!) as { blob: string };
      expect(parsed.blob.length).toBe(120 * 10000);
      expect(parsed.blob[0]).toBe('x');

      // Plenty of slack — this should complete well under a few seconds.
      expect(elapsed).toBeLessThan(5000);
    });

    it('100 interleaved parallel tool calls where the first delta batch arrives in reverse order', async () => {
      // Reversed first batch hits the "unknown index → fall through" path
      // before all headers have been seen. We specifically want to test
      // that AFTER all headers are flushed, the remaining deltas still
      // route correctly.
      const n = 100;
      const parts: StreamedMessagePart[] = [];

      for (let i = 0; i < n; i++) {
        parts.push({
          type: 'function',
          id: `tc_${i}`,
          function: { name: 'f', arguments: null },
          _streamIndex: i,
        });
      }
      // Deltas in REVERSE order, each carries the full JSON at once.
      for (let i = n - 1; i >= 0; i--) {
        parts.push({ type: 'tool_call_part', argumentsPart: `{"idx":${i}}`, index: i });
      }

      const provider = new MockChatProvider(parts);
      const result = await generate(provider, '', [], []);

      expect(result.message.toolCalls).toHaveLength(n);
      for (let i = 0; i < n; i++) {
        const tc = result.message.toolCalls[i]!;
        // Assembled args preserve the per-call routing contract.
        expect(tc.function.arguments).toBe(`{"idx":${i}}`);
      }
    });
  });
});
