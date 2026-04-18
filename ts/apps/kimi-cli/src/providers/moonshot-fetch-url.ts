/**
 * MoonshotFetchURLProvider — host-side UrlFetcher (Phase 19 Slice A).
 *
 * Ports Python `FetchURL._fetch_with_service` (kimi_cli/tools/web/fetch.py).
 * Flow:
 *   1. Try Moonshot coding-fetch service (POST {url}, Bearer token,
 *      Accept: text/markdown, device headers).
 *   2. Moonshot 200 → return body verbatim (it already arrives as
 *      markdown text extracted by the server).
 *   3. Any Moonshot failure — non-200, network error, or token
 *      refresh failure — → delegate to `localFallback` so the LLM
 *      still gets *something* when the service is down.
 *   4. If localFallback also throws → propagate that error.
 */

import {
  getDeviceHeaders,
  type OAuthManager,
  type UrlFetcher,
} from '@moonshot-ai/core';

export interface MoonshotFetchURLProviderOptions {
  oauthManager: OAuthManager;
  baseUrl: string;
  userAgent: string;
  localFallback: UrlFetcher;
  fetchImpl?: typeof fetch;
}

export class MoonshotFetchURLProvider implements UrlFetcher {
  private readonly oauthManager: OAuthManager;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly localFallback: UrlFetcher;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MoonshotFetchURLProviderOptions) {
    this.oauthManager = options.oauthManager;
    this.baseUrl = options.baseUrl;
    this.userAgent = options.userAgent;
    this.localFallback = options.localFallback;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async fetch(
    url: string,
    options?: { format?: 'text' | 'markdown' },
  ): Promise<string> {
    try {
      return await this.fetchViaMoonshot(url);
    } catch {
      // Forward an explicit options object even when the caller passed
      // none, so downstream consumers always see a defined second arg.
      return this.localFallback.fetch(url, options ?? {});
    }
  }

  private async fetchViaMoonshot(url: string): Promise<string> {
    const bodyJson = JSON.stringify({ url });

    // Mirror MoonshotWebSearchProvider: retry once with `force: true` if
    // the cached OAuth token is rejected, since this provider doesn't
    // sit behind KosongAdapter's 401 refresh layer.
    let response = await this.post(bodyJson, false);
    if (response.status === 401) {
      // Drain the failed body so undici can reuse the socket.
      try { await response.text(); } catch { /* ignore */ }
      response = await this.post(bodyJson, true);
    }

    if (response.status !== 200) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore — status code alone is informative enough for the
        // fallback path that catches this.
      }
      throw new Error(
        `Moonshot fetch request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
      );
    }

    return response.text();
  }

  private async post(bodyJson: string, forceRefresh: boolean): Promise<Response> {
    const accessToken = await this.oauthManager.ensureFresh(
      forceRefresh ? { force: true } : {},
    );
    return this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'text/markdown',
        'User-Agent': this.userAgent,
        'Content-Type': 'application/json',
        ...getDeviceHeaders(),
      },
      body: bodyJson,
    });
  }
}
