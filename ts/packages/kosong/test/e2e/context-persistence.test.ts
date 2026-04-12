import * as node_fs from 'node:fs';
import * as node_os from 'node:os';
import * as node_path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { JsonlLinearStorage, LinearContext } from '../../src/context.js';
import type { ContentPart, Message, ToolCall } from '../../src/message.js';

// ── Helpers ─���────────────────────────────────────────────────────────

function assistantMsg(content: ContentPart[], toolCalls?: ToolCall[]): Message {
  const msg: Message = { role: 'assistant', content, toolCalls: toolCalls ?? [] };
  return msg;
}

function toolMsg(toolCallId: string, output: string): Message {
  return {
    role: 'tool',
    content: [{ type: 'text', text: output }],
    toolCallId,
    toolCalls: [],
  };
}

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('e2e: context persistence', () => {
  let tmpFile: string | undefined;

  afterEach(async () => {
    if (tmpFile !== undefined) {
      try {
        await node_fs.promises.unlink(tmpFile);
      } catch {
        // ignore
      }
      tmpFile = undefined;
    }
  });

  describe('JSONL round-trip with various ContentPart types', () => {
    it('round-trips Message with ToolCall', async () => {
      tmpFile = node_path.join(node_os.tmpdir(), `kosong-ctx-toolcall-${Date.now()}.jsonl`);

      const storage = new JsonlLinearStorage(tmpFile);
      const ctx = new LinearContext(storage);

      const tc: ToolCall = {
        type: 'function',
        id: 'tc-1',
        function: { name: 'search', arguments: '{"query":"vitest"}' },
      };

      await ctx.addMessage(assistantMsg([{ type: 'text', text: 'Let me search.' }], [tc]));
      await ctx.addMessage(toolMsg('tc-1', 'Found vitest docs.'));

      // Restore into fresh context
      const ctx2 = new LinearContext(new JsonlLinearStorage(tmpFile));
      await ctx2.restore();

      expect(ctx2.history).toHaveLength(2);

      const restoredAssistant = ctx2.history[0]!;
      expect(restoredAssistant.role).toBe('assistant');
      expect(restoredAssistant.toolCalls).toHaveLength(1);
      expect(restoredAssistant.toolCalls![0]!.id).toBe('tc-1');
      expect(restoredAssistant.toolCalls![0]!.function.name).toBe('search');
      expect(restoredAssistant.toolCalls![0]!.function.arguments).toBe('{"query":"vitest"}');

      const restoredTool = ctx2.history[1]!;
      expect(restoredTool.role).toBe('tool');
      expect(restoredTool.toolCallId).toBe('tc-1');
    });

    it('round-trips Message with ThinkPart including encrypted', async () => {
      tmpFile = node_path.join(node_os.tmpdir(), `kosong-ctx-think-${Date.now()}.jsonl`);

      const storage = new JsonlLinearStorage(tmpFile);
      const ctx = new LinearContext(storage);

      await ctx.addMessage(
        assistantMsg([
          { type: 'think', think: 'Deep thinking...', encrypted: 'sig-xyz' },
          { type: 'text', text: 'The answer.' },
        ]),
      );

      const ctx2 = new LinearContext(new JsonlLinearStorage(tmpFile));
      await ctx2.restore();

      expect(ctx2.history).toHaveLength(1);
      const parts = ctx2.history[0]!.content;
      expect(parts).toHaveLength(2);

      const thinkPart = parts[0]!;
      expect(thinkPart.type).toBe('think');
      if (thinkPart.type === 'think') {
        expect(thinkPart.think).toBe('Deep thinking...');
        expect(thinkPart.encrypted).toBe('sig-xyz');
      }

      const textPart = parts[1]!;
      expect(textPart.type).toBe('text');
      if (textPart.type === 'text') {
        expect(textPart.text).toBe('The answer.');
      }
    });

    it('round-trips Message with ImageURLPart', async () => {
      tmpFile = node_path.join(node_os.tmpdir(), `kosong-ctx-image-${Date.now()}.jsonl`);

      const storage = new JsonlLinearStorage(tmpFile);
      const ctx = new LinearContext(storage);

      await ctx.addMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image_url', imageUrl: { url: 'https://example.com/img.png', id: 'img-1' } },
        ],
        toolCalls: [],
      });

      const ctx2 = new LinearContext(new JsonlLinearStorage(tmpFile));
      await ctx2.restore();

      expect(ctx2.history).toHaveLength(1);
      const parts = ctx2.history[0]!.content;
      expect(parts).toHaveLength(2);
      expect(parts[1]!.type).toBe('image_url');
      if (parts[1]!.type === 'image_url') {
        expect(parts[1]!.imageUrl.url).toBe('https://example.com/img.png');
        expect(parts[1]!.imageUrl.id).toBe('img-1');
      }
    });

    it('round-trips complex multi-message conversation', async () => {
      tmpFile = node_path.join(node_os.tmpdir(), `kosong-ctx-complex-${Date.now()}.jsonl`);

      const storage = new JsonlLinearStorage(tmpFile);
      const ctx = new LinearContext(storage);

      // system
      await ctx.addMessage({
        role: 'system',
        content: [{ type: 'text', text: 'You are a helpful assistant.' }],
        toolCalls: [],
      });

      // user with image
      await ctx.addMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this.' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,abc123' } },
        ],
        toolCalls: [],
      });

      // assistant with think + text + tool call
      const tc: ToolCall = {
        type: 'function',
        id: 'tc-analyze',
        function: { name: 'analyze_image', arguments: '{"detail":"high"}' },
      };
      await ctx.addMessage(
        assistantMsg(
          [
            { type: 'think', think: 'This looks like a chart.', encrypted: 'sig-enc' },
            { type: 'text', text: 'Analyzing...' },
          ],
          [tc],
        ),
      );

      // tool result
      await ctx.addMessage(toolMsg('tc-analyze', 'Bar chart showing Q4 revenue.'));

      // final assistant
      await ctx.addMessage(assistantMsg([{ type: 'text', text: 'The image shows a bar chart.' }]));

      // Restore
      const ctx2 = new LinearContext(new JsonlLinearStorage(tmpFile));
      await ctx2.restore();

      expect(ctx2.history).toHaveLength(5);
      expect(ctx2.history[0]!.role).toBe('system');
      expect(ctx2.history[1]!.role).toBe('user');
      expect(ctx2.history[2]!.role).toBe('assistant');
      expect(ctx2.history[3]!.role).toBe('tool');
      expect(ctx2.history[4]!.role).toBe('assistant');

      // Verify deep content integrity
      const assistantContent = ctx2.history[2]!;
      expect(assistantContent.content).toHaveLength(2);
      expect(assistantContent.content[0]!.type).toBe('think');
      expect(assistantContent.toolCalls).toHaveLength(1);
      expect(assistantContent.toolCalls![0]!.function.name).toBe('analyze_image');
    });
  });

  describe('concurrent writes to JSONL', () => {
    it('concurrent 10 addMessage calls -> all restored', async () => {
      tmpFile = node_path.join(node_os.tmpdir(), `kosong-ctx-concurrent-${Date.now()}.jsonl`);

      const storage = new JsonlLinearStorage(tmpFile);
      const ctx = new LinearContext(storage);

      const count = 10;
      const promises: Promise<void>[] = [];
      for (let i = 0; i < count; i++) {
        promises.push(ctx.addMessage(userMsg(`message-${i}`)));
      }
      await Promise.all(promises);

      // Restore from file (bypass in-memory history)
      const ctx2 = new LinearContext(new JsonlLinearStorage(tmpFile));
      await ctx2.restore();

      // All 10 messages should be persisted
      expect(ctx2.history).toHaveLength(count);

      // Verify all message texts are present (order may vary due to concurrency)
      const texts = new Set(
        ctx2.history.map((m) => {
          const firstPart = m.content[0];
          return firstPart?.type === 'text' ? firstPart.text : '';
        }),
      );
      for (let i = 0; i < count; i++) {
        expect(texts.has(`message-${i}`)).toBe(true);
      }
    });

    it('sequential writes maintain order', async () => {
      tmpFile = node_path.join(node_os.tmpdir(), `kosong-ctx-order-${Date.now()}.jsonl`);

      const storage = new JsonlLinearStorage(tmpFile);
      const ctx = new LinearContext(storage);

      for (let i = 0; i < 20; i++) {
        await ctx.addMessage(userMsg(`msg-${i}`));
      }

      const ctx2 = new LinearContext(new JsonlLinearStorage(tmpFile));
      await ctx2.restore();

      expect(ctx2.history).toHaveLength(20);
      for (let i = 0; i < 20; i++) {
        const part = ctx2.history[i]!.content[0]!;
        if (part.type === 'text') {
          expect(part.text).toBe(`msg-${i}`);
        }
      }
    });
  });

  describe('edge cases', () => {
    it('empty message content round-trips', async () => {
      tmpFile = node_path.join(node_os.tmpdir(), `kosong-ctx-empty-${Date.now()}.jsonl`);

      const storage = new JsonlLinearStorage(tmpFile);
      const ctx = new LinearContext(storage);

      await ctx.addMessage({ role: 'assistant', content: [], toolCalls: [] });

      const ctx2 = new LinearContext(new JsonlLinearStorage(tmpFile));
      await ctx2.restore();

      expect(ctx2.history).toHaveLength(1);
      expect(ctx2.history[0]!.content).toEqual([]);
    });

    it('message with unicode content round-trips', async () => {
      tmpFile = node_path.join(node_os.tmpdir(), `kosong-ctx-unicode-${Date.now()}.jsonl`);

      const storage = new JsonlLinearStorage(tmpFile);
      const ctx = new LinearContext(storage);

      await ctx.addMessage(userMsg('\u4F60\u597D\u4E16\u754C \uD83D\uDE80 \u00E9\u00E0\u00FC'));

      const ctx2 = new LinearContext(new JsonlLinearStorage(tmpFile));
      await ctx2.restore();

      const part = ctx2.history[0]!.content[0]!;
      if (part.type === 'text') {
        expect(part.text).toBe('\u4F60\u597D\u4E16\u754C \uD83D\uDE80 \u00E9\u00E0\u00FC');
      }
    });
  });
});
