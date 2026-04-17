/**
 * McpOAuthProvider — Phase 19 Slice D unit tests (failing first).
 *
 * Covers the MCP SDK `OAuthClientProvider` implementation backing
 * `kimi mcp auth`: PKCE Authorization Code Flow, token persistence to
 * `{kimiHome}/auth/mcp-{serverId}.json` at mode 0o600, and the
 * invalidate/clear semantics required for `reset-auth`.
 */

import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpOAuthProvider } from '../../../src/soul-plus/mcp/oauth.js';

// ─── Fixture helpers ────────────────────────────────────────────────

interface Harness {
  readonly kimiHome: string;
  readonly serverId: string;
  readonly redirectPort: number;
  readonly tokenPath: string;
  readonly openBrowser: ReturnType<typeof vi.fn>;
  readonly provider: McpOAuthProvider;
  cleanup(): void;
}

function makeHarness(overrides?: { serverId?: string; redirectPort?: number }): Harness {
  const kimiHome = mkdtempSync(join(tmpdir(), 'kimi-mcp-oauth-'));
  const serverId = overrides?.serverId ?? 'acme';
  const redirectPort = overrides?.redirectPort ?? 53412;
  const tokenPath = join(kimiHome, 'auth', `mcp-${serverId}.json`);
  const openBrowser = vi.fn<(url: string) => Promise<void>>(async () => {});
  const provider = new McpOAuthProvider({
    serverId,
    kimiHome,
    redirectPort,
    openBrowser,
  });
  return {
    kimiHome,
    serverId,
    redirectPort,
    tokenPath,
    openBrowser,
    provider,
    cleanup: () => rmSync(kimiHome, { recursive: true, force: true }),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('McpOAuthProvider', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.cleanup();
  });

  // 1
  it('tokens(): returns undefined when the token file does not exist', async () => {
    await expect(h.provider.tokens()).resolves.toBeUndefined();
  });

  // 2
  it('tokens(): returns saved OAuthTokens after saveTokens()', async () => {
    await h.provider.saveTokens({ access_token: 'at-1', token_type: 'Bearer', expires_in: 3600 });
    const loaded = await h.provider.tokens();
    expect(loaded).toEqual({ access_token: 'at-1', token_type: 'Bearer', expires_in: 3600 });
  });

  // 3
  it('tokens(): returns undefined when file exists but JSON is corrupt', async () => {
    // Force a bad write by pre-seeding a saveTokens first, then clobbering the file.
    await h.provider.saveTokens({ access_token: 'at-1', token_type: 'Bearer' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(h.tokenPath, '{not valid json');
    await expect(h.provider.tokens()).resolves.toBeUndefined();
  });

  // 4
  it('saveTokens(): writes JSON file at mode 0o600', async () => {
    await h.provider.saveTokens({ access_token: 'at-2', token_type: 'Bearer' });
    expect(existsSync(h.tokenPath)).toBe(true);
    const st = statSync(h.tokenPath);
    // only compare permission bits
    expect(st.mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(h.tokenPath, 'utf8')) as { tokens: unknown };
    expect(raw.tokens).toEqual({ access_token: 'at-2', token_type: 'Bearer' });
  });

  // 5
  it('saveTokens(): preserves previously saved clientInformation / codeVerifier', async () => {
    await h.provider.saveClientInformation({
      client_id: 'cli-123',
      redirect_uris: [`http://127.0.0.1:${h.redirectPort}/callback`],
    });
    await h.provider.saveCodeVerifier('verifier-xyz');
    await h.provider.saveTokens({ access_token: 'at-3', token_type: 'Bearer' });

    const info = await h.provider.clientInformation();
    expect(info?.client_id).toBe('cli-123');
    const verifier = await h.provider.codeVerifier();
    expect(verifier).toBe('verifier-xyz');
  });

  // 6
  it('clientInformation() / saveClientInformation(): round-trip', async () => {
    await expect(h.provider.clientInformation()).resolves.toBeUndefined();
    await h.provider.saveClientInformation({
      client_id: 'cli-abc',
      client_secret: 'shh',
      redirect_uris: [`http://127.0.0.1:${h.redirectPort}/callback`],
    });
    const info = await h.provider.clientInformation();
    expect(info?.client_id).toBe('cli-abc');
    expect((info as { client_secret?: string } | undefined)?.client_secret).toBe('shh');
  });

  // 7
  it('saveCodeVerifier() / codeVerifier(): round-trip', async () => {
    await h.provider.saveCodeVerifier('super-secret-verifier');
    await expect(h.provider.codeVerifier()).resolves.toBe('super-secret-verifier');
  });

  // 8
  it('codeVerifier(): throws when no verifier has been saved', async () => {
    await expect(h.provider.codeVerifier()).rejects.toThrow();
  });

  // 9
  it('redirectToAuthorization(): forwards to injected openBrowser and returns promptly', async () => {
    const url = new URL('https://example.com/authorize?foo=bar');
    const start = Date.now();
    await h.provider.redirectToAuthorization(url);
    expect(h.openBrowser).toHaveBeenCalledTimes(1);
    expect(h.openBrowser).toHaveBeenCalledWith(url.toString());
    // Must not block — should return within a second in tests.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  // 10
  it('invalidateCredentials("tokens"): clears tokens but preserves clientInformation', async () => {
    await h.provider.saveClientInformation({
      client_id: 'cli-keep',
      redirect_uris: [`http://127.0.0.1:${h.redirectPort}/callback`],
    });
    await h.provider.saveTokens({ access_token: 'at-remove', token_type: 'Bearer' });

    await h.provider.invalidateCredentials('tokens');

    await expect(h.provider.tokens()).resolves.toBeUndefined();
    const info = await h.provider.clientInformation();
    expect(info?.client_id).toBe('cli-keep');
  });

  // 11
  it('invalidateCredentials("all"): deletes the full token file', async () => {
    await h.provider.saveTokens({ access_token: 'at-bye', token_type: 'Bearer' });
    await h.provider.invalidateCredentials('all');
    expect(existsSync(h.tokenPath)).toBe(false);
  });

  // 12
  it('clear(): deletes the full token file (equivalent to invalidate "all")', async () => {
    await h.provider.saveTokens({ access_token: 'at-bye', token_type: 'Bearer' });
    await h.provider.clear();
    expect(existsSync(h.tokenPath)).toBe(false);
  });

  // 13
  it('redirectUrl: "http://127.0.0.1:{redirectPort}/callback"', () => {
    expect(h.provider.redirectUrl).toBe(`http://127.0.0.1:${h.redirectPort}/callback`);
  });

  // 14
  it('clientMetadata: defaults match public-client PKCE shape', () => {
    const meta = h.provider.clientMetadata;
    expect(meta.redirect_uris).toEqual([`http://127.0.0.1:${h.redirectPort}/callback`]);
    expect(meta.token_endpoint_auth_method).toBe('none');
    expect(meta.grant_types).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token']),
    );
    expect(meta.response_types).toEqual(['code']);
    expect(meta.client_name).toBe('kimi-cli');
  });

  // 15
  it('accepts caller-supplied clientMetadata overrides', () => {
    const custom = new McpOAuthProvider({
      serverId: 'custom',
      kimiHome: h.kimiHome,
      redirectPort: h.redirectPort,
      openBrowser: h.openBrowser,
      clientMetadata: {
        redirect_uris: [`http://127.0.0.1:${h.redirectPort}/callback`],
        client_name: 'custom-client',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(custom.clientMetadata.client_name).toBe('custom-client');
    expect(custom.clientMetadata.grant_types).toEqual(['authorization_code']);
  });

  // 16
  it('saveTokens(): file mode survives re-save (remains 0o600)', async () => {
    await h.provider.saveTokens({ access_token: 'a', token_type: 'Bearer' });
    await h.provider.saveTokens({ access_token: 'b', token_type: 'Bearer' });
    const st = statSync(h.tokenPath);
    expect(st.mode & 0o777).toBe(0o600);
  });
});
