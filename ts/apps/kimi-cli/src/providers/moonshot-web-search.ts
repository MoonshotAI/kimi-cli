/**
 * MoonshotWebSearchProvider — host-side WebSearchProvider (Phase 19 Slice A).
 *
 * Ports Python `kimi_cli/tools/web/search.py::SearchWeb` to the TS
 * `WebSearchProvider` interface. Auth uses an `OAuthManager.ensureFresh()`
 * call per request (manager caches/refreshes the access token on its own);
 * device headers come from `getDeviceHeaders()` so the Moonshot coding
 * service can correlate activity between Python and TS clients.
 */

import {
  getDeviceHeaders,
  type OAuthManager,
  type WebSearchProvider,
  type WebSearchResult,
} from '@moonshot-ai/core';

export interface MoonshotWebSearchProviderOptions {
  oauthManager: OAuthManager;
  baseUrl: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

interface MoonshotSearchResult {
  site_name?: string;
  title?: string;
  url?: string;
  snippet?: string;
  content?: string;
  date?: string;
  icon?: string;
  mime?: string;
}

interface MoonshotSearchResponse {
  search_results?: MoonshotSearchResult[];
}

export class MoonshotWebSearchProvider implements WebSearchProvider {
  private readonly oauthManager: OAuthManager;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MoonshotWebSearchProviderOptions) {
    this.oauthManager = options.oauthManager;
    this.baseUrl = options.baseUrl;
    this.userAgent = options.userAgent;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean },
  ): Promise<WebSearchResult[]> {
    const body = {
      text_query: query,
      limit: options?.limit ?? 5,
      enable_page_crawling: options?.includeContent ?? false,
      timeout_seconds: 30,
    };
    const bodyJson = JSON.stringify(body);

    // Kosong's ChatProvider has a token-refresher layer that transparently
    // retries 401s (see KosongAdapter). This provider runs outside that
    // layer, so if the cached token is stale (server-side revocation, a
    // `expiresAt` skew, etc.) the user would otherwise see a bare
    // `HTTP 401` with no hint that `kimi login` fixes it. Try once with a
    // forced refresh before surfacing the auth error.
    let response = await this.post(bodyJson, false);
    if (response.status === 401) {
      // Drain the failed body so undici can reuse the socket.
      await safeReadText(response);
      response = await this.post(bodyJson, true);
    }

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error(
        `Moonshot search request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim(),
      );
    }

    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error(
        `Moonshot search request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
      );
    }

    const json = (await response.json()) as MoonshotSearchResponse;
    const raw = Array.isArray(json.search_results) ? json.search_results : [];

    return raw.map((r): WebSearchResult => {
      const out: WebSearchResult = {
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.snippet ?? '',
      };
      if (typeof r.date === 'string' && r.date.length > 0) out.date = r.date;
      if (typeof r.content === 'string' && r.content.length > 0) out.content = r.content;
      return out;
    });
  }

  private async post(bodyJson: string, forceRefresh: boolean): Promise<Response> {
    const accessToken = await this.oauthManager.ensureFresh(
      forceRefresh ? { force: true } : {},
    );
    return this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': this.userAgent,
        'Content-Type': 'application/json',
        ...getDeviceHeaders(),
      },
      body: bodyJson,
    });
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
