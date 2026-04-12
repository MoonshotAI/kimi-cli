import * as node_fs from 'node:fs';
import * as node_os from 'node:os';
import * as node_path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { JsonlLinearStorage, LinearContext } from '../../src/context.js';
import { setLogger, type Logger } from '../../src/logger.js';
import type { Message } from '../../src/message.js';

const FIXTURE_PATH = node_path.resolve(
  import.meta.dirname,
  'fixtures',
  'python-jsonl-compat.jsonl',
);

describe('e2e: JSONL Python compatibility', () => {
  const tmpFiles: string[] = [];

  afterEach(async () => {
    setLogger(null);
    while (tmpFiles.length > 0) {
      const file = tmpFiles.pop();
      if (file === undefined) continue;
      try {
        await node_fs.promises.unlink(file);
      } catch {
        // ignore
      }
    }
  });

  function makeTempFile(prefix: string): string {
    const file = node_path.join(
      node_os.tmpdir(),
      `${prefix}-${Date.now()}-${tmpFiles.length}.jsonl`,
    );
    tmpFiles.push(file);
    return file;
  }

  function captureWarnings(): Array<{ message: string; context?: Record<string, unknown> }> {
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
    return warnings;
  }

  it('restores Python snake_case JSONL with text, tool_calls, think, media, and skips bad rows', async () => {
    const warnings = captureWarnings();
    const storage = new JsonlLinearStorage(FIXTURE_PATH);
    const restored = await storage.restore();

    expect(restored.messages).toHaveLength(4);
    expect(restored.tokenCount).toBe(0);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.message.includes('Failed to parse JSONL line'))).toBe(true);
    expect(warnings.some((w) => w.message.includes('Failed to normalize JSONL line'))).toBe(true);

    const [userText, assistant, toolResult, assistantTail] = restored.messages;

    expect(userText).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello from python' }],
      toolCalls: [],
    });

    expect(assistant!.role).toBe('assistant');
    expect(assistant!.toolCalls).toHaveLength(1);
    expect(assistant!.toolCalls[0]!.id).toBe('call-1');
    expect(assistant!.toolCalls[0]!.function.name).toBe('describe_media');
    expect(assistant!.toolCalls[0]!.function.arguments).toBe('{"detail":"full"}');
    expect(assistant!.content).toEqual([
      { type: 'think', think: 'Let me reason about the request.', encrypted: 'sig-123' },
      { type: 'text', text: 'I will inspect the media.' },
      { type: 'image_url', imageUrl: { url: 'https://example.com/image.png', id: 'img-1' } },
      { type: 'audio_url', audioUrl: { url: 'https://example.com/audio.mp3', id: 'aud-1' } },
      { type: 'video_url', videoUrl: { url: 'ms://video-1', id: 'vid-1' } },
    ]);

    expect(toolResult).toEqual({
      role: 'tool',
      content: [{ type: 'text', text: '{"label":"sunset"}' }],
      toolCalls: [],
      toolCallId: 'call-1',
    });

    expect(assistantTail).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'TS-friendly response' }],
      toolCalls: [],
    });
  });

  it('writes canonical TS JSONL that round-trips after restoring the Python fixture', async () => {
    const source = await new JsonlLinearStorage(FIXTURE_PATH).restore();
    const outputPath = makeTempFile('kosong-jsonl-ts-output');
    const outputContext = new LinearContext(new JsonlLinearStorage(outputPath));

    for (const message of source.messages) {
      await outputContext.addMessage(message);
    }

    const raw = await node_fs.promises.readFile(outputPath, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(source.messages.length);
    expect(raw).not.toContain('"tool_calls"');
    expect(raw).not.toContain('"tool_call_id"');
    expect(raw).toContain('"toolCalls"');
    expect(raw).toContain('"imageUrl"');
    expect(raw).toContain('"audioUrl"');
    expect(raw).toContain('"videoUrl"');

    const parsed = lines.map((line) => JSON.parse(line) as Message);
    expect(parsed[0]!).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello from python' }],
      toolCalls: [],
    });
    expect(parsed[1]!.content[2]).toEqual({
      type: 'image_url',
      imageUrl: { url: 'https://example.com/image.png', id: 'img-1' },
    });
    expect(parsed[1]!.toolCalls).toHaveLength(1);
    expect(parsed[2]!).toEqual({
      role: 'tool',
      content: [{ type: 'text', text: '{"label":"sunset"}' }],
      toolCalls: [],
      toolCallId: 'call-1',
    });
    expect(parsed[3]!).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'TS-friendly response' }],
      toolCalls: [],
    });

    const roundTripped = await new JsonlLinearStorage(outputPath).restore();
    expect(roundTripped).toEqual(source);
  });
});
