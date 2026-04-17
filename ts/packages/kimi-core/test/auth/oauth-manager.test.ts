/**
 * OAuthManager tests — exercise ensureFresh / login / logout against a fake
 * storage and injected transport mocks. No network, no file locks.
 *
 * We inject `refreshTokenImpl`, `pollDeviceImpl`, `requestDeviceImpl`, `now`,
 * and `sleep` for determinism. The storage is an in-memory implementation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DeviceCodeTimeoutError,
  OAuthUnauthorizedError,
} from '../../src/auth/errors.js';
import { OAuthManager } from '../../src/auth/oauth-manager.js';
import type {
  DeviceAuthorization,
  OAuthFlowConfig,
  TokenInfo,
} from '../../src/auth/types.js';
import type { TokenStorage } from '../../src/auth/storage.js';
import type { DevicePollResult } from '../../src/auth/oauth.js';

class InMemoryStorage implements TokenStorage {
  public store = new Map<string, TokenInfo>();

  async load(name: string): Promise<TokenInfo | undefined> {
    return this.store.get(name);
  }

  async save(name: string, token: TokenInfo): Promise<void> {
    this.store.set(name, token);
  }

  async remove(name: string): Promise<void> {
    this.store.delete(name);
  }

  async list(): Promise<string[]> {
    return [...this.store.keys()];
  }
}

const config: OAuthFlowConfig = {
  name: 'kimi-code',
  oauthHost: 'https://test',
  clientId: 'test',
};

function makeToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: 2_000_000_000,  // far future
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
    ...overrides,
  };
}

let currentNow = 1_000_000_000;
function now(): number {
  return currentNow;
}

beforeEach(() => {
  currentNow = 1_000_000_000;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── ensureFresh ───────────────────────────────────────────────────────

describe('OAuthManager.ensureFresh', () => {
  it('returns stored access_token when not close to expiry', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 7200 }));
    const refreshImpl = vi.fn();
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
    });
    const access = await mgr.ensureFresh();
    expect(access).toBe('at-1');
    expect(refreshImpl).not.toHaveBeenCalled();
  });

  it('refreshes when within dynamic threshold', async () => {
    const storage = new InMemoryStorage();
    // expires in 200s, threshold = max(300, 3600*0.5) = 1800. 200 < 1800 → refresh
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 200 }));
    const refreshed = makeToken({
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiresAt: currentNow + 3600,
    });
    const refreshImpl = vi.fn().mockResolvedValue(refreshed);
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });
    const access = await mgr.ensureFresh();
    expect(refreshImpl).toHaveBeenCalledWith(config, 'rt-1');
    expect(access).toBe('at-new');
    expect((await storage.load('kimi-code'))?.accessToken).toBe('at-new');
  });

  it('force=true always refreshes', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 7200 }));
    const refreshImpl = vi.fn().mockResolvedValue(makeToken({ accessToken: 'forced' }));
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });
    const access = await mgr.ensureFresh({ force: true });
    expect(refreshImpl).toHaveBeenCalled();
    expect(access).toBe('forced');
  });

  it('concurrent ensureFresh calls share a single refresh', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 200 }));
    let refreshCount = 0;
    const refreshImpl = vi.fn().mockImplementation(async () => {
      refreshCount += 1;
      return makeToken({ accessToken: `at-${refreshCount}` });
    });
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });
    const [a, b, c] = await Promise.all([
      mgr.ensureFresh(),
      mgr.ensureFresh(),
      mgr.ensureFresh(),
    ]);
    expect(refreshCount).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('throws when no stored token (caller should drive /login)', async () => {
    const storage = new InMemoryStorage();
    const mgr = new OAuthManager({ config, storage, now });
    await expect(mgr.ensureFresh()).rejects.toThrow(/no token/i);
  });

  it('clears stored token on OAuthUnauthorizedError (refresh_token rejected)', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 100 }));
    const refreshImpl = vi.fn().mockRejectedValue(
      new OAuthUnauthorizedError('invalid_grant'),
    );
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });
    await expect(mgr.ensureFresh()).rejects.toBeInstanceOf(OAuthUnauthorizedError);
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('does NOT delete file if 401 happens after another process rotated (M5)', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-old',
        refreshToken: 'rt-old',
        expiresAt: currentNow + 100,
      }),
    );
    // Simulate: our refresh attempt fails 401 because rt-old was rotated by
    // another process; the new token is already in storage.
    let refreshAttempts = 0;
    const refreshImpl = vi.fn().mockImplementation(async (_cfg, rt: string) => {
      refreshAttempts += 1;
      if (rt === 'rt-old') {
        // Race: while we were calling refresh, another process rotated.
        await storage.save(
          'kimi-code',
          makeToken({
            accessToken: 'at-rotated',
            refreshToken: 'rt-rotated',
            expiresAt: currentNow + 7200,
          }),
        );
        throw new OAuthUnauthorizedError('rt-old already rotated');
      }
      return makeToken({ accessToken: 'should-not-reach' });
    });
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
      sleep: async () => undefined,
    });
    // Should NOT throw — should re-read the rotated token and return it
    const access = await mgr.ensureFresh();
    expect(access).toBe('at-rotated');
    // File should still have the rotated token
    expect((await storage.load('kimi-code'))?.accessToken).toBe('at-rotated');
    expect(refreshAttempts).toBe(1);
  });


  // ── Phase 11.1 — force=true propagates errors (no silent swallow) ────

  it('Phase 11.1: force=true surfaces OAuthUnauthorizedError to the caller', async () => {
    // Python parity: tests/auth/test_oauth_refresh.py:364 — force=true
    // must not paper over a genuinely revoked refresh_token. Caller
    // drives /login to recover; ensureFresh throws so the error is
    // observable.
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({ expiresAt: currentNow + 7200, refreshToken: 'rt-revoked' }),
    );
    const refreshImpl = vi.fn().mockRejectedValue(
      new OAuthUnauthorizedError('refresh_token revoked'),
    );
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
      sleep: () => Promise.resolve(),
    });

    await expect(mgr.ensureFresh({ force: true })).rejects.toBeInstanceOf(
      OAuthUnauthorizedError,
    );
    // Current behaviour also clears the storage on 401 so the caller
    // knows the user must re-login. Assert the contract so a regression
    // that silently reverts the clear is caught.
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('Phase 11.1: force=true surfaces network errors without swallowing', async () => {
    // Python parity: tests/auth/test_oauth_refresh.py:381 — a transport
    // error inside force=true must reach the caller. Per briefing §11.1
    // decision (b): caller owns the try/catch policy, not ensureFresh.
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 7200 }));
    const refreshImpl = vi.fn().mockRejectedValue(
      new Error('ECONNRESET: network unreachable'),
    );
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
      sleep: () => Promise.resolve(),
    });

    await expect(mgr.ensureFresh({ force: true })).rejects.toThrow(/ECONNRESET/);
    // Network error is NOT a revocation signal — storage must stay intact.
    expect(await storage.load('kimi-code')).toBeDefined();
  });

  it('uses fresh stored token when another process already rotated', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-old',
        refreshToken: 'rt-old',
        expiresAt: currentNow + 100,
      }),
    );
    const refreshImpl = vi.fn();  // should NOT be called — latest is fresh
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });

    // Second load call returns an externally-rotated token that's fresh.
    const originalLoad = storage.load.bind(storage);
    let callCount = 0;
    storage.load = async (name: string) => {
      callCount += 1;
      if (callCount === 2) {
        await storage.save(
          'kimi-code',
          makeToken({
            accessToken: 'at-rotated',
            refreshToken: 'rt-rotated',
            expiresAt: currentNow + 3600,
          }),
        );
      }
      return originalLoad(name);
    };

    const access = await mgr.ensureFresh();
    expect(access).toBe('at-rotated');
    expect(refreshImpl).not.toHaveBeenCalled();
  });
});

// ── login ─────────────────────────────────────────────────────────────

describe('OAuthManager.login', () => {
  function okAuth(): DeviceAuthorization {
    return {
      userCode: 'WDJB-MJHT',
      deviceCode: 'dev123',
      verificationUri: 'https://auth/verify',
      verificationUriComplete: 'https://auth/verify?user_code=WDJB-MJHT',
      expiresIn: 600,
      interval: 5,
    };
  }

  it('drives device flow to success and persists token', async () => {
    const storage = new InMemoryStorage();
    const requestImpl = vi.fn().mockResolvedValue(okAuth());
    const pollResponses: DevicePollResult[] = [
      { kind: 'pending', errorCode: 'authorization_pending', description: '' },
      { kind: 'pending', errorCode: 'authorization_pending', description: '' },
      { kind: 'success', token: makeToken({ accessToken: 'at-login' }) },
    ];
    const pollImpl = vi.fn().mockImplementation(async () => pollResponses.shift()!);

    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: requestImpl,
      pollDeviceImpl: pollImpl,
      sleep: async () => undefined,
    });

    const onDeviceCode = vi.fn();
    const result = await mgr.login({ onDeviceCode });
    expect(result.accessToken).toBe('at-login');
    expect(await storage.load('kimi-code')).toBeDefined();
    expect(onDeviceCode).toHaveBeenCalledTimes(1);
  });

  it('throws DeviceCodeTimeoutError when local 15-min budget exceeds', async () => {
    const storage = new InMemoryStorage();
    const requestImpl = vi.fn().mockResolvedValue(okAuth());
    const pollImpl = vi.fn().mockResolvedValue({
      kind: 'pending' as const,
      errorCode: 'authorization_pending',
      description: '',
    });
    // sleep mock also advances `currentNow` to simulate wall clock
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      currentNow += Math.ceil(ms / 1000);
    });

    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: requestImpl,
      pollDeviceImpl: pollImpl,
      sleep,
      deviceCodeTimeoutMs: 10_000,  // 10s for test
    });

    await expect(mgr.login()).rejects.toBeInstanceOf(DeviceCodeTimeoutError);
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('throws on denied', async () => {
    const storage = new InMemoryStorage();
    const pollImpl = vi.fn().mockResolvedValue({
      kind: 'denied' as const,
      description: 'user rejected',
    });
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: vi.fn().mockResolvedValue(okAuth()),
      pollDeviceImpl: pollImpl,
      sleep: async () => undefined,
    });
    await expect(mgr.login()).rejects.toThrow(/denied|reject/i);
  });

  it('restarts device flow when server reports expired_token', async () => {
    const storage = new InMemoryStorage();
    const requestImpl = vi.fn().mockResolvedValue(okAuth());
    const pollResponses: DevicePollResult[] = [
      { kind: 'expired' },
      { kind: 'success', token: makeToken() },
    ];
    const pollImpl = vi.fn().mockImplementation(async () => pollResponses.shift()!);
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: requestImpl,
      pollDeviceImpl: pollImpl,
      sleep: async () => undefined,
    });
    const token = await mgr.login();
    expect(token.accessToken).toBe('at-1');
    expect(requestImpl).toHaveBeenCalledTimes(2);
  });

  it('respects AbortSignal during polling', async () => {
    const storage = new InMemoryStorage();
    const pollImpl = vi.fn().mockResolvedValue({
      kind: 'pending' as const,
      errorCode: 'authorization_pending',
      description: '',
    });
    const ac = new AbortController();
    const sleep = vi.fn().mockImplementation(async () => {
      ac.abort();
    });
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: vi.fn().mockResolvedValue({
        userCode: 'U',
        deviceCode: 'D',
        verificationUri: '',
        verificationUriComplete: 'https://x',
        expiresIn: 600,
        interval: 1,
      }),
      pollDeviceImpl: pollImpl,
      sleep,
    });
    await expect(mgr.login({ signal: ac.signal })).rejects.toThrow(/abort/i);
  });
});

// ── logout & hasToken ─────────────────────────────────────────────────

describe('OAuthManager.logout and hasToken', () => {
  it('logout removes stored token', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken());
    const mgr = new OAuthManager({ config, storage, now });
    await mgr.logout();
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('hasToken returns true when stored, false otherwise', async () => {
    const storage = new InMemoryStorage();
    const mgr = new OAuthManager({ config, storage, now });
    expect(await mgr.hasToken()).toBe(false);
    await storage.save('kimi-code', makeToken());
    expect(await mgr.hasToken()).toBe(true);
  });
});

// ── slow_down RFC 8628 §3.5 ────────────────────────────────────────────

describe('OAuthManager.login — slow_down handling', () => {
  it('increases polling interval by 5s on slow_down (RFC 8628 §3.5)', async () => {
    const storage = new InMemoryStorage();
    const sleepCalls: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
    };
    let n = 0;
    const pollImpl = async (): Promise<DevicePollResult> => {
      n += 1;
      if (n === 1) return { kind: 'pending', errorCode: 'authorization_pending', description: '' };
      if (n === 2) return { kind: 'pending', errorCode: 'slow_down', description: '' };
      if (n === 3) return { kind: 'pending', errorCode: 'slow_down', description: '' };
      return { kind: 'success', token: makeToken() };
    };
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: async () => ({
        userCode: 'U',
        deviceCode: 'D',
        verificationUri: '',
        verificationUriComplete: 'https://x',
        expiresIn: 600,
        interval: 5,  // baseline
      }),
      pollDeviceImpl: pollImpl,
      sleep,
    });
    await mgr.login();
    // After 1st pending → sleep 5s. After slow_down #2 → +5 = 10s.
    // After slow_down #3 → +5 = 15s. Then success (no sleep).
    expect(sleepCalls).toEqual([5000, 10_000, 15_000]);
  });
});

// ── FileTokenStorage integration ───────────────────────────────────────

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileTokenStorage } from '../../src/auth/storage.js';

describe('OAuthManager + FileTokenStorage integration', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `kimi-oauth-mgr-int-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('login persists token to disk; ensureFresh reads it back', async () => {
    const storage = new FileTokenStorage(dir);
    const refreshImpl = vi.fn().mockResolvedValue(makeToken({ accessToken: 'refreshed' }));
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: async () => ({
        userCode: 'U',
        deviceCode: 'D',
        verificationUri: '',
        verificationUriComplete: 'https://x',
        expiresIn: 600,
        interval: 5,
      }),
      pollDeviceImpl: async (): Promise<DevicePollResult> => ({
        kind: 'success',
        token: makeToken({ accessToken: 'fresh-from-login', expiresAt: currentNow + 7200 }),
      }),
      sleep: async () => undefined,
      refreshTokenImpl: refreshImpl,
    });
    const token = await mgr.login();
    expect(token.accessToken).toBe('fresh-from-login');

    // New manager instance reads from same storage (simulates restart)
    const mgr2 = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
    });
    const access = await mgr2.ensureFresh();
    expect(access).toBe('fresh-from-login');
    expect(refreshImpl).not.toHaveBeenCalled();
  });

  it('logout removes token file', async () => {
    const storage = new FileTokenStorage(dir);
    await storage.save('kimi-code', makeToken());
    const mgr = new OAuthManager({ config, storage, now });
    expect(await mgr.hasToken()).toBe(true);
    await mgr.logout();
    expect(await mgr.hasToken()).toBe(false);
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('ensureFresh refreshes and persists to disk', async () => {
    const storage = new FileTokenStorage(dir);
    await storage.save(
      'kimi-code',
      makeToken({ refreshToken: 'rt-original', expiresAt: currentNow + 100 }),
    );
    const refreshImpl = vi.fn().mockResolvedValue(
      makeToken({
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        expiresAt: currentNow + 7200,
      }),
    );
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
    });
    await mgr.ensureFresh();
    const persisted = await storage.load('kimi-code');
    expect(persisted?.accessToken).toBe('rotated-access');
    expect(persisted?.refreshToken).toBe('rotated-refresh');
  });
});
