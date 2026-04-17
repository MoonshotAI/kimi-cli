/**
 * FetchURLTool — host-injected URL fetcher (Slice 3.5).
 *
 * Ports Python `kimi_cli/tools/web/fetch.py`. kimi-core defines the
 * interface; the host provides the real fetch implementation via
 * `UrlFetcher`. If no fetcher is supplied, the tool should not be
 * registered (not exposed to the LLM).
 */

import { z } from 'zod';

import type { ToolResult, ToolUpdate, ToolMetadata } from '../soul/types.js';
import type { BuiltinTool } from './types.js';

// ── Provider interface (host-injected) ───────────────────────────────

export interface UrlFetcher {
  fetch(url: string, options?: { format?: 'text' | 'markdown' }): Promise<string>;
}

// ── Input schema ─────────────────────────────────────────────────────

export interface FetchURLInput {
  url: string;
  format?: 'text' | 'markdown' | undefined;
}

const _rawFetchURLInputSchema = z.object({
  url: z.string().describe('The URL to fetch content from.'),
  format: z
    .enum(['text', 'markdown'])
    .optional()
    .default('text')
    .describe('The format of the returned content.'),
});

export const FetchURLInputSchema: z.ZodType<FetchURLInput> = _rawFetchURLInputSchema;

// ── Tool description ─────────────────────────────────────────────────

const DESCRIPTION =
  'Fetch content from a URL. Returns the main text content extracted from the page. ' +
  'Use this when you need to read a specific web page.';

// ── Implementation ───────────────────────────────────────────────────

export class FetchURLTool implements BuiltinTool<FetchURLInput, void> {
  readonly name = 'FetchURL' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description: string = DESCRIPTION;
  readonly inputSchema: z.ZodType<FetchURLInput> = FetchURLInputSchema;
  // Phase 15 L14 — idempotent URL fetch; safe to prefetch under streaming.
  readonly isConcurrencySafe = (_input: unknown): boolean => true;

  constructor(private readonly fetcher: UrlFetcher) {}

  async execute(
    _toolCallId: string,
    args: FetchURLInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<void>> {
    try {
      const opts: { format?: 'text' | 'markdown' } = {};
      if (args.format !== undefined) opts.format = args.format;
      const content = await this.fetcher.fetch(args.url, opts);

      if (!content) {
        return {
          content: 'The response body is empty.',
          isError: false,
        };
      }

      return { content, isError: false };
    } catch (error) {
      return {
        isError: true,
        content: `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  getActivityDescription(args: FetchURLInput): string {
    const preview = args.url.length > 50 ? `${args.url.slice(0, 50)}…` : args.url;
    return `Fetching: ${preview}`;
  }
}
