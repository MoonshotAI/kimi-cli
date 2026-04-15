// Covers: `adaptToolResult` — v2 ToolResult → Slice 1 ToolResultPayload.
//
// M4 regression: empty / non-text tool content must get a Python-parity
// fallback string instead of silently producing `''` or `'[image]'`,
// because the provider-side APIs reject empty or non-text tool messages
// (Python handles the same case — see
// `/Users/moonshot/Developer/kimi-cli/src/kimi_cli/soul/message.py:51-56`).

import { describe, expect, it } from 'vitest';

import { adaptToolResult } from '../../src/soul/adapters.js';
import type { ToolResult, ToolResultContent } from '../../src/soul/types.js';

describe('adaptToolResult — Python-parity fallbacks', () => {
  it('empty content array → "Tool output is empty." fallback', () => {
    const r: ToolResult = { content: [] };
    const payload = adaptToolResult(r);
    expect(payload.output).toBe('Tool output is empty.');
  });

  it('empty string content → "Tool output is empty." fallback', () => {
    const r: ToolResult = { content: '' };
    const payload = adaptToolResult(r);
    expect(payload.output).toBe('Tool output is empty.');
  });

  it('single text block with empty string → "Tool output is empty." fallback', () => {
    const r: ToolResult = { content: [{ type: 'text', text: '' }] };
    const payload = adaptToolResult(r);
    expect(payload.output).toBe('Tool output is empty.');
  });

  it('image-only content → "Tool returned non-text content." fallback', () => {
    const image: ToolResultContent = {
      type: 'image',
      source: { type: 'base64', data: 'AAAA', media_type: 'image/png' },
    };
    const r: ToolResult = { content: [image] };
    const payload = adaptToolResult(r);
    expect(payload.output).toBe('Tool returned non-text content.');
  });

  it('non-empty text content is preserved as-is', () => {
    const r: ToolResult = { content: 'hello world' };
    const payload = adaptToolResult(r);
    expect(payload.output).toBe('hello world');
  });

  it('multiple text blocks → concatenated', () => {
    const r: ToolResult = {
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
    };
    const payload = adaptToolResult(r);
    expect(payload.output).toBe('hello world');
  });

  it('mixed text + image → text is retained (image silently dropped for now, TODO Slice 4)', () => {
    const image: ToolResultContent = {
      type: 'image',
      source: { type: 'base64', data: 'AAAA', media_type: 'image/png' },
    };
    const r: ToolResult = {
      content: [{ type: 'text', text: 'hello' }, image],
    };
    const payload = adaptToolResult(r);
    // Soul's current minimal protection preserves the text slice. The
    // image round-trip fidelity is deferred to Slice 4.
    expect(payload.output).toBe('hello');
  });

  it('isError flag propagates unchanged', () => {
    const r: ToolResult = { content: 'boom', isError: true };
    const payload = adaptToolResult(r);
    expect(payload.output).toBe('boom');
    expect(payload.isError).toBe(true);
  });

  it('isError + empty fallback coexist', () => {
    const r: ToolResult = { content: [], isError: true };
    const payload = adaptToolResult(r);
    expect(payload.output).toBe('Tool output is empty.');
    expect(payload.isError).toBe(true);
  });
});
