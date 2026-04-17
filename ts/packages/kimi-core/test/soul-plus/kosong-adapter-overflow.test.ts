/**
 * Slice 5 / 决策 #96 (L3): KosongAdapter overflow detection.
 *
 * v2 §10 / §3.5 specifies Kosong is the one place that unifies 17+
 * provider PTL/413 error patterns into a single ContextOverflowError
 * identity. It also detects SILENT overflows — cases where the provider
 * returned a response but `usage.input + usage.cache_read > contextWindow`,
 * meaning the next turn would certainly fail.
 *
 * Pins:
 *   - When the underlying `generate()` call throws a provider error whose
 *     shape matches a PTL/413 signature, `KosongAdapter.chat` rethrows as
 *     ContextOverflowError.
 *   - When the underlying generate resolves but the usage total breaches
 *     `params.contextWindow`, `chat` throws ContextOverflowError.
 *   - Normal-usage calls (under contextWindow) pass through untouched and
 *     return a regular ChatResponse.
 *   - ChatParams gains an optional `contextWindow` field used by the
 *     silent-overflow probe. Without it, silent detection is a no-op
 *     (Phase 5 Implementer chooses the fallback policy; this test only
 *     pins behaviour when contextWindow IS provided).
 *
 * These tests use a MockChatProvider variant that lets us script throws /
 * oversized usage. The current KosongAdapter (src/soul-plus/kosong-adapter.ts)
 * does NOT implement any of this — tests should FAIL loudly until Phase 5.
 */

import { MockChatProvider } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { KosongAdapter } from '../../src/soul-plus/index.js';
import { ContextOverflowError } from '../../src/soul/errors.js';
import type { ChatParams } from '../../src/soul/index.js';

interface ParamOverrides extends Partial<ChatParams> {
  contextWindow?: number;
}

function makeParams(overrides: ParamOverrides = {}): ChatParams {
  return {
    messages: [],
    tools: [],
    model: 'mock-model',
    systemPrompt: '',
    signal: new AbortController().signal,
    ...overrides,
  } as ChatParams;
}

/**
 * Subclass MockChatProvider so we can force `generate()` to reject with a
 * provider-specific PTL-like payload. MockChatProvider is structurally a
 * ChatProvider; we only need to override the streaming call path.
 */
class ThrowingProvider extends MockChatProvider {
  constructor(private readonly thrown: unknown) {
    super([{ type: 'text', text: 'unused' }]);
  }
  // `generate` is the entry kosong's aggregator drives. The actual method
  // name may differ between kosong minor versions; Phase 5 Implementer
  // adapts. Using a runtime monkey-patch below keeps the test
  // version-tolerant.
}

function attachThrow(provider: MockChatProvider, thrown: unknown): MockChatProvider {
  // MockChatProvider declares `generate` on its class prototype, so iterating
  // `Object.keys(provider)` will not see it. We assign directly on the
  // instance so the patched function shadows the prototype implementation
  // for the lifetime of this provider — kosong's top-level `generate(...)`
  // delegates to `provider.generate(...)` and observes the throw.
  (provider as unknown as { generate: (...args: unknown[]) => unknown }).generate = (
    ..._args: unknown[]
  ) => {
    throw thrown;
  };
  return provider;
}

describe('KosongAdapter — explicit PTL/413 mapping (决策 #96 L3)', () => {
  it('OpenAI-shaped "context_length_exceeded" error → ContextOverflowError', async () => {
    const providerErr = Object.assign(new Error('context_length_exceeded: 250K > 128K'), {
      code: 'context_length_exceeded',
      type: 'invalid_request_error',
      status: 400,
    });
    const provider = attachThrow(new MockChatProvider([{ type: 'text', text: 'x' }]), providerErr);
    const adapter = new KosongAdapter({ provider });

    await expect(adapter.chat(makeParams())).rejects.toBeInstanceOf(ContextOverflowError);
  });

  it('Anthropic-shaped "prompt is too long" error → ContextOverflowError', async () => {
    const providerErr = Object.assign(
      new Error('prompt is too long: 210000 tokens > 200000 maximum'),
      { status: 400, type: 'invalid_request_error' },
    );
    const provider = attachThrow(new MockChatProvider([{ type: 'text', text: 'x' }]), providerErr);
    const adapter = new KosongAdapter({ provider });

    await expect(adapter.chat(makeParams())).rejects.toBeInstanceOf(ContextOverflowError);
  });

  it('HTTP 413 Payload Too Large maps to ContextOverflowError', async () => {
    const providerErr = Object.assign(new Error('Payload Too Large'), { status: 413 });
    const provider = attachThrow(new MockChatProvider([{ type: 'text', text: 'x' }]), providerErr);
    const adapter = new KosongAdapter({ provider });

    await expect(adapter.chat(makeParams())).rejects.toBeInstanceOf(ContextOverflowError);
  });

  it('non-PTL errors (e.g. RateLimitError) are NOT mapped — they pass through', async () => {
    const rateErr = Object.assign(new Error('rate limit exceeded'), {
      status: 429,
      code: 'rate_limit_exceeded',
    });
    const provider = attachThrow(new MockChatProvider([{ type: 'text', text: 'x' }]), rateErr);
    // Slice 7.4: 429 is now retryable per 决策 #94. This test pins the
    // overflow-mapping decision (429 must NOT become a ContextOverflowError),
    // not the retry policy — disable retries here so the original error
    // surfaces immediately instead of after exponential backoff.
    const adapter = new KosongAdapter({ provider, maxRetries: 0 });

    await expect(adapter.chat(makeParams())).rejects.toMatchObject({
      message: 'rate limit exceeded',
    });
    // And must NOT be a ContextOverflowError.
    await expect(adapter.chat(makeParams())).rejects.not.toBeInstanceOf(ContextOverflowError);
  });
});

describe('KosongAdapter — silent overflow detection (决策 #96 L3)', () => {
  it('usage.input + usage.cache_read > contextWindow → throws ContextOverflowError', async () => {
    // MockChatProvider's constructor accepts a usage override we can use to
    // plant an oversized post-hoc reading.
    const provider = new MockChatProvider(
      [{ type: 'text', text: 'done' }],
      {
        usage: {
          inputOther: 150_000,
          output: 1_000,
          inputCacheRead: 100_000, // total "input side" = 250_000
          inputCacheCreation: 0,
        },
      },
    );
    const adapter = new KosongAdapter({ provider });

    await expect(
      adapter.chat(makeParams({ contextWindow: 200_000 })),
    ).rejects.toBeInstanceOf(ContextOverflowError);
  });

  it('normal usage under contextWindow resolves with a plain ChatResponse', async () => {
    const provider = new MockChatProvider(
      [{ type: 'text', text: 'hello' }],
      {
        usage: {
          inputOther: 10_000,
          output: 500,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      },
    );
    const adapter = new KosongAdapter({ provider });
    const response = await adapter.chat(makeParams({ contextWindow: 200_000 }));
    expect(response.message.role).toBe('assistant');
  });

  it('when contextWindow is undefined, the silent-overflow check is SKIPPED (no throw)', async () => {
    const provider = new MockChatProvider(
      [{ type: 'text', text: 'x' }],
      {
        usage: {
          inputOther: 999_000,
          output: 0,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      },
    );
    const adapter = new KosongAdapter({ provider });
    // No contextWindow → silent detection no-op. Must NOT throw.
    const response = await adapter.chat(makeParams());
    expect(response).toBeDefined();
  });
});
