/**
 * MCP output-budget tests — Slice 2.6.
 *
 * Port of Python `tests/tools/test_mcp_tool_result.py` (13 cases).
 * Covers truncation, media budget, unsupported content handling, and
 * the error-result path. When a case here fails, first diff against
 * the Python test to make sure the semantics didn't drift.
 */

import { describe, expect, it } from 'vitest';

import {
  MCP_MAX_OUTPUT_CHARS,
  convertMcpToolResult,
  type McpContentBlock,
} from '../../../src/soul-plus/mcp/output-budget.js';
import type { ToolResultContent } from '../../../src/soul/types.js';

function textBlock(text: string): McpContentBlock {
  return { type: 'text', text };
}

function imageBlock(data: string, mimeType = 'image/png'): McpContentBlock {
  return { type: 'image', data, mimeType };
}

function blobResource(blob: string, mimeType: string, uri = 'file:///test.bin'): McpContentBlock {
  return {
    type: 'resource',
    resource: { uri, blob, mimeType },
  };
}

function asText(part: ToolResultContent): string {
  if (part.type !== 'text') {
    throw new Error(`expected text part, got ${part.type}`);
  }
  return part.text;
}

function textParts(content: string | ToolResultContent[]): ToolResultContent[] {
  if (typeof content === 'string') return [];
  return content.filter((p) => p.type === 'text');
}

function imageParts(content: string | ToolResultContent[]): ToolResultContent[] {
  if (typeof content === 'string') return [];
  return content.filter((p) => p.type === 'image');
}

function parts(content: string | ToolResultContent[]): ToolResultContent[] {
  if (typeof content === 'string') {
    throw new TypeError('expected ToolResultContent[], got string');
  }
  return content;
}

describe('convertMcpToolResult — truncation', () => {
  it('small text passes through untouched', () => {
    const out = convertMcpToolResult({ content: [textBlock('hello')] });
    expect(out.isError).toBe(false);
    const pts = parts(out.content);
    expect(pts).toHaveLength(1);
    expect(asText(pts[0]!)).toBe('hello');
  });

  it('text longer than budget is truncated with a notice', () => {
    const big = 'x'.repeat(MCP_MAX_OUTPUT_CHARS + 5000);
    const out = convertMcpToolResult({ content: [textBlock(big)] });
    const pts = parts(out.content);
    expect(pts).toHaveLength(2);
    expect(asText(pts[0]!).length).toBe(MCP_MAX_OUTPUT_CHARS);
    expect(asText(pts[1]!).toLowerCase()).toContain('truncated');
  });

  it('accumulates budget across multiple text parts', () => {
    const half = Math.floor(MCP_MAX_OUTPUT_CHARS / 2);
    const out = convertMcpToolResult({
      content: [textBlock('a'.repeat(half + 100)), textBlock('b'.repeat(half + 100))],
    });
    const pts = parts(out.content);
    const totalText = pts
      .filter((p) => p.type === 'text' && !asText(p).toLowerCase().includes('truncated'))
      .reduce((sum, p) => sum + asText(p).length, 0);
    expect(totalText).toBeLessThanOrEqual(MCP_MAX_OUTPUT_CHARS);
    expect(
      pts.some((p) => p.type === 'text' && asText(p).toLowerCase().includes('truncated')),
    ).toBe(true);
  });

  it('drops remaining text parts once budget is exhausted', () => {
    const out = convertMcpToolResult({
      content: [textBlock('x'.repeat(MCP_MAX_OUTPUT_CHARS)), textBlock('should be dropped')],
    });
    const pts = textParts(out.content);
    // Full first text (100 000 chars) + truncation notice.
    expect(pts).toHaveLength(2);
    expect(asText(pts.at(-1)!).toLowerCase()).toContain('truncated');
    expect(pts.some((p) => asText(p).includes('should be dropped'))).toBe(false);
  });

  it('preserves truncation semantics on isError results', () => {
    const big = 'e'.repeat(MCP_MAX_OUTPUT_CHARS + 1000);
    const out = convertMcpToolResult({ content: [textBlock(big)], isError: true });
    expect(out.isError).toBe(true);
    const pts = parts(out.content);
    expect(pts).toHaveLength(2);
    expect(asText(pts[1]!).toLowerCase()).toContain('truncated');
  });

  it('small image is counted against budget but both image and text survive', () => {
    const out = convertMcpToolResult({
      content: [imageBlock('AAAA', 'image/png'), textBlock('hello')],
    });
    const pts = parts(out.content);
    expect(pts).toHaveLength(2);
    expect(pts[0]!.type).toBe('image');
    expect(asText(pts[1]!)).toBe('hello');
  });
});

