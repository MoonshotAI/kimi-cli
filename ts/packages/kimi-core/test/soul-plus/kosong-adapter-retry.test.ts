/**
 * KosongAdapter — Slice 7.4 (决策 #94) retry + OAuth refresh tests.
 *
 * OAuth 401 and transient network errors used to bubble up out of the
 * adapter and force Soul / TurnManager to special-case them. v2 pins
 * this responsibility inside the adapter so upper layers see a clean
 * "either a ChatResponse or a terminal error" boundary.
 *
 * Pins:
 *   - 401 → token refresh → one retry; if the retry still fails, the
 *     original error is thrown.
 *   - Refresh failure never retries the chat call.
 *   - Without a `tokenRefresher`, 401 is rethrown as-is.
 *   - Transient errors (ECONNRESET / ETIMEDOUT / ECONNREFUSED / 500
 *     / 502 / 503 / 504 / 429) trigger up to `maxRetries=3` retries
 *     with exponential backoff + jitter.
 *   - ContextOverflowError is NEVER retried.
 *   - Abort-signal-aborted between retries short-circuits immediately.
 *   - KosongAdapterOptions accepts `tokenRefresher` / `maxRetries` /
 *     `baseRetryDelayMs`.
 *
 * MockChatProvider `generate` is monkey-patched per test so we can
 * script error sequences. The top-level kosong `generate(provider, ...)`
 * helper delegates to `provider.generate(...)`, so the patch is
 * observed through the real adapter code path.
 */

import { MockChatProvider } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { KosongAdapter } from '../../src/soul-plus/index.js';
import type { KosongAdapterOptions } from '../../src/soul-plus/kosong-adapter.js';
import { ContextOverflowError } from '../../src/soul/errors.js';
import type { ChatParams } from '../../src/soul/index.js';

interface RetryAdapterOptions extends KosongAdapterOptions {
  readonly tokenRefresher?: { refresh(): Promise<void> };
  readonly maxRetries?: number;
  readonly baseRetryDelayMs?: number;
}
function mkAdapter(opts: RetryAdapterOptions): KosongAdapter {
  return new KosongAdapter(opts as KosongAdapterOptions);
}

function makeParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    messages: [],
    tools: [],
    model: 'mock-model',
    systemPrompt: '',
    signal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * Patch the provider's `generate` method so that each call returns the
 * next scripted value. Throwable values are thrown; everything else is
 * returned. When the script is exhausted, the original `generate` runs.
 */
function scriptProvider(
  provider: MockChatProvider,
  script: ReadonlyArray<{ throw: unknown } | { return: unknown }>,
): { callCount: () => number } {
  let i = 0;
  const original = (provider as unknown as { generate: (...args: unknown[]) => unknown }).generate
    ?.bind(provider);
  (provider as unknown as { generate: (...args: unknown[]) => unknown }).generate = async (
    ...args: unknown[]
  ) => {
    const step = script[i];
    i += 1;
    if (step === undefined) {
      if (original === undefined) throw new Error('generate exhausted');
      return original(...args);
    }
    if ('throw' in step) {
      throw step.throw;
    }
    return step.return;
  };
  return { callCount: () => i };
}

function mk401(): Error {
  return Object.assign(new Error('Unauthorized'), {
    status: 401,
    code: 'unauthorized',
  });
}

function mkConnResetError(): Error {
  return Object.assign(new Error('socket hang up ECONNRESET'), { code: 'ECONNRESET' });
}

function mkTimeoutError(): Error {
  return Object.assign(new Error('request timed out ETIMEDOUT'), { code: 'ETIMEDOUT' });
}

function mk5xx(status: number): Error {
  return Object.assign(new Error(`${status} Internal Server Error`), { status });
}

function mkRateLimit(): Error {
  return Object.assign(new Error('429 Too Many Requests'), { status: 429 });
}

// ── OAuth 401 refresh ───────────────────────────────────────────────────

