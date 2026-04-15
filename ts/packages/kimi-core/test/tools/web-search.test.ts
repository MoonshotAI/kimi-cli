/**
 * Covers: WebSearchTool (Slice 3.5).
 *
 * Uses a fake WebSearchProvider to test tool behaviour in isolation.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WebSearchProvider } from '../../src/tools/web-search.js';
import { WebSearchTool } from '../../src/tools/web-search.js';
import { toolContentString } from './fixtures/fake-kaos.js';

const signal = new AbortController().signal;

function fakeProvider(
  results: Awaited<ReturnType<WebSearchProvider['search']>> = [],
): WebSearchProvider {
  return { search: vi.fn().mockResolvedValue(results) };
}

describe('WebSearchTool', () => {
  it('has name "WebSearch" and a non-empty description', () => {
    const tool = new WebSearchTool(fakeProvider());
    expect(tool.name).toBe('WebSearch');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('inputSchema accepts valid WebSearchInput', () => {
    const tool = new WebSearchTool(fakeProvider());
    expect(tool.inputSchema.safeParse({ query: 'test' }).success).toBe(true);
  });

  it('returns formatted results from provider', async () => {
    const provider = fakeProvider([
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
      { title: 'Result 2', url: 'https://example.com/2', snippet: 'Snippet 2', date: '2024-01-01' },
    ]);
    const tool = new WebSearchTool(provider);
    const result = await tool.execute('c1', { query: 'test query' }, signal);
    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('Result 1');
    expect(content).toContain('https://example.com/1');
    expect(content).toContain('Result 2');
    expect(content).toContain('2024-01-01');
  });

  it('returns no results message when provider returns empty', async () => {
    const tool = new WebSearchTool(fakeProvider([]));
    const result = await tool.execute('c2', { query: 'nothing' }, signal);
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('No search results found');
  });

  it('returns error when provider throws', async () => {
    const provider: WebSearchProvider = {
      search: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const tool = new WebSearchTool(provider);
    const result = await tool.execute('c3', { query: 'fail' }, signal);
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('network error');
  });

  it('passes limit and includeContent to provider', async () => {
    const provider = fakeProvider([]);
    const tool = new WebSearchTool(provider);
    await tool.execute('c4', { query: 'test', limit: 10, include_content: true }, signal);
    expect(provider.search).toHaveBeenCalledWith('test', { limit: 10, includeContent: true });
  });

  it('getActivityDescription truncates long queries', () => {
    const tool = new WebSearchTool(fakeProvider());
    const desc = tool.getActivityDescription({ query: 'a'.repeat(60) });
    expect(desc.length).toBeLessThanOrEqual(55);
    expect(desc).toContain('…');
  });
});
