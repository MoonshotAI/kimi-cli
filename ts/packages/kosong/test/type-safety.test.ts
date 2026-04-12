import { describe, expect, it } from 'vitest';

import type {
  AudioURLPart,
  ImageURLPart,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolCallPart,
  VideoURLPart,
} from '../src/message.js';

// ── Discriminated union narrowing via switch ──────────────────────────

/**
 * This function exercises TypeScript's discriminated-union narrowing.
 * If the type system is correct, every branch accesses only properties
 * that exist on the narrowed type — no casts, no `any`.
 */
function processPartSafely(part: StreamedMessagePart): string {
  switch (part.type) {
    case 'text':
      return part.text; // TextPart.text -> string
    case 'think':
      return part.think; // ThinkPart.think -> string
    case 'image_url':
      return part.imageUrl.url; // ImageURLPart.imageUrl.url -> string
    case 'audio_url':
      return part.audioUrl.url; // AudioURLPart.audioUrl.url -> string
    case 'video_url':
      return part.videoUrl.url; // VideoURLPart.videoUrl.url -> string
    case 'function':
      return part.function.name; // ToolCall.function.name -> string
    case 'tool_call_part':
      return part.argumentsPart ?? ''; // ToolCallPart.argumentsPart -> string | null
  }
}

describe('StreamedMessagePart discriminated union narrowing', () => {
  it('narrows TextPart via switch', () => {
    const part: StreamedMessagePart = { type: 'text', text: 'hello' };
    expect(processPartSafely(part)).toBe('hello');
  });

  it('narrows ThinkPart via switch', () => {
    const part: StreamedMessagePart = { type: 'think', think: 'reasoning...' };
    expect(processPartSafely(part)).toBe('reasoning...');
  });

  it('narrows ImageURLPart via switch', () => {
    const part: StreamedMessagePart = {
      type: 'image_url',
      imageUrl: { url: 'https://example.com/img.png' },
    };
    expect(processPartSafely(part)).toBe('https://example.com/img.png');
  });

  it('narrows AudioURLPart via switch', () => {
    const part: StreamedMessagePart = {
      type: 'audio_url',
      audioUrl: { url: 'https://example.com/audio.mp3' },
    };
    expect(processPartSafely(part)).toBe('https://example.com/audio.mp3');
  });

  it('narrows VideoURLPart via switch', () => {
    const part: StreamedMessagePart = {
      type: 'video_url',
      videoUrl: { url: 'https://example.com/video.mp4' },
    };
    expect(processPartSafely(part)).toBe('https://example.com/video.mp4');
  });

  it('narrows ToolCall via switch', () => {
    const part: StreamedMessagePart = {
      type: 'function',
      id: 'call-1',
      function: { name: 'search', arguments: '{"q":"test"}' },
    };
    expect(processPartSafely(part)).toBe('search');
  });

  it('narrows ToolCallPart via switch (non-null)', () => {
    const part: StreamedMessagePart = {
      type: 'tool_call_part',
      argumentsPart: '{"key":"value"}',
    };
    expect(processPartSafely(part)).toBe('{"key":"value"}');
  });

  it('narrows ToolCallPart via switch (null argumentsPart)', () => {
    const part: StreamedMessagePart = {
      type: 'tool_call_part',
      argumentsPart: null,
    };
    expect(processPartSafely(part)).toBe('');
  });
});

// ── Exhaustiveness check ──────────────────────────────────────────────

describe('exhaustiveness check', () => {
  it('switch covers all discriminants — never type reached', () => {
    // If StreamedMessagePart gains a new variant and processPartSafely
    // does not handle it, TypeScript will report:
    //   "Function lacks ending return statement and return type does
    //    not include 'undefined'."
    // This is a compile-time guarantee, not a runtime one.
    // We simply verify the function returns a string for every current variant.
    const allParts: StreamedMessagePart[] = [
      { type: 'text', text: 'a' },
      { type: 'think', think: 'b' },
      { type: 'image_url', imageUrl: { url: 'c' } },
      { type: 'audio_url', audioUrl: { url: 'd' } },
      { type: 'video_url', videoUrl: { url: 'e' } },
      { type: 'function', id: 'f', function: { name: 'g', arguments: null } },
      { type: 'tool_call_part', argumentsPart: 'h' },
    ];
    for (const part of allParts) {
      expect(typeof processPartSafely(part)).toBe('string');
    }
  });
});

// ── Type assignability checks ─────────────────────────────────────────

describe('type assignability', () => {
  it('TextPart is assignable to StreamedMessagePart', () => {
    const text: TextPart = { type: 'text', text: 'x' };
    const _part: StreamedMessagePart = text;
    expect(_part.type).toBe('text');
  });

  it('ThinkPart is assignable to StreamedMessagePart', () => {
    const think: ThinkPart = { type: 'think', think: 'x' };
    const _part: StreamedMessagePart = think;
    expect(_part.type).toBe('think');
  });

  it('ImageURLPart is assignable to StreamedMessagePart', () => {
    const img: ImageURLPart = { type: 'image_url', imageUrl: { url: 'x' } };
    const _part: StreamedMessagePart = img;
    expect(_part.type).toBe('image_url');
  });

  it('AudioURLPart is assignable to StreamedMessagePart', () => {
    const audio: AudioURLPart = { type: 'audio_url', audioUrl: { url: 'x' } };
    const _part: StreamedMessagePart = audio;
    expect(_part.type).toBe('audio_url');
  });

  it('VideoURLPart is assignable to StreamedMessagePart', () => {
    const video: VideoURLPart = { type: 'video_url', videoUrl: { url: 'x' } };
    const _part: StreamedMessagePart = video;
    expect(_part.type).toBe('video_url');
  });

  it('ToolCall is assignable to StreamedMessagePart', () => {
    const tc: ToolCall = { type: 'function', id: 'c', function: { name: 'f', arguments: null } };
    const _part: StreamedMessagePart = tc;
    expect(_part.type).toBe('function');
  });

  it('ToolCallPart is assignable to StreamedMessagePart', () => {
    const tcp: ToolCallPart = { type: 'tool_call_part', argumentsPart: null };
    const _part: StreamedMessagePart = tcp;
    expect(_part.type).toBe('tool_call_part');
  });
});
