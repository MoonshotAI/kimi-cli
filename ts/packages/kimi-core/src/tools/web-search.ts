/**
 * WebSearchTool — host-injected web search (Slice 3.5).
 *
 * Ports Python `kimi_cli/tools/web/search.py`. kimi-core defines the
 * interface; the host provides the real search implementation via
 * `WebSearchProvider`. If no provider is supplied, the tool should not
 * be registered (not exposed to the LLM).
 */

import { z } from 'zod';

import type { ToolResult, ToolUpdate, ToolMetadata } from '../soul/types.js';
import type { BuiltinTool } from './types.js';

// ── Provider interface (host-injected) ───────────────────────────────

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string | undefined;
  content?: string | undefined;
}

export interface WebSearchProvider {
  search(
    query: string,
    options?: { limit?: number; includeContent?: boolean },
  ): Promise<WebSearchResult[]>;
}

// ── Input schema ─────────────────────────────────────────────────────

export interface WebSearchInput {
  query: string;
  limit?: number | undefined;
  include_content?: boolean | undefined;
}

const _rawWebSearchInputSchema = z.object({
  query: z.string().describe('The query text to search for.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe('The number of results to return.'),
  include_content: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether to include the content of the web pages in the results.'),
});

export const WebSearchInputSchema: z.ZodType<WebSearchInput> = _rawWebSearchInputSchema;

// ── Tool description ─────────────────────────────────────────────────

const DESCRIPTION =
  'Search the web for information. Returns a list of search results with title, URL, and snippet. ' +
  'Use this when you need up-to-date information from the internet.';

// ── Implementation ───────────────────────────────────────────────────

export class WebSearchTool implements BuiltinTool<WebSearchInput, void> {
  readonly name = 'WebSearch' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description: string = DESCRIPTION;
  readonly inputSchema: z.ZodType<WebSearchInput> = WebSearchInputSchema;
  // Phase 15 L14 — idempotent web lookup; safe to prefetch under streaming.
  readonly isConcurrencySafe = (_input: unknown): boolean => true;

  constructor(private readonly provider: WebSearchProvider) {}

  async execute(
    _toolCallId: string,
    args: WebSearchInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<void>> {
    try {
      const opts: { limit?: number; includeContent?: boolean } = {};
      if (args.limit !== undefined) opts.limit = args.limit;
      if (args.include_content !== undefined) opts.includeContent = args.include_content;
      const results = await this.provider.search(args.query, opts);

      if (results.length === 0) {
        return { content: 'No search results found.', isError: false };
      }

      const formatted = results
        .map((r, i) => {
          const lines = [
            `Title: ${r.title}`,
            r.date ? `Date: ${r.date}` : '',
            `URL: ${r.url}`,
            `Summary: ${r.snippet}`,
          ].filter(Boolean);
          if (r.content) lines.push('', r.content);
          return (i > 0 ? '---\n\n' : '') + lines.join('\n') + '\n';
        })
        .join('\n');

      return { content: formatted, isError: false };
    } catch (error) {
      return {
        isError: true,
        content: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  getActivityDescription(args: WebSearchInput): string {
    const preview = args.query.length > 40 ? `${args.query.slice(0, 40)}…` : args.query;
    return `Searching: ${preview}`;
  }
}
