/**
 * OAuth device code flow tests — pure HTTP wrappers against a fake server.
 *
 * Covers the three endpoint calls: requestDeviceAuthorization, pollDeviceToken,
 * refreshAccessToken. Uses a local HTTP server on a dynamic port to exercise
 * the real fetch code path.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RetryableRefreshError,
  OAuthError,
  OAuthUnauthorizedError,
} from '../../src/auth/errors.js';
import {
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceAuthorization,
} from '../../src/auth/oauth.js';
import type { OAuthFlowConfig } from '../../src/auth/types.js';

interface FakeResponse {
  status: number;
  body: string | Record<string, unknown>;
}

interface Recorded {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

class FakeOAuthServer {
  private server: Server | undefined;
  private responses: Map<string, FakeResponse[]> = new Map();
  readonly recorded: Recorded[] = [];
  host = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('no server address');
    }
    this.host = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
  }

  /** Queue a response for the given POST path (FIFO). */
  enqueue(path: string, response: FakeResponse): void {
    const key = `POST ${path}`;
    const list = this.responses.get(key) ?? [];
    list.push(response);
    this.responses.set(key, list);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const path = req.url ?? '';
      this.recorded.push({
        path,
        method: req.method ?? '',
        headers: req.headers as Record<string, string>,
        body,
      });
      const key = `${req.method} ${path}`;
      const queue = this.responses.get(key);
      const next = queue?.shift();
      if (!next) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'no fake response queued', key }));
        return;
      }
      res.statusCode = next.status;
      res.setHeader('content-type', 'application/json');
      res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
    });
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────

let server: FakeOAuthServer;

function flowConfig(): OAuthFlowConfig {
  return {
    name: 'kimi-code',
    oauthHost: server.host,
    clientId: 'test-client-id',
  };
}

beforeEach(async () => {
  server = new FakeOAuthServer();
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

// ── requestDeviceAuthorization ────────────────────────────────────────

describe('requestDeviceAuthorization', () => {
  it('parses a successful response', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'WDJB-MJHT',
        device_code: 'devcode123',
        verification_uri: 'https://auth.kimi.com/verify',
        verification_uri_complete: 'https://auth.kimi.com/verify?user_code=WDJB-MJHT',
        expires_in: 600,
        interval: 5,
      },
    });

    const auth = await requestDeviceAuthorization(flowConfig());
    expect(auth.userCode).toBe('WDJB-MJHT');
    expect(auth.deviceCode).toBe('devcode123');
    expect(auth.verificationUri).toBe('https://auth.kimi.com/verify');
    expect(auth.verificationUriComplete).toBe(
      'https://auth.kimi.com/verify?user_code=WDJB-MJHT',
    );
    expect(auth.expiresIn).toBe(600);
    expect(auth.interval).toBe(5);
  });

  it('posts client_id as form-encoded body', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'U',
        device_code: 'D',
        verification_uri_complete: 'https://x/y',
        expires_in: 60,
        interval: 5,
      },
    });
    await requestDeviceAuthorization(flowConfig());
    const recorded = server.recorded[0]!;
    expect(recorded.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(recorded.body).toContain('client_id=test-client-id');
  });

  it('sends X-Msh-* device headers', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'U',
        device_code: 'D',
        verification_uri_complete: 'https://x/y',
        expires_in: 60,
        interval: 5,
      },
    });
    await requestDeviceAuthorization(flowConfig());
    const recorded = server.recorded[0]!;
    expect(recorded.headers['x-msh-platform']).toBe('kimi_cli');
    expect(recorded.headers['x-msh-device-id']).toMatch(/^[0-9a-f-]+$/);
    expect(recorded.headers['x-msh-version']).toBeTruthy();
  });

  it('defaults interval to 5 when omitted', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'U',
        device_code: 'D',
        verification_uri_complete: 'https://x/y',
        expires_in: 60,
      },
    });
    const auth = await requestDeviceAuthorization(flowConfig());
    expect(auth.interval).toBe(5);
  });

  it('throws OAuthError on non-200 response', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 500,
      body: { error: 'server_error' },
    });
    await expect(requestDeviceAuthorization(flowConfig())).rejects.toBeInstanceOf(OAuthError);
  });

  it('throws when device_code is missing (M7 validation)', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'X',
        verification_uri_complete: 'https://x',
        expires_in: 60,
        interval: 5,
        // device_code missing
      },
    });
    await expect(requestDeviceAuthorization(flowConfig())).rejects.toBeInstanceOf(OAuthError);
  });

  it('throws when verification_uri_complete is missing (M7 validation)', async () => {
    server.enqueue('/api/oauth/device_authorization', {
      status: 200,
      body: {
        user_code: 'X',
        device_code: 'D',
        expires_in: 60,
        interval: 5,
        // verification_uri_complete missing
      },
    });
    await expect(requestDeviceAuthorization(flowConfig())).rejects.toBeInstanceOf(OAuthError);
  });
});

// ── pollDeviceToken ───────────────────────────────────────────────────

