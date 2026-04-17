/**
 * OAuth local callback server — Phase 19 Slice D tests.
 *
 * A lightweight `http.createServer` that binds to an ephemeral port on
 * 127.0.0.1 to receive the authorization-code redirect during the
 * browser-based PKCE flow. Tests start real servers (not mocks) so we
 * validate actual HTTP behaviour.
 */

import { describe, expect, it } from 'vitest';

import {
  startOAuthCallbackServer,
  type OAuthCallbackServerHandle,
} from '../../../src/soul-plus/mcp/oauth-callback-server.js';

async function fetchCallback(
  handle: OAuthCallbackServerHandle,
  query: string,
): Promise<Response> {
  return fetch(`${handle.redirectUri}${query}`);
}

describe('startOAuthCallbackServer', () => {
  // 1
  it('binds to an ephemeral port and reports the redirect URI', async () => {
    const server = await startOAuthCallbackServer();
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`);
    } finally {
      await server.close();
    }
  });

  // 2
  it('GET /callback?code=abc resolves waitForCode with the code', async () => {
    const server = await startOAuthCallbackServer();
    try {
      const waiter = server.waitForCode();
      const res = await fetchCallback(server, '?code=abc');
      expect(res.status).toBe(200);
      const body = await res.text();
      // Page should hint the user to close the window / tab.
      expect(body.toLowerCase()).toMatch(/close|complete|success/);
      await expect(waiter).resolves.toEqual(expect.objectContaining({ code: 'abc' }));
    } finally {
      await server.close();
    }
  });

  // 3
  it('captures both code and state when provided', async () => {
    const server = await startOAuthCallbackServer();
    try {
      const waiter = server.waitForCode();
      await fetchCallback(server, '?code=abc&state=xyz');
      await expect(waiter).resolves.toEqual({ code: 'abc', state: 'xyz' });
    } finally {
      await server.close();
    }
  });

  // 4
  it('rejects when callback carries an OAuth error', async () => {
    const server = await startOAuthCallbackServer();
    try {
      const waiter = server.waitForCode();
      await fetchCallback(server, '?error=access_denied&error_description=User+rejected');
      await expect(waiter).rejects.toThrow(/access_denied/);
    } finally {
      await server.close();
    }
  });

  // 5
  it('neither code nor error on /callback → rejects or 4xx (implementation may pick either)', async () => {
    const server = await startOAuthCallbackServer();
    try {
      const waiter = server.waitForCode({ timeoutMs: 200 });
      const res = await fetchCallback(server, '');
      // Either the server responded with a client-error status AND the waiter
      // later rejects on timeout, or the server rejected the waiter
      // immediately. Accept either.
      const waiterResult = await waiter.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      expect(waiterResult).toBe('rejected');
      // Response shape is informational.
      expect([400, 404, 200]).toContain(res.status);
    } finally {
      await server.close();
    }
  });

  // 6
  it('waitForCode() rejects after timeoutMs when no request arrives', async () => {
    const server = await startOAuthCallbackServer();
    try {
      const start = Date.now();
      await expect(server.waitForCode({ timeoutMs: 100 })).rejects.toThrow();
      // Give a generous upper bound to account for CI slowness.
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      await server.close();
    }
  });

  // 7
  it('close() shuts down the server and rejects pending waitForCode()', async () => {
    const server = await startOAuthCallbackServer();
    const waiter = server.waitForCode();
    await server.close();
    await expect(waiter).rejects.toThrow();
    // Subsequent fetches must fail (ECONNREFUSED) since the port is freed.
    await expect(fetch(`${server.redirectUri}?code=late`)).rejects.toThrow();
  });

  // 8
  it('two concurrent servers get distinct ephemeral ports', async () => {
    const a = await startOAuthCallbackServer();
    const b = await startOAuthCallbackServer();
    try {
      expect(a.port).not.toBe(b.port);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
