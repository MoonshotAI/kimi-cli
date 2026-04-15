/**
 * Covers: WriteTool (v2 §9-F / Appendix E.2).
 *
 * Pins:
 *   - Write new file → bytesWritten in output
 *   - Overwrite existing file
 *   - Parent directory does not exist → isError
 *   - getActivityDescription format
 */

import { describe, expect, it, vi } from 'vitest';

import { WriteTool } from '../../src/tools/index.js';
import { createFakeKaos } from './fixtures/fake-kaos.js';

function makeWriteTool(writeFn?: (...args: unknown[]) => Promise<number>): WriteTool {
  const kaos = createFakeKaos({
    writeText: writeFn ?? vi.fn().mockResolvedValue(42),
  });
  return new WriteTool(kaos);
}

describe('WriteTool', () => {
  it('has name "Write" and a non-empty description', () => {
    const tool = makeWriteTool();
    expect(tool.name).toBe('Write');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('inputSchema accepts valid WriteInput', () => {
    const tool = makeWriteTool();
    const result = tool.inputSchema.safeParse({ path: '/tmp/out.txt', content: 'hello' });
    expect(result.success).toBe(true);
  });

  it('inputSchema rejects missing content', () => {
    const tool = makeWriteTool();
    const result = tool.inputSchema.safeParse({ path: '/tmp/out.txt' });
    expect(result.success).toBe(false);
  });

  it('writes a new file and returns bytesWritten', async () => {
    const tool = makeWriteTool(vi.fn().mockResolvedValue(5));
    const result = await tool.execute(
      'call_1',
      { path: '/tmp/new.txt', content: 'hello' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.bytesWritten).toBeGreaterThan(0);
  });

  it('overwrites an existing file', async () => {
    const tool = makeWriteTool(vi.fn().mockResolvedValue(11));
    const result = await tool.execute(
      'call_2',
      { path: '/tmp/existing.txt', content: 'new content' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.bytesWritten).toBe(11);
  });

  it('returns isError when parent directory does not exist', async () => {
    const tool = makeWriteTool(vi.fn().mockRejectedValue(new Error('ENOENT: no such directory')));
    const result = await tool.execute(
      'call_3',
      { path: '/nonexistent/dir/file.txt', content: 'data' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });

  it('getActivityDescription returns "Writing <path>"', () => {
    const tool = makeWriteTool();
    const desc = tool.getActivityDescription({ path: '/foo/bar.ts', content: '' });
    expect(desc).toBe('Writing /foo/bar.ts');
  });
});
