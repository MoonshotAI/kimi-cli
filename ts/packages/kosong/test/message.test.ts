import { describe, expect, it } from 'vitest';

import type {
  AudioURLPart,
  ContentPart,
  ImageURLPart,
  Message,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolCallPart,
  VideoURLPart,
} from '../src/message.js';
import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  getTextContent,
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
} from '../src/message.js';

// ── Message creation helpers ───────────────────────────────────────────

describe('createUserMessage', () => {
  it('creates a user message with single text part', () => {
    const msg = createUserMessage('hello');
    expect(msg.role).toBe('user');
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toEqual({ type: 'text', text: 'hello' });
  });
});

describe('createAssistantMessage', () => {
  it('creates an assistant message from content parts', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' },
    ];
    const msg = createAssistantMessage(parts);
    expect(msg.role).toBe('assistant');
    expect(msg.content).toHaveLength(2);
    expect(msg.toolCalls).toEqual([]);
  });

  it('includes toolCalls when provided', () => {
    const tc: ToolCall = {
      type: 'function',
      id: 'call-1',
      function: { name: 'search', arguments: '{"q":"ts"}' },
    };
    const msg = createAssistantMessage([{ type: 'text', text: 'ok' }], [tc]);
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls[0]!.function.name).toBe('search');
  });

  it('defaults toolCalls to empty array when not provided', () => {
    const msg = createAssistantMessage([{ type: 'text', text: 'test' }]);
    expect(msg.toolCalls).toEqual([]);
  });
});

describe('createToolMessage', () => {
  it('creates a tool message from a string', () => {
    const msg = createToolMessage('call-1', 'result data');
    expect(msg.role).toBe('tool');
    expect(msg.toolCallId).toBe('call-1');
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toEqual({ type: 'text', text: 'result data' });
  });

  it('creates a tool message from ContentPart array', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'line1' },
      { type: 'text', text: 'line2' },
    ];
    const msg = createToolMessage('call-2', parts);
    expect(msg.role).toBe('tool');
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toEqual({ type: 'text', text: 'line1' });
  });
});

// ── extractText ────────────────────────────────────────────────────────

describe('extractText', () => {
  it('extracts text from a message with a single text part', () => {
    const msg = createUserMessage('hello world');
    expect(extractText(msg)).toBe('hello world');
  });

  it('concatenates multiple text parts with default separator', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ],
      toolCalls: [],
    };
    expect(extractText(msg)).toBe('Hello world');
  });

  it('uses custom separator', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
      ],
      toolCalls: [],
    };
    expect(extractText(msg, '\n')).toBe('line1\nline2');
  });

  it('ignores non-text parts', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'think', think: 'thinking...' },
        { type: 'text', text: 'visible' },
      ],
      toolCalls: [],
    };
    expect(extractText(msg)).toBe('visible');
  });

  it('returns empty string for message with no text parts', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'think', think: 'thinking only' }],
      toolCalls: [],
    };
    expect(extractText(msg)).toBe('');
  });

  it('returns empty string for message with empty content', () => {
    const msg: Message = { role: 'assistant', content: [], toolCalls: [] };
    expect(extractText(msg)).toBe('');
  });
});

describe('getTextContent (deprecated alias)', () => {
  it('works the same as extractText', () => {
    const msg = createUserMessage('test');
    expect(getTextContent(msg)).toBe(extractText(msg));
  });
});

// ── ContentPart type narrowing ─────────────────────────────────────────

