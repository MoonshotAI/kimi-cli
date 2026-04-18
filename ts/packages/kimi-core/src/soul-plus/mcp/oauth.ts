/**
 * McpOAuthProvider — Phase 19 Slice D.
 *
 * Persistent `OAuthClientProvider` implementation backing
 * `kimi mcp auth`. The MCP SDK drives the PKCE Authorization Code
 * Flow against this instance:
 *
 *   1. SDK calls {@link clientMetadata} + {@link redirectUrl} during
 *      dynamic client registration / authorize URL construction.
 *   2. SDK calls {@link saveCodeVerifier} / {@link saveClientInformation}
 *      before redirecting the user.
 *   3. SDK calls {@link redirectToAuthorization} — we open the user's
 *      browser via the injected `openBrowser` (default: `open` npm).
 *   4. Our CLI layer runs a local `oauth-callback-server.ts`, receives
 *      the `code`, then calls `transport.finishAuth(code)` which
 *      invokes the SDK's token exchange. Token exchange uses our
 *      {@link codeVerifier} to complete PKCE.
 *   5. SDK calls {@link saveTokens} with the exchanged tokens.
 *
 * All state lands in `{kimiHome}/auth/mcp-{serverId}.json`, created at
 * mode 0o600 so other local users can't read the bearer token. Each
 * write performs an atomic read-modify-write so that saving tokens
 * never clobbers a previously-persisted `clientInformation` /
 * `codeVerifier` (the SDK writes them independently).
 *
 * Security notes:
 * - We deliberately keep the `codeVerifier` in the JSON file rather
 *   than holding it in RAM. The full OAuth flow may outlive a single
 *   invocation of the SDK auth orchestrator (the user browses
 *   asynchronously), so state must survive across reads.
 * - `redirectToAuthorization` is fire-and-forget: we never block on
 *   the browser process — the callback server is what ultimately
 *   unblocks the flow.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

interface StoredOAuthState {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationFull;
  codeVerifier?: string;
  serverUrl?: string;
}

export interface McpOAuthProviderOptions {
  readonly serverId: string;
  readonly kimiHome: string;
  readonly redirectPort: number;
  readonly clientMetadata?: OAuthClientMetadata;
  /**
   * Optional hook for launching the user's browser. The type is
   * deliberately `Function` (with eslint overrides) so callers can
   * pass sync stubs, async helpers, or vitest `vi.fn()` mocks — the
   * default `Mock<Procedure | Constructable>` generic carries a
   * construct signature that plain `(url: string) => Promise<void>`
   * or `(url: string, ...rest: unknown[]) => unknown` both reject.
   * Internally we only ever call it with `(url)` and normalise the
   * return via `Promise.resolve`.
   */
  // eslint-disable-next-line @typescript-eslint/ban-types, @typescript-eslint/no-unsafe-function-type
  readonly openBrowser?: Function;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

