/**
 * Phase 19 Slice A — MoonshotFetchURLProvider behaviour tests.
 *
 * Ports Python FetchURL._fetch_with_service + service-fail fallback
 * logic (kimi_cli/tools/web/fetch.py):
 *  - Moonshot succeeds (200) → return its markdown body.
 *  - Moonshot returns non-200 OR throws → delegate to `localFallback`.
 *  - Both fail → propagate error (outer FetchURLTool renders it).
 *  - Request shape: POST, Bearer, Accept: text/markdown, body {url},
 *    X-Msh-* device headers.
 *
 * Implementation does not exist yet — imports intentionally unresolved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { OAuthManager, UrlFetcher } from '@moonshot-ai/core';

import {
  MoonshotFetchURLProvider,
  type MoonshotFetchURLProviderOptions,
} from '../../src/providers/moonshot-fetch-url.js';

// ── Helpers ──────────────────────────────────────────────────────────

function mockOAuthManager(token = 'test-access-token'): OAuthManager {
  return {
    ensureFresh: vi.fn().mockResolvedValue(token),
  } as unknown as OAuthManager;
}

function mockLocalFallback(
  fetchFn?: (url: string, options?: { format?: 'text' | 'markdown' }) => Promise<string>,
): UrlFetcher & { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(fetchFn ?? (async () => 'fallback-content')),
  };
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
    ...init,
  });
}

interface Harness {
  provider: UrlFetcher;
  fetchImpl: ReturnType<typeof vi.fn>;
  localFallback: ReturnType<typeof mockLocalFallback>;
  oauth: OAuthManager;
}

function makeProvider(overrides: Partial<MoonshotFetchURLProviderOptions> = {}): Harness {
  const fetchImpl = vi.fn();
  const oauth = overrides.oauthManager ?? mockOAuthManager();
  const localFallback = (overrides.localFallback as ReturnType<typeof mockLocalFallback>) ??
    mockLocalFallback();
  const provider = new MoonshotFetchURLProvider({
    oauthManager: oauth,
    baseUrl: 'https://api.kimi.com/coding/v1/fetch',
    userAgent: 'kimi-cli/0.0.1-test',
    localFallback,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });
  return { provider, fetchImpl, localFallback, oauth };
}

// ── Happy path (Moonshot service succeeds) ──────────────────────────

describe('MoonshotFetchURLProvider — Moonshot service succeeds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the markdown body from the Moonshot fetch service', async () => {
    const { provider, fetchImpl, localFallback } = makeProvider();
    const markdown = '# Hello\n\nThis is the main article.\n';
    fetchImpl.mockResolvedValue(textResponse(markdown));

    const out = await provider.fetch('https://example.com/article');

    expect(out).toBe(markdown);
    expect(localFallback.fetch).not.toHaveBeenCalled();
  });

  it('does NOT call localFallback when Moonshot returns 200', async () => {
    const { provider, fetchImpl, localFallback } = makeProvider();
    fetchImpl.mockResolvedValue(textResponse('ok'));

    await provider.fetch('https://example.com/');

    expect(localFallback.fetch).not.toHaveBeenCalled();
  });
});

// ── Request construction ────────────────────────────────────────────

describe('MoonshotFetchURLProvider — request construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts to baseUrl with Bearer token, Accept: text/markdown, UA and X-Msh-* headers', async () => {
    const oauth = mockOAuthManager('secret-token-abc');
    const { provider, fetchImpl } = makeProvider({ oauthManager: oauth });
    fetchImpl.mockResolvedValue(textResponse('ok'));

    await provider.fetch('https://example.com/doc');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://api.kimi.com/coding/v1/fetch');
    expect(init.method).toBe('POST');

    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer secret-token-abc');
    expect(headers.get('accept')).toMatch(/text\/markdown/);
    expect(headers.get('user-agent')).toBe('kimi-cli/0.0.1-test');
    expect(headers.get('x-msh-platform')).toBe('kimi_cli');
    expect(headers.get('x-msh-device-id')).toBeTruthy();

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ url: 'https://example.com/doc' });
  });
});

// ── Fallback on service failure ─────────────────────────────────────

describe('MoonshotFetchURLProvider — fallback on Moonshot failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to localFallback when Moonshot returns non-200', async () => {
    const { provider, fetchImpl, localFallback } = makeProvider();
    fetchImpl.mockResolvedValue(
      new Response('service unavailable', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    localFallback.fetch.mockResolvedValue('local-extracted-text');

    const out = await provider.fetch('https://example.com/article');

    expect(out).toBe('local-extracted-text');
    expect(localFallback.fetch).toHaveBeenCalledTimes(1);
    expect(localFallback.fetch).toHaveBeenCalledWith(
      'https://example.com/article',
      expect.anything(),
    );
  });

  it('delegates to localFallback when Moonshot fetch implementation throws', async () => {
    const { provider, fetchImpl, localFallback } = makeProvider();
    fetchImpl.mockRejectedValue(new Error('ECONNRESET'));
    localFallback.fetch.mockResolvedValue('fallback-body');

    const out = await provider.fetch('https://example.com/');

    expect(out).toBe('fallback-body');
    expect(localFallback.fetch).toHaveBeenCalled();
  });

  it('delegates to localFallback when OAuth manager has no token', async () => {
    const oauth = {
      ensureFresh: vi.fn().mockRejectedValue(new Error('No token — run /login')),
    } as unknown as OAuthManager;
    const { provider, fetchImpl, localFallback } = makeProvider({ oauthManager: oauth });
    localFallback.fetch.mockResolvedValue('local-only');

    const out = await provider.fetch('https://example.com/');

    expect(out).toBe('local-only');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(localFallback.fetch).toHaveBeenCalled();
  });

  it('propagates the localFallback error when both Moonshot AND localFallback fail', async () => {
    const { provider, fetchImpl, localFallback } = makeProvider();
    fetchImpl.mockResolvedValue(
      new Response('bad gateway', { status: 502, headers: { 'content-type': 'text/plain' } }),
    );
    localFallback.fetch.mockRejectedValue(new Error('local extract failed: no content'));

    await expect(provider.fetch('https://example.com/dead-site')).rejects.toThrow(
      /local extract failed|no content/i,
    );
    expect(localFallback.fetch).toHaveBeenCalled();
  });
});

// ── 401 force-refresh retry (Phase 19 deep-review HIGH-4) ──────────

describe('MoonshotFetchURLProvider — 401 auto-refresh retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries Moonshot with force-refresh when the first call returns 401', async () => {
    const ensureFresh = vi
      .fn()
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('fresh-token');
    const oauth = { ensureFresh } as unknown as OAuthManager;
    const fetchImpl = vi.fn();
    fetchImpl
      .mockResolvedValueOnce(
        new Response('stale', { status: 401, headers: { 'content-type': 'text/plain' } }),
      )
      .mockResolvedValueOnce(textResponse('# fresh'));
    const localFallback = mockLocalFallback();
    const provider = new MoonshotFetchURLProvider({
      oauthManager: oauth,
      baseUrl: 'https://api.kimi.com/coding/v1/fetch',
      userAgent: 'kimi-cli/0.0.1-test',
      localFallback,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const out = await provider.fetch('https://example.com/article');

    expect(out).toBe('# fresh');
    expect(ensureFresh).toHaveBeenCalledTimes(2);
    expect(ensureFresh).toHaveBeenNthCalledWith(2, { force: true });
    expect(localFallback.fetch).not.toHaveBeenCalled();
  });

  it('falls back to local fetcher when force-refresh retry still gives 401', async () => {
    const ensureFresh = vi.fn().mockResolvedValue('always-stale');
    const oauth = { ensureFresh } as unknown as OAuthManager;
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValue(
      new Response('unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } }),
    );
    const localFallback = mockLocalFallback();
    localFallback.fetch.mockResolvedValue('from-local');
    const provider = new MoonshotFetchURLProvider({
      oauthManager: oauth,
      baseUrl: 'https://api.kimi.com/coding/v1/fetch',
      userAgent: 'kimi-cli/0.0.1-test',
      localFallback,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const out = await provider.fetch('https://example.com/x');

    // Moonshot: 2 attempts (normal + force). Both failed → fallback.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out).toBe('from-local');
    expect(localFallback.fetch).toHaveBeenCalledTimes(1);
  });
});
