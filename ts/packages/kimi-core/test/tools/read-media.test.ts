/**
 * Covers: ReadMediaFileTool (Slice 3.5).
 *
 * Uses fake Kaos for file system operations, permissive workspace.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import { ReadMediaFileTool } from '../../src/tools/read-media.js';
import { createFakeKaos, PERMISSIVE_WORKSPACE } from './fixtures/fake-kaos.js';

const signal = new AbortController().signal;

const DEFAULT_STAT = {
  stMode: 0o100644,
  stIno: 0,
  stDev: 0,
  stNlink: 1,
  stUid: 0,
  stGid: 0,
  stSize: 1024,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
};

function makeReadMediaTool(overrides?: { stat?: Kaos['stat']; readBytes?: Kaos['readBytes'] }) {
  const kaos = createFakeKaos({
    stat: overrides?.stat ?? vi.fn<Kaos['stat']>().mockResolvedValue(DEFAULT_STAT),
    readBytes:
      overrides?.readBytes ??
      vi.fn<Kaos['readBytes']>().mockResolvedValue(Buffer.from('fake-image-data')),
  });
  return new ReadMediaFileTool(kaos, PERMISSIVE_WORKSPACE);
}

describe('ReadMediaFileTool', () => {
  it('has name "ReadMediaFile" and a non-empty description', () => {
    const tool = makeReadMediaTool();
    expect(tool.name).toBe('ReadMediaFile');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('inputSchema accepts valid path', () => {
    const tool = makeReadMediaTool();
    expect(tool.inputSchema.safeParse({ path: '/images/test.png' }).success).toBe(true);
  });

  it('returns base64-encoded image content for PNG', async () => {
    const imageData = Buffer.from('PNG image bytes');
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: imageData.length }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(imageData),
    });
    const result = await tool.execute('c1', { path: '/workspace/test.png' }, signal);
    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as Array<{
      type: string;
      source?: { type: string; data: string; media_type: string };
    }>;
    expect(blocks[0]!.type).toBe('image');
    expect(blocks[0]!.source!.media_type).toBe('image/png');
    expect(blocks[0]!.source!.data).toBe(imageData.toString('base64'));
  });

  it('returns base64-encoded image content for JPEG', async () => {
    const tool = makeReadMediaTool();
    const result = await tool.execute('c2', { path: '/workspace/photo.jpg' }, signal);
    expect(result.isError).toBeFalsy();
    const blocks = result.content as Array<{ type: string; source?: { media_type: string } }>;
    expect(blocks[0]!.source!.media_type).toBe('image/jpeg');
  });

  it('rejects unsupported file extension', async () => {
    const tool = makeReadMediaTool();
    const result = await tool.execute('c3', { path: '/workspace/data.csv' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unsupported');
  });

  it('rejects empty file', async () => {
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: 0 }),
    });
    const result = await tool.execute('c4', { path: '/workspace/empty.png' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('empty');
  });

  it('rejects file exceeding size limit', async () => {
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: 200 * 1024 * 1024 }),
    });
    const result = await tool.execute('c5', { path: '/workspace/huge.png' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exceeds');
  });

  it('rejects empty path', async () => {
    const tool = makeReadMediaTool();
    const result = await tool.execute('c6', { path: '' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('empty');
  });

  it('rejects path outside workspace', async () => {
    const kaos = createFakeKaos({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue(DEFAULT_STAT),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(Buffer.from('data')),
    });
    const narrowWorkspace = { workspaceDir: '/workspace', additionalDirs: [] };
    const tool = new ReadMediaFileTool(kaos, narrowWorkspace);
    const result = await tool.execute('c7', { path: '/etc/secret.png' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('outside');
  });

  it('handles read errors gracefully', async () => {
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue(DEFAULT_STAT),
      readBytes: vi.fn<Kaos['readBytes']>().mockRejectedValue(new Error('permission denied')),
    });
    const result = await tool.execute('c8', { path: '/workspace/noread.png' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('permission denied');
  });

  it('getActivityDescription returns descriptive text', () => {
    const tool = makeReadMediaTool();
    expect(tool.getActivityDescription({ path: '/test.png' })).toBe('Reading media: /test.png');
  });
});