async function defaultOpenBrowser(url: string): Promise<void> {
  // `open` is dynamically imported so unit tests that never call
  // `redirectToAuthorization` (most of them) don't pay the import
  // cost — and Windows users lacking the `xdg-open` fallback aren't
  // bitten at module load.
  const mod = (await import('open')) as { default: (target: string) => Promise<unknown> };
  await mod.default(url);
}

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly serverId: string;
  private readonly kimiHome: string;
  private readonly redirectPort: number;
  private readonly authDir: string;
  private readonly filePath: string;
  private readonly overrideMetadata: OAuthClientMetadata | undefined;
  private readonly openBrowserFn: (url: string) => unknown;

  constructor(options: McpOAuthProviderOptions) {
    // Guard against path traversal: `serverId` comes from user-controlled
    // mcp.json keys. Matches the pattern in FileTokenStorage.pathFor —
    // basename() strips any `..` / path separator segments; a difference
    // between input and basename means the caller tried to escape the
    // auth directory and we refuse up front rather than silently writing
    // to a different file.
    const safeServerId = basename(options.serverId);
    if (
      safeServerId.length === 0 ||
      safeServerId !== options.serverId ||
      safeServerId.startsWith('.')
    ) {
      throw new Error(`Invalid MCP serverId: "${options.serverId}"`);
    }
    this.serverId = safeServerId;
    this.kimiHome = options.kimiHome;
    this.redirectPort = options.redirectPort;
    this.authDir = join(options.kimiHome, 'auth');
    this.filePath = join(this.authDir, `mcp-${safeServerId}.json`);
    this.overrideMetadata = options.clientMetadata;
    this.openBrowserFn =
      options.openBrowser !== undefined
        ? (options.openBrowser as (url: string) => unknown)
        : defaultOpenBrowser;
  }

  // ─── Public getters ──────────────────────────────────────────────

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.redirectPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    if (this.overrideMetadata !== undefined) {
      return this.overrideMetadata;
    }
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'kimi-cli',
    };
  }

  // ─── Persistence (OAuthClientProvider contract) ──────────────────

  async tokens(): Promise<OAuthTokens | undefined> {
    const state = await this.readState();
    return state.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const state = await this.readState();
    state.tokens = tokens;
    await this.writeState(state);
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const state = await this.readState();
    return state.clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const state = await this.readState();
    // MCP SDK allows the narrower `OAuthClientInformation` too, but we
    // persist the full shape (all fields are optional beyond
    // `client_id`) so we don't lose metadata if it was provided.
    state.clientInformation = info as OAuthClientInformationFull;
    await this.writeState(state);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const state = await this.readState();
    state.codeVerifier = codeVerifier;
    await this.writeState(state);
  }

  async codeVerifier(): Promise<string> {
    const state = await this.readState();
    if (state.codeVerifier === undefined) {
      throw new Error(
        `No code verifier found for MCP server "${this.serverId}". ` +
          'The OAuth flow must call saveCodeVerifier() before codeVerifier().',
      );
    }
    return state.codeVerifier;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    // Fire-and-forget: we don't await the browser process exiting.
    // The caller's local callback server is what ultimately receives
    // the `code`; blocking here would wedge the SDK's auth orchestrator.
    // `Promise.resolve` normalises sync / async / mocked return values
    // — the option type is `(url: string) => unknown` on purpose.
    await Promise.resolve(this.openBrowserFn(url.toString()));
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all') {
      await this.unlinkIfPresent();
      return;
    }
    const state = await this.readState();
    switch (scope) {
      case 'tokens':
        delete state.tokens;
        break;
      case 'client':
        delete state.clientInformation;
        break;
      case 'verifier':
        delete state.codeVerifier;
        break;
      case 'discovery':
        // Slice D does not persist discovery state — no-op, matching
        // the contract in the SDK's `OAuthClientProvider` comments.
        return;
    }
    await this.writeState(state);
  }

  async clear(): Promise<void> {
    await this.unlinkIfPresent();
  }

  // ─── Internals ───────────────────────────────────────────────────

  private async readState(): Promise<StoredOAuthState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      // Missing file / permission error / etc. → treat as empty.
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === 'object') {
        return parsed as StoredOAuthState;
      }
      return {};
    } catch {
      // Malformed JSON → behave as empty (tokens() must not throw).
      return {};
    }
  }

  private async writeState(state: StoredOAuthState): Promise<void> {
    // `mkdir(..., {recursive: true})` only applies `mode` to the leaf
    // directory in the created chain; any intermediate parents and any
    // pre-existing directories (e.g. `kimiHome` itself) keep whatever
    // permissions the process umask produced. We only guarantee that
    // `authDir` (where token files live) is 0o700 — the caller is
    // responsible for the privacy of the parent `kimiHome`.
    await mkdir(this.authDir, { recursive: true, mode: DIR_MODE });
    const json = JSON.stringify(state, null, 2);
    await writeFile(this.filePath, json, { mode: FILE_MODE });
  }

  private async unlinkIfPresent(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw error;
    }
  }
}