describe('convertMcpToolResult — media budget', () => {
  it('oversized image is dropped with only a truncation notice surviving', () => {
    // 150 K bytes → base64 is ~200 K chars → data URL > MCP_MAX_OUTPUT_CHARS.
    const bigData = Buffer.alloc(150_000, 0).toString('base64');
    const out = convertMcpToolResult({ content: [imageBlock(bigData, 'image/png')] });
    const pts = parts(out.content);
    expect(imageParts(out.content)).toHaveLength(0);
    expect(pts.every((p) => p.type === 'text')).toBe(true);
    expect(pts.some((p) => asText(p).toLowerCase().includes('truncated'))).toBe(true);
  });

  it('oversized blob resource is dropped too', () => {
    const bigBlob = Buffer.alloc(150_000, 0xff).toString('base64');
    const out = convertMcpToolResult({
      content: [blobResource(bigBlob, 'image/png', 'file:///screenshot.png')],
    });
    const pts = parts(out.content);
    expect(imageParts(out.content)).toHaveLength(0);
    expect(pts.every((p) => p.type === 'text')).toBe(true);
    expect(pts.some((p) => asText(p).toLowerCase().includes('truncated'))).toBe(true);
  });

  it('text following a dropped oversized image still survives', () => {
    const bigData = Buffer.alloc(150_000, 0).toString('base64');
    const out = convertMcpToolResult({
      content: [imageBlock(bigData, 'image/png'), textBlock('caption after screenshot')],
    });
    const pts = textParts(out.content);
    expect(pts.some((p) => asText(p).includes('caption after screenshot'))).toBe(true);
    expect(pts.some((p) => asText(p).toLowerCase().includes('truncated'))).toBe(true);
  });

  it('multiple medium images exhaust budget so not all survive', () => {
    // ~40 K chars per image (data URL) — 3 fit, the 4th should overflow.
    const mediumData = Buffer.alloc(30_000, 0).toString('base64');
    const out = convertMcpToolResult({
      content: [
        imageBlock(mediumData),
        imageBlock(mediumData),
        imageBlock(mediumData),
        imageBlock(mediumData),
      ],
    });
    const surviving = imageParts(out.content);
    expect(surviving.length).toBeLessThan(4);
    expect(
      parts(out.content).some(
        (p) => p.type === 'text' && asText(p).toLowerCase().includes('truncated'),
      ),
    ).toBe(true);
  });
});

describe('convertMcpToolResult — unsupported content', () => {
  it('unknown content type becomes a text placeholder, not a crash', () => {
    const unknown: McpContentBlock = { type: 'something-new' };
    const out = convertMcpToolResult({ content: [unknown] });
    const pts = parts(out.content);
    expect(pts).toHaveLength(1);
    expect(asText(pts[0]!).toLowerCase()).toContain('unsupported');
  });

  it('blob resource with unsupported mime becomes a text placeholder', () => {
    const out = convertMcpToolResult({
      content: [blobResource('deadbeef', 'application/x-custom', 'file:///test.bin')],
    });
    const pts = parts(out.content);
    expect(pts).toHaveLength(1);
    expect(asText(pts[0]!).toLowerCase()).toContain('unsupported');
  });

  it('mixes valid and invalid parts in order', () => {
    const out = convertMcpToolResult({
      content: [textBlock('valid'), { type: 'weird' }],
    });
    const pts = parts(out.content);
    expect(pts).toHaveLength(2);
    expect(asText(pts[0]!)).toBe('valid');
    expect(asText(pts[1]!).toLowerCase()).toContain('unsupported');
  });
});

// ── Phase 17 E.3 — mediaDataUrlLength covers video variant ─────────

describe('Phase 17 E.3 — video media counts against budget', () => {
  it('mediaDataUrlLength returns positive cost for video ToolResultContent', async () => {
    // Phase 17 E.3 renames `imageDataUrlLength` → `mediaDataUrlLength`
    // and teaches it to size `type: 'video'` parts the same way. The
    // helper is exported for unit coverage.
    const { mediaDataUrlLength } = await import(
      '../../../src/soul-plus/mcp/output-budget.js'
    );
    const videoPart: ToolResultContent = {
      type: 'video',
      source: {
        type: 'base64',
        data: 'AAAA'.repeat(256),
        media_type: 'video/mp4',
      },
    };
    const len = mediaDataUrlLength(videoPart);
    // Format: `data:${mime};base64,${data}` — length must include the
    // full base64 payload.
    expect(len).toBeGreaterThan('AAAA'.repeat(256).length);
    expect(len).toBeGreaterThan('video/mp4'.length);
  });

  it('mediaDataUrlLength returns 0 for non-media content (text)', async () => {
    const { mediaDataUrlLength } = await import(
      '../../../src/soul-plus/mcp/output-budget.js'
    );
    const textPart: ToolResultContent = { type: 'text', text: 'hi' };
    expect(mediaDataUrlLength(textPart)).toBe(0);
  });
});