describe('KosongAdapter — OAuth 401 refresh (决策 #94)', () => {
  it('refreshes the token then retries once on 401', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'ok' }]);
    const marker = scriptProvider(provider, [{ throw: mk401() }]);
    const refresh = vi.fn(async () => {});
    const adapter = mkAdapter({
      provider,
      tokenRefresher: { refresh },
    });

    const response = await adapter.chat(makeParams());
    expect(refresh).toHaveBeenCalledTimes(1);
    // Two `generate` calls: the failed one + the retry.
    expect(marker.callCount()).toBeGreaterThanOrEqual(2);
    expect(response.message.role).toBe('assistant');
  });

  it('does NOT retry when token refresh itself fails', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'unused' }]);
    const marker = scriptProvider(provider, [{ throw: mk401() }]);
    const refresh = vi.fn(async () => {
      throw new Error('refresh failed');
    });
    const adapter = mkAdapter({ provider, tokenRefresher: { refresh } });

    await expect(adapter.chat(makeParams())).rejects.toBeDefined();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Only the original call — no retry attempted after refresh threw.
    expect(marker.callCount()).toBe(1);
  });

  it('rethrows 401 when no tokenRefresher is configured', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'x' }]);
    const marker = scriptProvider(provider, [{ throw: mk401() }]);
    const adapter = mkAdapter({ provider });

    await expect(adapter.chat(makeParams())).rejects.toMatchObject({ status: 401 });
    expect(marker.callCount()).toBe(1);
  });

  it('does not loop forever: a second 401 after refresh is thrown', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'x' }]);
    const marker = scriptProvider(provider, [
      { throw: mk401() },
      { throw: mk401() },
    ]);
    const refresh = vi.fn(async () => {});
    const adapter = mkAdapter({ provider, tokenRefresher: { refresh } });

    await expect(adapter.chat(makeParams())).rejects.toMatchObject({ status: 401 });
    // Exactly one refresh + two generate calls — no second refresh attempt.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(marker.callCount()).toBe(2);
  });
});

// ── Transient network error exponential backoff ─────────────────────────

describe('KosongAdapter — transient error retries (决策 #94)', () => {
  it('retries ECONNRESET up to maxRetries (default 3) then succeeds', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'ok' }]);
    const marker = scriptProvider(provider, [
      { throw: mkConnResetError() },
      { throw: mkConnResetError() },
    ]);
    const adapter = mkAdapter({ provider, baseRetryDelayMs: 1 });

    const response = await adapter.chat(makeParams());
    // 2 failed + 1 success.
    expect(marker.callCount()).toBeGreaterThanOrEqual(3);
    expect(response.message.role).toBe('assistant');
  });

  it.each(['ETIMEDOUT', 'ECONNREFUSED'] as const)(
    'retries on %s node errors',
    async (code) => {
      const provider = new MockChatProvider([{ type: 'text', text: 'ok' }]);
      const err =
        code === 'ETIMEDOUT' ? mkTimeoutError() : Object.assign(new Error(code), { code });
      const marker = scriptProvider(provider, [{ throw: err }]);
      const adapter = mkAdapter({ provider, baseRetryDelayMs: 1 });
      const response = await adapter.chat(makeParams());
      expect(marker.callCount()).toBeGreaterThanOrEqual(2);
      expect(response.message.role).toBe('assistant');
    },
  );

  it.each([500, 502, 503, 504] as const)('retries on HTTP %i', async (status) => {
    const provider = new MockChatProvider([{ type: 'text', text: 'ok' }]);
    const marker = scriptProvider(provider, [{ throw: mk5xx(status) }]);
    const adapter = mkAdapter({ provider, baseRetryDelayMs: 1 });
    const response = await adapter.chat(makeParams());
    expect(marker.callCount()).toBeGreaterThanOrEqual(2);
    expect(response.message.role).toBe('assistant');
  });

  it('retries HTTP 429 rate-limit', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'ok' }]);
    const marker = scriptProvider(provider, [{ throw: mkRateLimit() }]);
    const adapter = mkAdapter({ provider, baseRetryDelayMs: 1 });
    const response = await adapter.chat(makeParams());
    expect(marker.callCount()).toBeGreaterThanOrEqual(2);
    expect(response.message.role).toBe('assistant');
  });

  it('gives up after maxRetries consecutive failures', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'unused' }]);
    const marker = scriptProvider(provider, [
      { throw: mkConnResetError() },
      { throw: mkConnResetError() },
      { throw: mkConnResetError() },
      { throw: mkConnResetError() },
    ]);
    const adapter = mkAdapter({
      provider,
      maxRetries: 3,
      baseRetryDelayMs: 1,
    });
    await expect(adapter.chat(makeParams())).rejects.toMatchObject({ code: 'ECONNRESET' });
    // Initial attempt + 3 retries = 4 total calls.
    expect(marker.callCount()).toBe(4);
  });

  it('respects a custom maxRetries=0 (no retry)', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'unused' }]);
    const marker = scriptProvider(provider, [
      { throw: mkConnResetError() },
    ]);
    const adapter = mkAdapter({
      provider,
      maxRetries: 0,
      baseRetryDelayMs: 1,
    });
    await expect(adapter.chat(makeParams())).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(marker.callCount()).toBe(1);
  });

  it('uses exponential backoff between retries (delay grows)', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'ok' }]);
    scriptProvider(provider, [
      { throw: mkConnResetError() },
      { throw: mkConnResetError() },
    ]);
    const adapter = mkAdapter({
      provider,
      baseRetryDelayMs: 10,
    });
    const start = Date.now();
    await adapter.chat(makeParams());
    const elapsed = Date.now() - start;
    // base * (2^0 + 2^1) = 10 + 20 = 30ms lower-bound (ignoring jitter).
    // Use a conservative threshold to avoid flakiness on slow runners.
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });
});

