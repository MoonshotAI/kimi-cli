/**
 * Covers: FetchURLTool (Slice 3.5).
 *
 * Uses a fake UrlFetcher to test tool behaviour in isolation.
 */

import { describe, expect, it, vi } from 'vitest';

import type { UrlFetcher } from '../../src/tools/fetch-url.js';
import { FetchURLTool } from '../../src/tools/fetch-url.js';
import { toolContentString } from './fixtures/fake-kaos.js';

const signal = new AbortController().signal;

function fakeFetcher(content = ''): UrlFetcher {
  return { fetch: vi.fn().mockResolvedValue(content) };
}

describe('FetchURLTool', () => {
  it('has name "FetchURL" and a non-empty description', () => {
    const tool = new FetchURLTool(fakeFetcher());
    expect(tool.name).toBe('FetchURL');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('inputSchema accepts valid FetchURLInput', () => {
    const tool = new FetchURLTool(fakeFetcher());
    expect(tool.inputSchema.safeParse({ url: 'https://example.com' }).success).toBe(true);
  });

  it('returns fetched content from provider', async () => {
    const tool = new FetchURLTool(fakeFetcher('Hello, world!'));
    const result = await tool.execute('c1', { url: 'https://example.com' }, signal);
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toBe('Hello, world!');
  });

  it('returns empty message when fetcher returns empty string', async () => {
    const tool = new FetchURLTool(fakeFetcher(''));
    const result = await tool.execute('c2', { url: 'https://example.com/empty' }, signal);
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('empty');
  });

  it('returns error when fetcher throws', async () => {
    const fetcher: UrlFetcher = {
      fetch: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    const tool = new FetchURLTool(fetcher);
    const result = await tool.execute('c3', { url: 'https://example.com/fail' }, signal);
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('timeout');
  });

  it('passes format option to fetcher', async () => {
    const fetcher = fakeFetcher('# Markdown');
    const tool = new FetchURLTool(fetcher);
    await tool.execute('c4', { url: 'https://example.com', format: 'markdown' }, signal);
    expect(fetcher.fetch).toHaveBeenCalledWith('https://example.com', { format: 'markdown' });
  });

  it('getActivityDescription truncates long URLs', () => {
    const tool = new FetchURLTool(fakeFetcher());
    const desc = tool.getActivityDescription({ url: 'https://example.com/' + 'a'.repeat(60) });
    expect(desc.length).toBeLessThanOrEqual(65);
    expect(desc).toContain('…');
  });
});