describe('ContentPart type narrowing', () => {
  it('narrows TextPart correctly', () => {
    const part: ContentPart = { type: 'text', text: 'hello' };
    if (part.type === 'text') {
      const textPart: TextPart = part;
      expect(textPart.text).toBe('hello');
    }
  });

  it('narrows ThinkPart correctly', () => {
    const part: ContentPart = { type: 'think', think: 'reasoning' };
    if (part.type === 'think') {
      const thinkPart: ThinkPart = part;
      expect(thinkPart.think).toBe('reasoning');
    }
  });

  it('narrows ThinkPart with encrypted field', () => {
    const part: ContentPart = { type: 'think', think: '', encrypted: 'enc-data' };
    if (part.type === 'think') {
      expect(part.encrypted).toBe('enc-data');
    }
  });

  it('narrows ImageURLPart correctly', () => {
    const part: ContentPart = {
      type: 'image_url',
      imageUrl: { url: 'https://example.com/img.png' },
    };
    if (part.type === 'image_url') {
      const imgPart: ImageURLPart = part;
      expect(imgPart.imageUrl.url).toBe('https://example.com/img.png');
    }
  });

  it('narrows ImageURLPart with optional id', () => {
    const part: ContentPart = {
      type: 'image_url',
      imageUrl: { url: 'https://example.com/img.png', id: 'img-1' },
    };
    if (part.type === 'image_url') {
      expect(part.imageUrl.id).toBe('img-1');
    }
  });

  it('narrows AudioURLPart correctly', () => {
    const part: ContentPart = {
      type: 'audio_url',
      audioUrl: { url: 'https://example.com/audio.mp3' },
    };
    if (part.type === 'audio_url') {
      const audioPart: AudioURLPart = part;
      expect(audioPart.audioUrl.url).toBe('https://example.com/audio.mp3');
    }
  });

  it('narrows VideoURLPart correctly', () => {
    const part: ContentPart = {
      type: 'video_url',
      videoUrl: { url: 'https://example.com/video.mp4', id: 'vid-1' },
    };
    if (part.type === 'video_url') {
      const videoPart: VideoURLPart = part;
      expect(videoPart.videoUrl.url).toBe('https://example.com/video.mp4');
      expect(videoPart.videoUrl.id).toBe('vid-1');
    }
  });
});

// ── Type guards ────────────────────────────────────────────────────────

describe('type guards', () => {
  it('isContentPart returns true for text', () => {
    const part: StreamedMessagePart = { type: 'text', text: 'hi' };
    expect(isContentPart(part)).toBe(true);
  });

  it('isContentPart returns true for think', () => {
    const part: StreamedMessagePart = { type: 'think', think: 'hmm' };
    expect(isContentPart(part)).toBe(true);
  });

  it('isContentPart returns true for image_url', () => {
    const part: StreamedMessagePart = {
      type: 'image_url',
      imageUrl: { url: 'http://img' },
    };
    expect(isContentPart(part)).toBe(true);
  });

  it('isContentPart returns true for audio_url', () => {
    const part: StreamedMessagePart = {
      type: 'audio_url',
      audioUrl: { url: 'http://audio' },
    };
    expect(isContentPart(part)).toBe(true);
  });

  it('isContentPart returns true for video_url', () => {
    const part: StreamedMessagePart = {
      type: 'video_url',
      videoUrl: { url: 'http://video' },
    };
    expect(isContentPart(part)).toBe(true);
  });

  it('isContentPart returns false for tool call', () => {
    const part: StreamedMessagePart = {
      type: 'function',
      id: 'c1',
      function: { name: 'f', arguments: null },
    };
    expect(isContentPart(part)).toBe(false);
  });

  it('isContentPart returns false for tool call part', () => {
    const part: StreamedMessagePart = { type: 'tool_call_part', argumentsPart: 'x' };
    expect(isContentPart(part)).toBe(false);
  });

  it('isToolCall returns true for function type', () => {
    const part: StreamedMessagePart = {
      type: 'function',
      id: 'c1',
      function: { name: 'f', arguments: null },
    };
    expect(isToolCall(part)).toBe(true);
  });

  it('isToolCall returns false for content parts', () => {
    const part: StreamedMessagePart = { type: 'text', text: 'hi' };
    expect(isToolCall(part)).toBe(false);
  });

  it('isToolCallPart returns true for tool_call_part', () => {
    const part: StreamedMessagePart = { type: 'tool_call_part', argumentsPart: 'abc' };
    expect(isToolCallPart(part)).toBe(true);
  });

  it('isToolCallPart returns false for other types', () => {
    const part: StreamedMessagePart = { type: 'text', text: 'hi' };
    expect(isToolCallPart(part)).toBe(false);
  });
});

// ── mergeInPlace ───────────────────────────────────────────────────────

