/**
 * Phase 19 Slice A — MoonshotWebSearchProvider behaviour tests.
 *
 * Ports the Python SearchWeb coverage (kimi_cli/tools/web/search.py):
 *  - Happy path: forward Moonshot coding search responses to
 *    `WebSearchResult[]` (mirrors Response.search_results → builder).
 *  - Request shape: POST, Bearer token from OAuth manager, X-Msh-*
 *    device headers (via getDeviceHeaders), body
 *    `{text_query, limit, enable_page_crawling, timeout_seconds: 30}`.
 *  - Error mapping: non-200 / 401 / network errors surface as thrown
 *    errors that include status + response text so the outer
 *    `WebSearchTool.execute` catch can render a clear message.
 *
 * The implementation file does not exist yet — these tests are
 * intentionally red until `apps/kimi-cli/src/providers/moonshot-web-search.ts`
 * ships.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { OAuthManager, WebSearchProvider } from '@moonshot-ai/core';

// NOTE: provider file does not exist yet — tests intentionally fail to import.
import {
  MoonshotWebSearchProvider,
  type MoonshotWebSearchProviderOptions,
} from '../../src/providers/moonshot-web-search.js';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal OAuthManager double. `ensureFresh()` returns the
 * access-token string directly (see OAuthManager.ensureFresh signature
 * in packages/kimi-core/src/auth/oauth-manager.ts — it resolves to
 * `Promise<string>`, NOT `Promise<TokenInfo>`, contrary to the task
 * brief's shorthand description).
 */
function mockOAuthManager(token = 'test-access-token'): OAuthManager {
  return {
    ensureFresh: vi.fn().mockResolvedValue(token),
  } as unknown as OAuthManager;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeProvider(
  overrides: Partial<MoonshotWebSearchProviderOptions> = {},
): {
  provider: WebSearchProvider;
  fetchImpl: ReturnType<typeof vi.fn>;
  oauth: OAuthManager;
} {
  const fetchImpl = vi.fn();
  const oauth = overrides.oauthManager ?? mockOAuthManager();
  const provider = new MoonshotWebSearchProvider({
    oauthManager: oauth,
    baseUrl: 'https://api.kimi.com/coding/v1/search',
    userAgent: 'kimi-cli/0.0.1-test',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });
  return { provider, fetchImpl, oauth };
}

// ── Happy path ───────────────────────────────────────────────────────

describe('MoonshotWebSearchProvider — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns WebSearchResult[] when Moonshot responds with search_results', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockResolvedValue(
      jsonResponse({
        search_results: [
          {
            site_name: 'example.com',
            title: 'TypeScript Docs',
            url: 'https://example.com/ts',
            snippet: 'Intro to TS',
            content: 'full body here',
            date: '2026-04-01',
            icon: '',
            mime: 'text/html',
          },
          {
            site_name: 'docs.rs',
            title: 'Rust book',
            url: 'https://docs.rs/book',
            snippet: 'Rust snippet',
            content: '',
            date: '',
            icon: '',
            mime: '',
          },
        ],
      }),
    );

    const results = await provider.search('hello world', { limit: 5, includeContent: true });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'TypeScript Docs',
      url: 'https://example.com/ts',
      snippet: 'Intro to TS',
      date: '2026-04-01',
      content: 'full body here',
    });
    expect(results[1]).toMatchObject({
      title: 'Rust book',
      url: 'https://docs.rs/book',
      snippet: 'Rust snippet',
    });
  });

  it('returns an empty array when search_results is empty', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockResolvedValue(jsonResponse({ search_results: [] }));

    const results = await provider.search('query that matches nothing');

    expect(results).toEqual([]);
  });
});

// ── Request construction ────────────────────────────────────────────

