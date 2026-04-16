/**
 * Stub UrlFetcher (Slice 4.3 Part 3).
 *
 * Mirrors {@link StubWebSearchProvider}: the real fetcher is the
 * Moonshot Coding fetch service configured via
 * `[services.moonshot_fetch]`, which uses OAuth and is therefore
 * deferred to Phase 5. Slice 4.3 ships a stub so the FetchURL tool
 * stays registered but returns a clear "not configured" error until
 * OAuth lands.
 */

import type { UrlFetcher } from '@moonshot-ai/core';

export class StubUrlFetcher implements UrlFetcher {
  async fetch(_url: string): Promise<string> {
    throw new Error(
      'URL fetching is not yet available: the Moonshot fetch service requires OAuth credentials, ' +
        'which will be wired up in Phase 5.',
    );
  }
}
