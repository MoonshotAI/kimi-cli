import * as node_fs from 'node:fs';
import * as node_os from 'node:os';
import * as node_path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { JsonlLinearStorage, LinearContext, MemoryLinearStorage } from '../src/context.js';
import { setLogger, type Logger } from '../src/logger.js';
import { createAssistantMessage, createUserMessage } from '../src/message.js';
import type { Message } from '../src/message.js';

function userMsg(text: string): Message {
  return createUserMessage(text);
}

describe('LinearContext with MemoryLinearStorage', () => {
  it('adds messages and returns correct history', async () => {
    const storage = new MemoryLinearStorage();
    const ctx = new LinearContext(storage);

    expect(ctx.history).toEqual([]);

    await ctx.addMessage(userMsg('hello'));
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0]!.content[0]!).toEqual({ type: 'text', text: 'hello' });

    await ctx.addMessage(userMsg('world'));
    expect(ctx.history).toHaveLength(2);
    expect(ctx.history[1]!.content[0]!).toEqual({ type: 'text', text: 'world' });
  });

  it('restore loads messages from storage', async () => {
    const storage = new MemoryLinearStorage();
    const ctx1 = new LinearContext(storage);

    await ctx1.addMessage(userMsg('msg1'));
    await ctx1.addMessage(userMsg('msg2'));

    const ctx2 = new LinearContext(storage);
    expect(ctx2.history).toEqual([]);

    const restored = await ctx2.restore();
    expect(restored).toBe(true);
    expect(ctx2.history).toHaveLength(2);
  });

  it('markTokenCount tracks token count in memory', async () => {
    const ctx = new LinearContext(new MemoryLinearStorage());
    expect(ctx.tokenCount).toBe(0);
    await ctx.markTokenCount(42);
    expect(ctx.tokenCount).toBe(42);
    await ctx.markTokenCount(100);
    expect(ctx.tokenCount).toBe(100);
  });

  it('clear empties history and storage', async () => {
    const storage = new MemoryLinearStorage();
    const ctx = new LinearContext(storage);

    await ctx.addMessage(userMsg('msg'));
    expect(ctx.history).toHaveLength(1);

    await ctx.clear();
    expect(ctx.history).toEqual([]);

    // Restoring from cleared storage should yield nothing.
    const restored = await ctx.restore();
    expect(restored).toBe(false);
    expect(ctx.history).toEqual([]);
  });
});