describe('MoonshotWebSearchProvider — request construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts to baseUrl with Bearer token, UA, and X-Msh-* device headers', async () => {
    const oauth = mockOAuthManager('secret-token-123');
    const { provider, fetchImpl } = makeProvider({ oauthManager: oauth });
    fetchImpl.mockResolvedValue(jsonResponse({ search_results: [] }));

    await provider.search('typescript tutorials');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://api.kimi.com/coding/v1/search');
    expect(init.method).toBe('POST');

    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer secret-token-123');
    expect(headers.get('user-agent')).toBe('kimi-cli/0.0.1-test');
    // X-Msh-* device headers must be present (via getDeviceHeaders()).
    expect(headers.get('x-msh-platform')).toBe('kimi_cli');
    expect(headers.get('x-msh-device-id')).toBeTruthy();
    expect(headers.get('x-msh-version')).toBeTruthy();

    expect(oauth.ensureFresh).toHaveBeenCalled();
  });

  it('defaults body to {limit:5, enable_page_crawling:false, timeout_seconds:30} when no options given', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockResolvedValue(jsonResponse({ search_results: [] }));

    await provider.search('default case');

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      text_query: 'default case',
      timeout_seconds: 30,
    });
    expect(body['limit']).toBe(5);
    expect(body['enable_page_crawling']).toBe(false);
  });

  it('maps options.limit → body.limit and options.includeContent → body.enable_page_crawling', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockResolvedValue(jsonResponse({ search_results: [] }));

    await provider.search('ts generics', { limit: 12, includeContent: true });

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      text_query: 'ts generics',
      limit: 12,
      enable_page_crawling: true,
      timeout_seconds: 30,
    });
  });

  it('sets content-type JSON and serialises body as JSON string', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockResolvedValue(jsonResponse({ search_results: [] }));

    await provider.search('hello');

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('content-type')).toMatch(/application\/json/);
    expect(typeof init.body).toBe('string');
    // valid JSON:
    expect(() => {
      JSON.parse(init.body as string);
    }).not.toThrow();
  });
});

// ── Error paths ─────────────────────────────────────────────────────

describe('MoonshotWebSearchProvider — error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws an error that mentions the HTTP status on non-200 responses', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockResolvedValue(
      new Response('internal error trace', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    await expect(provider.search('q')).rejects.toThrow(/500/);
  });

  it('throws an auth-specific error on 401 (distinct from generic network error)', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockResolvedValue(
      new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    // Caller should be able to distinguish auth failure from generic network
    // failure — either via error type or explicit mention of auth/401.
    const err = await provider.search('q').then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/401|auth|unauthori[sz]ed/i);
  });

  it('propagates (throws) when the fetch implementation rejects (network error / timeout)', async () => {
    const { provider, fetchImpl } = makeProvider();
    fetchImpl.mockRejectedValue(new Error('ECONNRESET'));

    await expect(provider.search('q')).rejects.toThrow(/ECONNRESET|network|fetch/i);
  });

  it('throws when OAuth manager cannot refresh (no token)', async () => {
    const oauth = {
      ensureFresh: vi.fn().mockRejectedValue(new Error('No token — run /login')),
    } as unknown as OAuthManager;
    const { provider, fetchImpl } = makeProvider({ oauthManager: oauth });

    await expect(provider.search('q')).rejects.toThrow(/token|login/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ── 401 force-refresh retry (Phase 19 deep-review HIGH-4) ──────────

describe('MoonshotWebSearchProvider — 401 auto-refresh retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries with force-refresh when the first call gets 401', async () => {
    const ensureFresh = vi
      .fn()
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('fresh-token');
    const oauth = { ensureFresh } as unknown as OAuthManager;
    const fetchImpl = vi.fn();
    // First: 401 with cached token. Second: 200 after force-refresh.
    fetchImpl
      .mockResolvedValueOnce(
        new Response('stale', { status: 401, headers: { 'content-type': 'text/plain' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ search_results: [] }));
    const provider = new MoonshotWebSearchProvider({
      oauthManager: oauth,
      baseUrl: 'https://api.kimi.com/coding/v1/search',
      userAgent: 'kimi-cli/0.0.1-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const results = await provider.search('q');

    expect(results).toEqual([]);
    expect(ensureFresh).toHaveBeenCalledTimes(2);
    expect(ensureFresh).toHaveBeenNthCalledWith(1, {});
    expect(ensureFresh).toHaveBeenNthCalledWith(2, { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Second call used the refreshed token.
    const secondInit = fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined;
    const secondHeaders = new Headers(
      (secondInit?.headers ?? {}) as Record<string, string>,
    );
    expect(secondHeaders.get('authorization')).toBe('Bearer fresh-token');
  });

  it('still throws a 401 error if the force-refresh retry also fails', async () => {
    const ensureFresh = vi.fn().mockResolvedValue('always-stale');
    const oauth = { ensureFresh } as unknown as OAuthManager;
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValue(
      new Response('still unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } }),
    );
    const provider = new MoonshotWebSearchProvider({
      oauthManager: oauth,
      baseUrl: 'https://api.kimi.com/coding/v1/search',
      userAgent: 'kimi-cli/0.0.1-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.search('q')).rejects.toThrow(/401|auth|unauthori[sz]ed/i);
    expect(ensureFresh).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