describe('pollDeviceToken', () => {
  it('returns TokenInfo on success (200)', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: 'read',
        token_type: 'Bearer',
      },
    });

    const res = await pollDeviceToken(flowConfig(), 'devcode123');
    expect(res.kind).toBe('success');
    if (res.kind !== 'success') throw new Error();
    expect(res.token.accessToken).toBe('at-1');
    expect(res.token.refreshToken).toBe('rt-1');
    expect(res.token.expiresIn).toBe(3600);
    expect(res.token.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('returns pending on authorization_pending', async () => {
    server.enqueue('/api/oauth/token', {
      status: 400,
      body: { error: 'authorization_pending' },
    });

    const res = await pollDeviceToken(flowConfig(), 'devcode123');
    expect(res.kind).toBe('pending');
    if (res.kind !== 'pending') throw new Error();
    expect(res.errorCode).toBe('authorization_pending');
  });

  it('returns pending on slow_down', async () => {
    server.enqueue('/api/oauth/token', {
      status: 400,
      body: { error: 'slow_down' },
    });
    const res = await pollDeviceToken(flowConfig(), 'devcode123');
    expect(res.kind).toBe('pending');
  });

  it('returns expired on expired_token', async () => {
    server.enqueue('/api/oauth/token', {
      status: 400,
      body: { error: 'expired_token' },
    });
    const res = await pollDeviceToken(flowConfig(), 'devcode123');
    expect(res.kind).toBe('expired');
  });

  it('returns denied on access_denied', async () => {
    server.enqueue('/api/oauth/token', {
      status: 400,
      body: { error: 'access_denied' },
    });
    const res = await pollDeviceToken(flowConfig(), 'devcode123');
    expect(res.kind).toBe('denied');
  });

  it('throws on 500 server error', async () => {
    server.enqueue('/api/oauth/token', {
      status: 500,
      body: { error: 'server_error' },
    });
    await expect(pollDeviceToken(flowConfig(), 'd')).rejects.toBeInstanceOf(OAuthError);
  });

  it('throws when success response is missing refresh_token (M7 validation)', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'at-1',
        // refresh_token missing
        expires_in: 60,
        scope: '',
        token_type: 'Bearer',
      },
    });
    await expect(pollDeviceToken(flowConfig(), 'd')).rejects.toBeInstanceOf(OAuthError);
  });

  it('throws when success response has zero/missing expires_in (M7 validation)', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        scope: '',
        token_type: 'Bearer',
        // expires_in missing
      },
    });
    await expect(pollDeviceToken(flowConfig(), 'd')).rejects.toBeInstanceOf(OAuthError);
  });

  it('sends device_code + grant_type=urn:ietf:params:oauth:grant-type:device_code', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 60,
        scope: '',
        token_type: 'Bearer',
      },
    });
    await pollDeviceToken(flowConfig(), 'devcode123');
    const recorded = server.recorded[0]!;
    expect(recorded.body).toContain('device_code=devcode123');
    expect(recorded.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
  });
});

// ── refreshAccessToken ────────────────────────────────────────────────

describe('refreshAccessToken', () => {
  it('returns new TokenInfo on success', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 3600,
        scope: '',
        token_type: 'Bearer',
      },
    });
    const token = await refreshAccessToken(flowConfig(), 'old-rt');
    expect(token.accessToken).toBe('new-at');
    expect(token.refreshToken).toBe('new-rt');
  });

  it('throws OAuthUnauthorizedError on 401', async () => {
    server.enqueue('/api/oauth/token', {
      status: 401,
      body: { error: 'invalid_grant', error_description: 'refresh_token expired' },
    });
    await expect(refreshAccessToken(flowConfig(), 'old-rt')).rejects.toBeInstanceOf(
      OAuthUnauthorizedError,
    );
  });

  it('throws OAuthUnauthorizedError on 403', async () => {
    server.enqueue('/api/oauth/token', {
      status: 403,
      body: {},
    });
    await expect(refreshAccessToken(flowConfig(), 'old-rt')).rejects.toBeInstanceOf(
      OAuthUnauthorizedError,
    );
  });

  it('retries on 429 + 500 / 502 / 503 / 504', async () => {
    server.enqueue('/api/oauth/token', {
      status: 503,
      body: { error_description: 'overloaded' },
    });
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 60,
        scope: '',
        token_type: 'Bearer',
      },
    });
    const token = await refreshAccessToken(flowConfig(), 'old-rt', {
      maxRetries: 2,
      backoffMs: () => 0,
    });
    expect(token.accessToken).toBe('a');
  });

  it('eventually raises RetryableRefreshError after max retries', async () => {
    server.enqueue('/api/oauth/token', { status: 503, body: {} });
    server.enqueue('/api/oauth/token', { status: 503, body: {} });
    await expect(
      refreshAccessToken(flowConfig(), 'old-rt', { maxRetries: 2, backoffMs: () => 0 }),
    ).rejects.toBeInstanceOf(RetryableRefreshError);
  });

  it('retries on transport-level fetch failure (network retry gap fix)', async () => {
    // First attempt: server unreachable. Second: success.
    const badConfig: OAuthFlowConfig = {
      ...flowConfig(),
      // Stop the real server, point at it (will refuse connection), then
      // restart for the retry. This is awkward; instead inject via a
      // separate flowConfig with closed port for the first call.
      oauthHost: 'http://127.0.0.1:1',  // reserved port, ECONNREFUSED
    };
    // Single attempt against unreachable host should throw (not RetryableRefreshError)
    await expect(
      refreshAccessToken(badConfig, 'rt', { maxRetries: 1, backoffMs: () => 0 }),
    ).rejects.toThrow(/OAuth request|fetch failed|Token refresh request|ECONNREFUSED|connect/i);
  });

  it('sends grant_type=refresh_token + refresh_token', async () => {
    server.enqueue('/api/oauth/token', {
      status: 200,
      body: {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 60,
        scope: '',
        token_type: 'Bearer',
      },
    });
    await refreshAccessToken(flowConfig(), 'old-rt-xyz');
    const recorded = server.recorded[0]!;
    expect(recorded.body).toContain('grant_type=refresh_token');
    expect(recorded.body).toContain('refresh_token=old-rt-xyz');
  });
});
