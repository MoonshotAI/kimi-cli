/**
 * LocalFetchURLProvider — host-side URL fetcher (Phase 19 Slice A).
 *
 * Ports Python `FetchURL.fetch_with_http_get` (kimi_cli/tools/web/fetch.py).
 * Flow:
 *   1. GET the URL with a Chrome-like UA.
 *   2. Reject HTTP >= 400 with the status code in the message.
 *   3. Reject responses larger than `maxBytes` (content-length first,
 *      then measured body length as a defensive second check).
 *   4. `text/plain` / `text/markdown` → passthrough verbatim.
 *   5. Otherwise (assumed HTML) → run Readability over a linkedom
 *      document. Return `# ${title}\n\n${text}` (title omitted when
 *      absent). If extraction yields no meaningful text, fall back to
 *      common content containers (`<article>` / `<main>` / `<body>`)
 *      before throwing a "meaningful content" error.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML as rawParseHTML } from 'linkedom';

import type { UrlFetcher } from '@moonshot-ai/core';

// Readability's .d.ts references the global `Document` type, but this
// package compiles with `lib: ES2023` (no DOM). Extracting the
// constructor parameter type keeps us off the global `Document` name
// while still accepting whatever Readability wants.
type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

// linkedom's published types depend on DOM libs we don't load. Declare
// the minimal surface we actually use so the rest of the file stays
// type-safe without pulling lib.dom.d.ts into the host build.
interface DomElementLike {
  textContent: string | null;
  querySelector(selector: string): DomElementLike | null;
}
interface DomParseResult {
  document: DomElementLike;
}
const parseHTML = rawParseHTML as unknown as (html: string) => DomParseResult;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface LocalFetchURLProviderOptions {
  userAgent?: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  /**
   * Allow fetching loopback / RFC 1918 / link-local / ULA addresses.
   * Defaults to `false` — enabled only for tests and (future) explicit
   * opt-in. Keeps an LLM that's been prompt-injected from exfiltrating
   * AWS/GCP metadata (169.254.169.254), probing internal services
   * (10.x, 192.168.x), or reading local daemons (127.0.0.1:*).
   */
  allowPrivateAddresses?: boolean;
}

/**
 * SSRF guard — reject non-http(s) schemes and (by default) any hostname
 * that is, or parses as, a private / loopback / link-local / ULA IP
 * literal. This is a *static* check against the URL string; it does NOT
 * do DNS resolution, so a domain that resolves to a private IP via
 * DNS-rebinding is **not** caught here. That attack is a known
 * limitation; mitigations (e.g. pinning the resolved IP through to
 * fetch) are left for a follow-up.
 */
function assertSafeFetchTarget(url: string, allowPrivate: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Unsupported URL scheme "${parsed.protocol}" — only http(s) allowed.`,
    );
  }
  if (allowPrivate) return;
  // URL hostname preserves surrounding `[ ]` for IPv6 literals on some
  // Node versions (and not others). Strip them for uniform comparison.
  const hostRaw = parsed.hostname.toLowerCase();
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']')
    ? hostRaw.slice(1, -1)
    : hostRaw;
  // Literal "localhost" / loopback aliases.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`Refusing to fetch private host: "${host}"`);
  }
  // IPv6 loopback / ULA / link-local. Check after bracket strip.
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    throw new Error(`Refusing to fetch private host: "${host}"`);
  }
  // IPv4 literal — only check when the hostname is a dotted-quad; normal
  // domains will never match.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const octets = [v4[1], v4[2], v4[3], v4[4]].map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error(`Invalid IPv4 literal: "${host}"`);
    }
    const [a, b] = octets as [number, number, number, number];
    // 127.0.0.0/8 loopback, 10.0.0.0/8, 192.168.0.0/16,
    // 172.16.0.0/12, 169.254.0.0/16 link-local / AWS metadata,
    // 0.0.0.0/8 "this network", 100.64.0.0/10 CGNAT.
    const isLoopback = a === 127;
    const isPrivate10 = a === 10;
    const isPrivate192 = a === 192 && b === 168;
    const isPrivate172 = a === 172 && b >= 16 && b <= 31;
    const isLinkLocal = a === 169 && b === 254;
    const isZero = a === 0;
    const isCgnat = a === 100 && b >= 64 && b <= 127;
    if (
      isLoopback || isPrivate10 || isPrivate192 || isPrivate172 ||
      isLinkLocal || isZero || isCgnat
    ) {
      throw new Error(`Refusing to fetch private address: "${host}"`);
    }
  }
}

export class LocalFetchURLProvider implements UrlFetcher {
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly allowPrivateAddresses: boolean;

  constructor(options: LocalFetchURLProviderOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
  }

  async fetch(
    url: string,
    _options?: { format?: 'text' | 'markdown' },
  ): Promise<string> {
    assertSafeFetchTarget(url, this.allowPrivateAddresses);

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': this.userAgent },
    });

    if (response.status >= 400) {
      // Drain the unused body so undici can release the socket back to
      // the keep-alive pool instead of leaking it on error paths.
      await response.body?.cancel().catch(() => { /* already closed */ });
      throw new Error(
        `Failed to fetch URL. HTTP ${response.status} ${response.statusText}.`,
      );
    }

    // Reject oversized responses before buffering the full body.
    const contentLengthRaw = response.headers.get('content-length');
    if (contentLengthRaw !== null) {
      const cl = Number(contentLengthRaw);
      if (Number.isFinite(cl) && cl > this.maxBytes) {
        throw new Error(
          `Response body too large: ${String(cl)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
        );
      }
    }

    const body = await response.text();

    // Servers may omit content-length — measure again defensively.
    const actualBytes = Buffer.byteLength(body, 'utf8');
    if (actualBytes > this.maxBytes) {
      throw new Error(
        `Response body too large: ${String(actualBytes)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
      );
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('text/plain') || contentType.startsWith('text/markdown')) {
      return body;
    }

    return this.extractMainContent(body);
  }

  private extractMainContent(html: string): string {
    // Readability mutates the DOM it parses, so parse twice — once for
    // the primary extractor and once for the fallback path.
    const primary = parseHTML(html);
    try {
      const reader = new Readability(primary.document as unknown as ReadabilityDocument, {
        charThreshold: 0,
      });
      const article = reader.parse();
      if (article !== null) {
        const text = (article.textContent ?? '').trim();
        if (text.length > 0) {
          const title = (article.title ?? '').trim();
          return title.length > 0 ? `# ${title}\n\n${text}` : text;
        }
      }
    } catch {
      // Fall through to the container-based fallback.
    }

    const { document } = parseHTML(html);
    const titleText = (document.querySelector('title')?.textContent ?? '').trim();
    const container =
      document.querySelector('article') ??
      document.querySelector('main') ??
      document.querySelector('body');
    const fallbackText = (container?.textContent ?? '').trim();

    if (fallbackText.length === 0) {
      throw new Error(
        'Failed to extract meaningful content from the page. The page may require JavaScript to render.',
      );
    }

    return titleText.length > 0 ? `# ${titleText}\n\n${fallbackText}` : fallbackText;
  }
}
