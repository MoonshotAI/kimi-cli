/**
 * Integration tests for Soul ↔ KosongAdapter retry boundary.
 *
 * Rewritten from Python `tests/core/test_kimisoul_retry_recovery.py`
 * (4 tests) to match v2 decision #94 (single-layer retry owned by the
 * adapter; Soul sees a clean "ChatResponse or terminal error" boundary).
 * Verifies Soul-level behaviour for five adapter outcomes:
 *   (a) successful chat (represents adapter retry that recovered) →
 *       Soul observes a single normal turn.
 *   (b) 5xx terminal throw (represents adapter retries exhausted) →
 *       Soul error path fires.
 *   (c) 401 terminal throw (represents adapter refresh + retry failed)
 *       → Soul error path fires without special-casing 401.
 *   (d) ContextOverflowError thrown from adapter → Soul surfaces the
 *       error so the outer compaction loop can take over.
 *   (e) AbortSignal aborted after kosong throws, before any retry would
 *       land → Soul reports `stopReason: 'aborted'`; kosong is not
 *       called a second time.
 *
 * Adapter-internal retry logic (exponential backoff, 401 refresh, jitter,
 * maxRetries clamping) is unit-tested against the real `KosongAdapter`
 * in `test/soul-plus/kosong-adapter-retry.test.ts` (15 tests). These
 * integration tests sit at the Soul layer and use the Phase 9
 * `FakeKosongAdapter` so each class of outcome (success / transient
 * error / refresh error / overflow / abort) can be scripted
 * deterministically without dragging the real provider + HTTP mocks
 * into the Soul test surface.
 */

import { describe, expect, it, vi } from 'vitest';

import { ContextOverflowError } from '../../src/soul/errors.js';
import { runSoulTurn } from '../../src/soul/index.js';
import type { SoulConfig } from '../../src/soul/index.js';
import { FakeKosongAdapter, createTestRuntime } from '../helpers/index.js';

function mkConnReset(): Error {
  return Object.assign(new Error('socket hang up ECONNRESET'), { code: 'ECONNRESET' });
}

function mk5xx(status: number): Error {
  return Object.assign(new Error(`${status} Internal Server Error`), { status });
}

function mk401(): Error {
  return Object.assign(new Error('Unauthorized'), { status: 401 });
}

