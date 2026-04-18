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

// ── SSRF guard (Phase 19 deep-review HIGH-3) ────────────────────────

describe('LocalFetchURLProvider — SSRF guard (default deny)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses AWS/GCP/Azure metadata service (169.254.169.254)', async () => {
    const { provider, fetchImpl } = makeProvider();
    await expect(
      provider.fetch('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow(/private/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses loopback 127.0.0.1 and localhost', async () => {
    const { provider, fetchImpl } = makeProvider();
    await expect(provider.fetch('http://127.0.0.1:6379/')).rejects.toThrow(/private/i);
    await expect(provider.fetch('http://localhost/admin')).rejects.toThrow(/private/i);
    await expect(provider.fetch('http://my.localhost/x')).rejects.toThrow(/private/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses RFC 1918 ranges 10.x / 192.168.x / 172.16-31.x', async () => {
    const { provider } = makeProvider();
    await expect(provider.fetch('http://10.0.0.1/')).rejects.toThrow(/private/i);
    await expect(provider.fetch('http://192.168.1.1/admin')).rejects.toThrow(/private/i);
    await expect(provider.fetch('http://172.16.0.1/')).rejects.toThrow(/private/i);
    await expect(provider.fetch('http://172.31.255.255/')).rejects.toThrow(/private/i);
  });

  it('accepts 172.15.x and 172.32.x (outside private range)', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl
      .mockResolvedValueOnce(new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
    await expect(provider.fetch('http://172.15.1.1/')).resolves.toBe('ok');
    await expect(provider.fetch('http://172.32.1.1/')).resolves.toBe('ok');
  });

  it('refuses IPv6 loopback / ULA / link-local', async () => {
    const { provider } = makeProvider();
    await expect(provider.fetch('http://[::1]/')).rejects.toThrow(/private/i);
    await expect(provider.fetch('http://[fe80::1]/')).rejects.toThrow(/private/i);
    await expect(provider.fetch('http://[fc00::1]/')).rejects.toThrow(/private/i);
    await expect(provider.fetch('http://[fd00::1]/')).rejects.toThrow(/private/i);
  });

  it('refuses non-http schemes (file, ftp, etc.)', async () => {
    const { provider, fetchImpl } = makeProvider();
    await expect(provider.fetch('file:///etc/passwd')).rejects.toThrow(/scheme/i);
    await expect(provider.fetch('ftp://example.com/')).rejects.toThrow(/scheme/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts public https domains', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl
      .mockResolvedValueOnce(markdownResponse('# ok'))
      .mockResolvedValueOnce(markdownResponse('# ok'));
    await provider.fetch('https://example.com/');
    await provider.fetch('https://docs.python.org/3/');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honours allowPrivateAddresses opt-in (for tests / explicit use)', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValue(markdownResponse('# ok'));
    const provider = new LocalFetchURLProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowPrivateAddresses: true,
    });
    await expect(provider.fetch('http://127.0.0.1:3000/health')).resolves.toBe('# ok');
  });
});

// ── Body-drain on error (Phase 19 deep-review HIGH-1) ──────────────

describe('LocalFetchURLProvider — body drain on error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels response.body when HTTP >= 400 (avoids socket leak)', async () => {
    const { provider, fetchImpl } = makeProvider();
    const cancel = vi.fn(() => Promise.resolve());
    const response = new Response('not found', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    });
    // Stub the body.cancel so we can observe it being called.
    Object.defineProperty(response, 'body', {
      value: { cancel },
      configurable: true,
    });
    fetchImpl.mockResolvedValue(response);

    await expect(provider.fetch('https://example.com/404')).rejects.toThrow(/404/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