describe('mergeInPlace', () => {
  it('merges TextPart + TextPart', () => {
    const target: TextPart = { type: 'text', text: 'hello' };
    const source: TextPart = { type: 'text', text: ' world' };
    expect(mergeInPlace(target, source)).toBe(true);
    expect(target.text).toBe('hello world');
  });

  it('merges ThinkPart + ThinkPart', () => {
    const target: ThinkPart = { type: 'think', think: 'step1' };
    const source: ThinkPart = { type: 'think', think: ' step2' };
    expect(mergeInPlace(target, source)).toBe(true);
    expect(target.think).toBe('step1 step2');
  });

  it('merges ThinkPart + ThinkPart with source encrypted', () => {
    const target: ThinkPart = { type: 'think', think: 'thought' };
    const source: ThinkPart = { type: 'think', think: '', encrypted: 'sig-123' };
    expect(mergeInPlace(target, source)).toBe(true);
    expect(target.think).toBe('thought');
    expect(target.encrypted).toBe('sig-123');
  });

  it('refuses ThinkPart merge when target already encrypted', () => {
    const target: ThinkPart = { type: 'think', think: 'done', encrypted: 'sig-old' };
    const source: ThinkPart = { type: 'think', think: ' more' };
    expect(mergeInPlace(target, source)).toBe(false);
    expect(target.think).toBe('done');
  });

  it('merges ToolCall + ToolCallPart (null -> part)', () => {
    const target: ToolCall = {
      type: 'function',
      id: 'c1',
      function: { name: 'f', arguments: null },
    };
    const source: ToolCallPart = { type: 'tool_call_part', argumentsPart: '{"a":' };
    expect(mergeInPlace(target, source)).toBe(true);
    expect(target.function.arguments).toBe('{"a":');
  });

  it('merges ToolCall + ToolCallPart (append)', () => {
    const target: ToolCall = {
      type: 'function',
      id: 'c1',
      function: { name: 'f', arguments: '{"a":' },
    };
    const source: ToolCallPart = { type: 'tool_call_part', argumentsPart: '1}' };
    expect(mergeInPlace(target, source)).toBe(true);
    expect(target.function.arguments).toBe('{"a":1}');
  });

  it('merges ToolCall + ToolCallPart with null argumentsPart (no-op)', () => {
    const target: ToolCall = {
      type: 'function',
      id: 'c1',
      function: { name: 'f', arguments: '{"x":1}' },
    };
    const source: ToolCallPart = { type: 'tool_call_part', argumentsPart: null };
    expect(mergeInPlace(target, source)).toBe(true);
    expect(target.function.arguments).toBe('{"x":1}');
  });

  it('returns false for TextPart + ThinkPart', () => {
    const target: TextPart = { type: 'text', text: 'hi' };
    const source: ThinkPart = { type: 'think', think: 'nope' };
    expect(mergeInPlace(target, source)).toBe(false);
  });

  it('returns false for ThinkPart + TextPart', () => {
    const target: ThinkPart = { type: 'think', think: 'hi' };
    const source: TextPart = { type: 'text', text: 'nope' };
    expect(mergeInPlace(target, source)).toBe(false);
  });

  it('returns false for TextPart + ToolCallPart', () => {
    const target: TextPart = { type: 'text', text: 'hi' };
    const source: ToolCallPart = { type: 'tool_call_part', argumentsPart: 'x' };
    expect(mergeInPlace(target, source)).toBe(false);
  });

  it('returns false for ToolCall + TextPart', () => {
    const target: ToolCall = {
      type: 'function',
      id: 'c1',
      function: { name: 'f', arguments: null },
    };
    const source: TextPart = { type: 'text', text: 'x' };
    expect(mergeInPlace(target, source)).toBe(false);
  });
});

// ── Message optional fields ────────────────────────────────────────────

describe('Message optional fields', () => {
  it('message can have name field', () => {
    const msg: Message = {
      role: 'system',
      name: 'system-prompt',
      content: [{ type: 'text', text: 'You are helpful.' }],
      toolCalls: [],
    };
    expect(msg.name).toBe('system-prompt');
  });

  it('message can have toolCalls', () => {
    const msg: Message = {
      role: 'assistant',
      content: [],
      toolCalls: [
        {
          type: 'function',
          id: 'call-1',
          function: { name: 'search', arguments: '{"q":"test"}' },
        },
      ],
    };
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls[0]!.function.name).toBe('search');
  });

  it('message can have partial flag', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'partial...' }],
      toolCalls: [],
      partial: true,
    };
    expect(msg.partial).toBe(true);
  });

  it('ToolCall can have extras', () => {
    const tc: ToolCall = {
      type: 'function',
      id: 'call-1',
      function: { name: 'search', arguments: '{}' },
      extras: { provider_id: 'anthropic-123' },
    };
    expect(tc.extras).toEqual({ provider_id: 'anthropic-123' });
  });
});