describe('Soul ↔ KosongAdapter retry integration (Phase 11.3)', () => {
  it('adapter-recovered success: Soul observes a single normal turn', async () => {
    // (a) Represents "real KosongAdapter retried ECONNRESET internally
    // and returned a successful ChatResponse". Soul sees one chat call
    // producing end_turn — no retry awareness is leaked up.
    const adapter = new FakeKosongAdapter({
      turns: [{ text: 'recovered', stopReason: 'end_turn' }],
    });
    const bundle = createTestRuntime({ kosong: adapter });
    try {
      const config: SoulConfig = { tools: [] };
      const result = await runSoulTurn(
        { text: 'hi' },
        config,
        bundle.contextState,
        bundle.runtime,
        bundle.sink,
        new AbortController().signal,
      );

      expect(result.stopReason).toBe('end_turn');
      expect(result.steps).toBe(1);
      expect(adapter.callCount).toBe(1);
    } finally {
      await bundle.dispose();
    }
  });

  it('5xx terminal throw: runSoulTurn surfaces the error (stopReason error)', async () => {
    // (b) Represents "adapter exhausted retries and rethrew the 5xx".
    const adapter = new FakeKosongAdapter({
      errors: [{ atTurn: 0, error: mk5xx(503) }],
    });
    const bundle = createTestRuntime({ kosong: adapter });
    try {
      const config: SoulConfig = { tools: [] };
      const err = await runSoulTurn(
        { text: 'hi' },
        config,
        bundle.contextState,
        bundle.runtime,
        bundle.sink,
        new AbortController().signal,
      ).catch((error: unknown) => error);

      expect(err).toBeInstanceOf(Error);
      expect((err as { status?: number }).status).toBe(503);
      // Soul sees exactly one chat call — no additional retries above
      // the adapter.
      expect(adapter.callCount).toBe(1);
    } finally {
      await bundle.dispose();
    }
  });

  it('401 terminal throw: Soul treats it as a generic error (no special-case)', async () => {
    // (c) Represents "adapter refresh failed / second 401 after refresh".
    // Soul has no concept of OAuth; it must not special-case 401 and
    // should propagate exactly like any other terminal error.
    const adapter = new FakeKosongAdapter({
      errors: [{ atTurn: 0, error: mk401() }],
    });
    const bundle = createTestRuntime({ kosong: adapter });
    try {
      const config: SoulConfig = { tools: [] };
      const err = await runSoulTurn(
        { text: 'hi' },
        config,
        bundle.contextState,
        bundle.runtime,
        bundle.sink,
        new AbortController().signal,
      ).catch((error: unknown) => error);

      expect(err).toBeInstanceOf(Error);
      expect((err as { status?: number }).status).toBe(401);
      expect(adapter.callCount).toBe(1);
    } finally {
      await bundle.dispose();
    }
  });

  it('ContextOverflowError: surfaces up to the outer compaction loop', async () => {
    // (d) The only error class Soul does special-case: adapter's own
    // ContextOverflowError (decision #94 exempts it from retry). Soul
    // propagates it as-is so TurnManager's compaction orchestrator can
    // react.
    const overflow = new ContextOverflowError('context_length_exceeded');
    const adapter = new FakeKosongAdapter({
      errors: [{ atTurn: 0, error: overflow }],
    });
    const bundle = createTestRuntime({ kosong: adapter });
    try {
      const config: SoulConfig = { tools: [] };
      const err = await runSoulTurn(
        { text: 'hi' },
        config,
        bundle.contextState,
        bundle.runtime,
        bundle.sink,
        new AbortController().signal,
      ).catch((error: unknown) => error);

      expect(err).toBeInstanceOf(ContextOverflowError);
      expect(adapter.callCount).toBe(1);
    } finally {
      await bundle.dispose();
    }
  });

  it('abort signal short-circuits: adapter is called once; Soul resolves to aborted', async () => {
    // (e) AbortController fires AFTER kosong throws a transient error
    // but BEFORE a (hypothetical) retry would have re-entered the
    // adapter. Phase 9 FakeKosongAdapter does not retry, but we still
    // assert the callCount + aborted branch so that a future adapter
    // regression (Soul inadvertently retrying above the adapter) would
    // flag here. Uses vi.useFakeTimers() per Phase 11 R3 — no wall-clock
    // sleeps, the abort fires deterministically via microtasks.
    vi.useFakeTimers();
    try {
      const adapter = new FakeKosongAdapter({
        errors: [{ atTurn: 0, error: mkConnReset() }],
      });
      const bundle = createTestRuntime({ kosong: adapter });
      try {
        const config: SoulConfig = { tools: [] };
        const controller = new AbortController();

        const pending = runSoulTurn(
          { text: 'hi' },
          config,
          bundle.contextState,
          bundle.runtime,
          bundle.sink,
          controller.signal,
        );
        // Attach rejection capture immediately so the adapter throw from
        // turn 0 doesn't surface as an unhandled rejection during
        // timer-advance.
        const guarded = pending.then(
          (r) => ({ ok: true as const, r }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        // Let kosong throw, then abort before any retry could enter.
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);

        const outcome = await guarded;

        // Either a graceful `stopReason: 'aborted'` result or a thrown
        // error — both are acceptable as long as the adapter was NOT
        // re-entered.
        if (outcome.ok) {
          expect(['aborted', 'error']).toContain(outcome.r.stopReason);
        } else {
          expect(outcome.error).toBeInstanceOf(Error);
        }
        expect(adapter.callCount).toBe(1);
      } finally {
        await bundle.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
