/**
 * Phase 19 Slice A — LocalFetchURLProvider behaviour tests.
 *
 * Ports Python `FetchURL.fetch_with_http_get` (kimi_cli/tools/web/fetch.py):
 *  - Content-Type `text/plain` or `text/markdown` → passthrough body
 *    verbatim (mirrors the Python short-circuit at
 *    search.py:77-79 → `builder.ok("The returned content is the full
 *    content of the page.")`).
 *  - Content-Type `text/html` → run readability/linkedom extraction
 *    and return main text (with title/description metadata visible).
 *  - HTTP >= 400 → throw with clear message + status.
 *  - Empty or non-extractable HTML → throw with "meaningful content"
 *    message (mirrors the Python error branch).
 *  - Body > maxBytes → reject without buffering everything into
 *    memory / emitting to the LLM.
 *  - Network failure / timeout → propagate as thrown Error.
 *
 * Implementation file does NOT exist yet — these tests are red until
 * `apps/kimi-cli/src/providers/local-fetch-url.ts` is written.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { UrlFetcher } from '@moonshot-ai/core';

import {
  LocalFetchURLProvider,
  type LocalFetchURLProviderOptions,
} from '../../src/providers/local-fetch-url.js';

// ── Helpers ──────────────────────────────────────────────────────────

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

function markdownResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
    ...init,
  });
}

function plainTextResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    ...init,
  });
}

function makeProvider(
  overrides: Partial<LocalFetchURLProviderOptions> = {},
): {
  provider: UrlFetcher;
  fetchImpl: ReturnType<typeof vi.fn>;
} {
  const fetchImpl = vi.fn();
  const provider = new LocalFetchURLProvider({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });
  return { provider, fetchImpl };
}

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sample Bug Report</title>
  <meta name="description" content="The default value should be lowercase.">
</head>
<body>
<article>
  <h1>Sample Bug Report</h1>
  <p>The default parameter value for <code>optimizer</code> should probably be
     <code>adamw</code> instead of <code>adamW</code>.</p>
</article>
</body>
</html>`;

// ── Content-type routing ────────────────────────────────────────────

describe('LocalFetchURLProvider — content-type routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns plain markdown bodies verbatim (no extraction)', async () => {
    const { provider, fetchImpl } = makeProvider();
    const markdown = '# Title\n\nThis is a markdown document.\n';
    fetchImpl.mockResolvedValue(markdownResponse(markdown));

    const out = await provider.fetch('https://example.com/doc.md');

    expect(out).toBe(markdown);
  });

  it('returns text/plain bodies verbatim', async () => {
    const { provider, fetchImpl } = makeProvider();
    const body = 'just plain text, nothing fancy';
    fetchImpl.mockResolvedValue(plainTextResponse(body));

    const out = await provider.fetch('https://example.com/doc.txt');

    expect(out).toBe(body);
  });

  it('extracts main text content from HTML (not raw HTML tags)', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockResolvedValue(htmlResponse(SAMPLE_HTML));

    const out = await provider.fetch('https://example.com/bug-report.html');

    // Core article text present.
    expect(out).toContain('optimizer');
    expect(out).toContain('adamw');
    expect(out).toContain('adamW');
    // Raw HTML tags should NOT leak through.
    expect(out).not.toMatch(/<article\b/);
    expect(out).not.toMatch(/<code\b/);
    expect(out).not.toMatch(/<!DOCTYPE/i);
  });
});

// ── Request construction ────────────────────────────────────────────

describe('LocalFetchURLProvider — request construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends GET to the target URL with a Chrome-like User-Agent by default', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockResolvedValue(markdownResponse('# ok'));

    await provider.fetch('https://example.com/page');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('https://example.com/page');
    // Python default (fetch.py) is `Mozilla/5.0 ... Chrome/...` — TS should mirror.
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    const ua = headers.get('user-agent') ?? '';
    expect(ua).toMatch(/Mozilla|Chrome/);
    // Default is GET (we're not POSTing to a third-party host).
    expect(init?.method === undefined || init?.method === 'GET').toBe(true);
  });

  it('honours a caller-provided userAgent override', async () => {
    const { provider, fetchImpl } = makeProvider({ userAgent: 'kimi-cli-local/0.0.1' });
    fetchImpl.mockResolvedValue(markdownResponse('# ok'));

    await provider.fetch('https://example.com/');

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    expect(headers.get('user-agent')).toBe('kimi-cli-local/0.0.1');
  });
});

// ── Error paths ─────────────────────────────────────────────────────

describe('LocalFetchURLProvider — error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws with a clear message when HTTP status >= 400', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockResolvedValue(
      new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    );

    await expect(provider.fetch('https://example.com/missing')).rejects.toThrow(/404/);
  });

  it('throws on 500-class errors with the status in the message', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockResolvedValue(
      new Response('oops', { status: 502, headers: { 'content-type': 'text/plain' } }),
    );

    await expect(provider.fetch('https://example.com/down')).rejects.toThrow(/502/);
  });

  it('throws when HTML has no extractable meaningful content', async () => {
    const { provider, fetchImpl } = makeProvider();
    // Empty HTML shell — no article, no headings, no prose.
    fetchImpl.mockResolvedValue(
      htmlResponse('<!DOCTYPE html><html><head></head><body></body></html>'),
    );

    await expect(provider.fetch('https://example.com/empty')).rejects.toThrow(
      /meaningful content|extract/i,
    );
  });

  it('throws when the response body exceeds maxBytes', async () => {
    const { provider, fetchImpl } = makeProvider({ maxBytes: 1024 });
    const bigBody = 'x'.repeat(1024 * 200); // 200 KB, well past maxBytes
    fetchImpl.mockResolvedValue(
      new Response(bigBody, {
        status: 200,
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-length': String(bigBody.length),
        },
      }),
    );

    await expect(provider.fetch('https://example.com/big')).rejects.toThrow(
      /too large|maxBytes|size|exceed/i,
    );
  });

  it('propagates network errors (fetch rejection / timeout)', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(provider.fetch('https://example.com/')).rejects.toThrow(
      /ECONNREFUSED|network|fetch/i,
    );
  });

  it('throws on malformed / invalid URLs (fetch rejects)', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockRejectedValue(new TypeError('Invalid URL'));

    await expect(provider.fetch('not-a-valid-url')).rejects.toThrow(/invalid|url|fetch/i);
  });
});