describe('LinearContext with JsonlLinearStorage', () => {
  let tmpFile: string | undefined;

  afterEach(async () => {
    setLogger(null);
    if (tmpFile !== undefined) {
      try {
        await node_fs.promises.unlink(tmpFile);
      } catch {
        // ignore
      }
      tmpFile = undefined;
    }
  });

  it('persists and restores messages from JSONL file', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-${Date.now()}.jsonl`);

    const storage = new JsonlLinearStorage(tmpFile);
    const ctx1 = new LinearContext(storage);

    await ctx1.addMessage(userMsg('line1'));
    await ctx1.addMessage(userMsg('line2'));

    // Read the file and verify JSONL format.
    const raw = await node_fs.promises.readFile(tmpFile, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ role: 'user' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ role: 'user' });

    // Restore into a fresh context.
    const ctx2 = new LinearContext(new JsonlLinearStorage(tmpFile));
    const restored = await ctx2.restore();
    expect(restored).toBe(true);
    expect(ctx2.history).toHaveLength(2);
    expect(ctx2.history[0]!.content[0]!).toEqual({ type: 'text', text: 'line1' });
    expect(ctx2.history[1]!.content[0]!).toEqual({ type: 'text', text: 'line2' });
  });

  it('restore returns false when file does not exist', async () => {
    const storage = new JsonlLinearStorage('/tmp/nonexistent-kosong-test.jsonl');
    const ctx = new LinearContext(storage);
    const restored = await ctx.restore();
    expect(restored).toBe(false);
    expect(ctx.history).toEqual([]);
  });

  it('concurrent addMessage() preserves all writes (N=10)', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-concurrent-${Date.now()}.jsonl`);

    const storage = new JsonlLinearStorage(tmpFile);
    const ctx = new LinearContext(storage);

    // Fire off 10 concurrent writes.
    const N = 10;
    const writes = Array.from({ length: N }, (_, i) => ctx.addMessage(userMsg(`msg-${i}`)));
    await Promise.all(writes);

    // All 10 messages must be in the in-memory history.
    expect(ctx.history).toHaveLength(N);

    // The file must contain exactly 10 lines, each a valid JSON message.
    const raw = await node_fs.promises.readFile(tmpFile, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(N);

    // Every line must parse to a user message with text `msg-i` for some i in [0, N).
    const seen = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as Message;
      expect(parsed.role).toBe('user');
      const first = parsed.content[0];
      expect(first).toBeDefined();
      if (first && first.type === 'text') {
        seen.add(first.text);
      }
    }
    // All N distinct texts must be present (ordering may vary).
    for (let i = 0; i < N; i++) {
      expect(seen.has(`msg-${i}`)).toBe(true);
    }

    // restore() into a fresh context must see all 10.
    const ctx2 = new LinearContext(new JsonlLinearStorage(tmpFile));
    const restored = await ctx2.restore();
    expect(restored).toBe(true);
    expect(ctx2.history).toHaveLength(N);
  });

  it('markTokenCount persists token count and survives restore', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-usage-${Date.now()}.jsonl`);

    const storage = new JsonlLinearStorage(tmpFile);
    const ctx = new LinearContext(storage);

    await ctx.addMessage(userMsg('hi'));
    await ctx.markTokenCount(150);
    await ctx.addMessage(createAssistantMessage([{ type: 'text', text: 'hello' }]));
    await ctx.markTokenCount(200);

    expect(ctx.tokenCount).toBe(200);

    const storage2 = new JsonlLinearStorage(tmpFile);
    const ctx2 = new LinearContext(storage2);
    const restored = await ctx2.restore();
    expect(restored).toBe(true);

    expect(ctx2.tokenCount).toBe(200);
    // _usage rows must not show up as history messages.
    expect(ctx2.history).toHaveLength(2);
    expect(ctx2.history[0]!.role).toBe('user');
    expect(ctx2.history[1]!.role).toBe('assistant');
  });

  it('restore of legacy file without _usage rows yields tokenCount 0', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-legacy-${Date.now()}.jsonl`);

    // Write a legacy file that has no _usage rows.
    const legacy: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'legacy' }],
      toolCalls: [],
    };
    await node_fs.promises.writeFile(tmpFile, JSON.stringify(legacy) + '\n', 'utf-8');

    const ctx = new LinearContext(new JsonlLinearStorage(tmpFile));
    const restored = await ctx.restore();
    expect(restored).toBe(true);
    expect(ctx.history).toHaveLength(1);
    expect(ctx.tokenCount).toBe(0);
  });

  it('clear removes the file', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-clear-${Date.now()}.jsonl`);

    const storage = new JsonlLinearStorage(tmpFile);
    const ctx = new LinearContext(storage);

    await ctx.addMessage(userMsg('msg'));
    expect(node_fs.existsSync(tmpFile)).toBe(true);

    await ctx.clear();
    expect(ctx.history).toEqual([]);
    expect(node_fs.existsSync(tmpFile)).toBe(false);
  });

  it('refreshHistory reloads messages written by another LinearContext instance', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-refresh-${Date.now()}.jsonl`);

    const ctxA = new LinearContext(new JsonlLinearStorage(tmpFile));
    const ctxB = new LinearContext(new JsonlLinearStorage(tmpFile));

    await ctxA.addMessage(userMsg('from-a'));

    expect(ctxB.history).toEqual([]);

    await ctxB.refreshHistory();

    expect(ctxB.history).toHaveLength(1);
    expect(ctxB.history[0]!.content[0]!).toEqual({ type: 'text', text: 'from-a' });
  });

  it('history returns a defensive snapshot', async () => {
    const ctx = new LinearContext(new MemoryLinearStorage());

    await ctx.addMessage(userMsg('safe'));

    const history = ctx.history;
    history.push(userMsg('mutated'));

    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0]!.content[0]!).toEqual({ type: 'text', text: 'safe' });
  });

  it('restore skips corrupted JSONL lines and warns', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-corrupted-${Date.now()}.jsonl`);

    const rows = Array.from({ length: 10 }, (_, i) => JSON.stringify(userMsg(`before-${i}`)));
    rows.push('{"role":"user","content":[');
    rows.push(...Array.from({ length: 10 }, (_, i) => JSON.stringify(userMsg(`after-${i}`))));
    await node_fs.promises.writeFile(tmpFile, rows.join('\n') + '\n', 'utf-8');

    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger: Logger = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (message, context) => {
        warnings.push(context !== undefined ? { message, context } : { message });
      },
      error: () => {},
    };
    setLogger(logger);

    const storage = new JsonlLinearStorage(tmpFile);
    const restored = await storage.restore();

    expect(restored.tokenCount).toBe(0);
    expect(restored.messages).toHaveLength(20);
    expect(restored.messages[0]!.content[0]!).toEqual({ type: 'text', text: 'before-0' });
    expect(restored.messages[19]!.content[0]!).toEqual({ type: 'text', text: 'after-9' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('Failed to parse JSONL line');
  });
});

describe('JsonlLinearStorage Python compatibility', () => {
  let tmpFile: string | undefined;

  afterEach(async () => {
    setLogger(null);
    if (tmpFile !== undefined) {
      try {
        await node_fs.promises.unlink(tmpFile);
      } catch {
        // ignore
      }
      tmpFile = undefined;
    }
  });

  it('reads Python snake_case JSONL and normalizes restored messages', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-python-${Date.now()}.jsonl`);

    const fixture = [
      '{"role": "user", "content": "hello"}',
      '{"role": "assistant", "content": [{"type": "text", "text": "hi"}], "tool_calls": [{"type": "function", "id": "c1", "function": {"name": "foo", "arguments": "{}"}}]}',
      '{"role": "tool", "content": "result", "tool_call_id": "c1"}',
    ].join('\n');
    await node_fs.promises.writeFile(tmpFile, fixture + '\n', 'utf-8');

    const restored = await new JsonlLinearStorage(tmpFile).restore();

    expect(restored.messages).toHaveLength(3);
    expect(restored.messages[0]!.role).toBe('user');
    expect(restored.messages[0]!.content).toEqual([{ type: 'text', text: 'hello' }]);

    expect(restored.messages[1]!.role).toBe('assistant');
    expect(restored.messages[1]!.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(restored.messages[1]!.toolCalls).toHaveLength(1);
    expect(restored.messages[1]!.toolCalls[0]!.id).toBe('c1');
    expect(restored.messages[1]!.toolCalls[0]!.function.name).toBe('foo');

    expect(restored.messages[2]!.role).toBe('tool');
    expect(restored.messages[2]!.toolCallId).toBe('c1');
    expect(restored.messages[2]!.content).toEqual([{ type: 'text', text: 'result' }]);
  });

  it('normalizes Python snake_case media parts', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-python-media-${Date.now()}.jsonl`);

    const fixture = [
      '{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.com/image.png","id":"img-1"}},{"type":"audio_url","audio_url":{"url":"https://example.com/audio.mp3","id":"aud-1"}},{"type":"video_url","video_url":{"url":"ms://vid-1","id":"vid-1"}}]}',
    ].join('\n');
    await node_fs.promises.writeFile(tmpFile, fixture + '\n', 'utf-8');

    const restored = await new JsonlLinearStorage(tmpFile).restore();

    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0]!.content).toEqual([
      { type: 'image_url', imageUrl: { url: 'https://example.com/image.png', id: 'img-1' } },
      { type: 'audio_url', audioUrl: { url: 'https://example.com/audio.mp3', id: 'aud-1' } },
      { type: 'video_url', videoUrl: { url: 'ms://vid-1', id: 'vid-1' } },
    ]);
  });

  it('maps Python null tool_calls to an empty toolCalls array', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-python-null-${Date.now()}.jsonl`);

    const fixture =
      '{"role": "assistant", "content": [{"type": "text", "text": "hi"}], "tool_calls": null}\n';
    await node_fs.promises.writeFile(tmpFile, fixture, 'utf-8');

    const restored = await new JsonlLinearStorage(tmpFile).restore();

    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0]!.role).toBe('assistant');
    expect(restored.messages[0]!.toolCalls).toEqual([]);
  });

  it('restores mixed Python snake_case and TS camelCase JSONL lines together', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-python-mixed-${Date.now()}.jsonl`);

    const tsMessage: Message = {
      role: 'tool',
      content: [{ type: 'text', text: 'done' }],
      toolCalls: [],
      toolCallId: 'c2',
    };
    const fixture = [
      '{"role": "assistant", "content": "hello", "tool_calls": [{"type": "function", "id": "c2", "function": {"name": "bar", "arguments": "{\\"x\\":1}"}}]}',
      JSON.stringify(tsMessage),
    ].join('\n');
    await node_fs.promises.writeFile(tmpFile, fixture + '\n', 'utf-8');

    const restored = await new JsonlLinearStorage(tmpFile).restore();

    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[0]!.role).toBe('assistant');
    expect(restored.messages[0]!.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(restored.messages[0]!.toolCalls).toHaveLength(1);
    expect(restored.messages[0]!.toolCalls[0]!.id).toBe('c2');
    expect(restored.messages[0]!.toolCalls[0]!.function.name).toBe('bar');

    expect(restored.messages[1]!).toEqual(tsMessage);
  });

  it('skips semantically invalid rows and warns during normalization', async () => {
    tmpFile = node_path.join(node_os.tmpdir(), `kosong-test-python-invalid-${Date.now()}.jsonl`);

    const fixture = [
      '{"role":"user","content":[{"type":"image_url","image_url":{"id":"img-missing-url"}}]}',
      '{"role":"assistant","content":"ok"}',
    ].join('\n');
    await node_fs.promises.writeFile(tmpFile, fixture + '\n', 'utf-8');

    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger: Logger = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (message, context) => {
        warnings.push(context !== undefined ? { message, context } : { message });
      },
      error: () => {},
    };
    setLogger(logger);

    const restored = await new JsonlLinearStorage(tmpFile).restore();

    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0]!.role).toBe('assistant');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('Failed to normalize JSONL line');
  });
});
