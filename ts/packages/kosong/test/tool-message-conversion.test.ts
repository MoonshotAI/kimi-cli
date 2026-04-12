import { describe, expect, test } from 'vitest';

import type { Message } from '../src/message.js';
import { convertToolMessageContent } from '../src/providers/openai-common.js';

describe('convertToolMessageContent', () => {
  test('extract_text merges multiple text parts into a single string', () => {
    const msg: Message = {
      role: 'tool',
      content: [
        { type: 'text', text: 'Result: ' },
        { type: 'text', text: '42' },
      ],
      toolCalls: [],
      toolCallId: 'tc_001',
    };
    const result = convertToolMessageContent(msg, 'extract_text');
    expect(typeof result).toBe('string');
    expect(result).toBe('Result: 42');
  });

  test('extract_text returns empty string for empty content', () => {
    const msg: Message = {
      role: 'tool',
      content: [],
      toolCalls: [],
      toolCallId: 'tc_002',
    };
    const result = convertToolMessageContent(msg, 'extract_text');
    expect(result).toBe('');
  });

  test('extract_text skips non-text content parts', () => {
    const msg: Message = {
      role: 'tool',
      content: [
        { type: 'text', text: 'Before' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,xxx' } },
        { type: 'text', text: 'After' },
      ],
      toolCalls: [],
      toolCallId: 'tc_003',
    };
    const result = convertToolMessageContent(msg, 'extract_text');
    expect(result).toBe('BeforeAfter');
  });

  test('null conversion returns an array of OpenAI content parts', () => {
    const msg: Message = {
      role: 'tool',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ],
      toolCalls: [],
      toolCallId: 'tc_004',
    };
    const result = convertToolMessageContent(msg, null);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    if (Array.isArray(result)) {
      expect(result[0]).toMatchObject({ type: 'text', text: 'hello' });
      expect(result[1]).toMatchObject({ type: 'text', text: 'world' });
    }
  });

  test('null conversion filters out ThinkPart (returns null from convertContentPart)', () => {
    const msg: Message = {
      role: 'tool',
      content: [
        { type: 'text', text: 'visible' },
        { type: 'think', think: 'hidden reasoning' },
      ],
      toolCalls: [],
      toolCallId: 'tc_005',
    };
    const result = convertToolMessageContent(msg, null);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ type: 'text', text: 'visible' });
    }
  });
});