// ── ContextOverflowError is never retried ───────────────────────────────

describe('KosongAdapter — ContextOverflowError passthrough (决策 #94)', () => {
  it('throws ContextOverflowError without retry when provider raises PTL', async () => {
    const providerErr = Object.assign(new Error('context_length_exceeded'), {
      code: 'context_length_exceeded',
      status: 400,
    });
    const provider = new MockChatProvider([{ type: 'text', text: 'x' }]);
    const marker = scriptProvider(provider, [
      { throw: providerErr },
      { throw: providerErr },
    ]);
    const adapter = mkAdapter({ provider, baseRetryDelayMs: 1 });

    await expect(adapter.chat(makeParams())).rejects.toBeInstanceOf(ContextOverflowError);
    // Exactly one call — retry loop must recognise ContextOverflowError
    // as terminal.
    expect(marker.callCount()).toBe(1);
  });
});

// ── Abort signal cuts the retry loop ────────────────────────────────────

describe('KosongAdapter — abort signal behaviour (决策 #94)', () => {
  it('does not retry when signal is already aborted at call time', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'x' }]);
    const marker = scriptProvider(provider, [
      { throw: mkConnResetError() },
      { throw: mkConnResetError() },
    ]);
    const adapter = mkAdapter({ provider, baseRetryDelayMs: 5 });
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.chat(makeParams({ signal: controller.signal }))).rejects.toBeDefined();
    // Pre-flight abort check should short-circuit before a single call.
    expect(marker.callCount()).toBe(0);
  });

  it('bails out of the retry loop when signal aborts mid-backoff', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'x' }]);
    const marker = scriptProvider(provider, [
      { throw: mkConnResetError() },
      { throw: mkConnResetError() },
      { throw: mkConnResetError() },
      { throw: mkConnResetError() },
    ]);
    const adapter = mkAdapter({
      provider,
      maxRetries: 5,
      baseRetryDelayMs: 50,
    });
    const controller = new AbortController();
    // Abort after the first failure has happened.
    setTimeout(() => controller.abort(), 20);
    await expect(adapter.chat(makeParams({ signal: controller.signal }))).rejects.toBeDefined();
    // Should have stopped short of the full 5 retries.
    expect(marker.callCount()).toBeLessThan(5);
  });
});

// ── Options surface ─────────────────────────────────────────────────────

describe('KosongAdapterOptions — retry configuration (决策 #94)', () => {
  it('accepts tokenRefresher / maxRetries / baseRetryDelayMs as optional fields', () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'x' }]);
    // No throw — construction only. This is a compile-time shape check
    // as well as a runtime smoke test.
    const adapter = mkAdapter({
      provider,
      tokenRefresher: { refresh: async () => {} },
      maxRetries: 5,
      baseRetryDelayMs: 250,
    });
    expect(adapter).toBeInstanceOf(KosongAdapter);
  });
});
