/**
 * Stub WebSearchProvider (Slice 4.3 Part 3).
 *
 * The real provider is the Moonshot Coding search service at
 * `https://api.kimi.com/coding/v1/search`, configured via
 * `[services.moonshot_search]` in `~/.kimi/config.toml`. That service
 * authenticates via OAuth which is not implemented until Phase 5, so
 * Slice 4.3 ships a stub that surfaces a clear "not configured" error
 * to the LLM. The tool stays registered so agents see the schema but
 * the call itself always reports failure with an actionable reason.
 */

import type { WebSearchProvider, WebSearchResult } from '@moonshot-ai/core';

export class StubWebSearchProvider implements WebSearchProvider {
  async search(_query: string): Promise<WebSearchResult[]> {
    throw new Error(
      'Web search is not yet available: the Moonshot search service requires OAuth credentials, ' +
        'which will be wired up in Phase 5. Configure a provider directly if you need search now.',
    );
  }
}
