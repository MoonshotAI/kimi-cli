/**
 * Phase 13 §3.2 — Soul recovers when the LLM call hangs and the
 * external abort controller fires.
 *
 * `test/soul/run-turn-abort.test.ts:46` already covers the case where
 * the adapter self-aborts mid-call via `abortOnIndex`. Here we test a
 * strictly harder case: `chat()` returns a Promise that NEVER
 * resolves on its own, and convergence depends on the adapter
 * respecting the caller's `signal.addEventListener('abort', ...)`
 * contract. A missing listener = an unrecoverable turn — that's the
 * regression this guards against.
 */

import { describe, expect, it, vi } from 'vitest';

const SKIP_PERF = process.env['SKIP_PERF'] === '1';

import { runSoulTurn } from '../../src/soul/index.js';
import type {
  ChatParams,
  ChatResponse,
  KosongAdapter,
  SoulConfig,
} from '../../src/soul/index.js';
import { CollectingEventSink } from '../soul/fixtures/collecting-event-sink.js';
import { FakeContextState } from '../soul/fixtures/fake-context-state.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';

/**
 * Adapter whose `chat()` hangs forever unless the caller's signal
 * aborts — at which point we reject with an AbortError, same shape as
 * the real streaming adapter.
 */
class HangingKosongAdapter implements KosongAdapter {
  callCount = 0;
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.callCount += 1;
    return new Promise<ChatResponse>((_resolve, reject) => {
      const onAbort = (): void => {
        const err = new Error('LLM chat aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (params.signal.aborted) {
        onAbort();
        return;
      }
      params.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

describe.skipIf(SKIP_PERF)('runSoulTurn — LLM hang recovery (Phase 13 §3.2) [perf]', () => {
  it('abort during a perpetually-hanging chat() converges on stopReason=aborted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const context = new FakeContextState();
      const controller = new AbortController();
      const kosong = new HangingKosongAdapter();
      const { runtime } = createFakeRuntime({ kosong });
      const sink = new CollectingEventSink();
      const config: SoulConfig = { tools: [] };

      const turnPromise = runSoulTurn(
        { text: 'ask the void' },
        config,
        context,
        runtime,
        sink,
        controller.signal,
      );

      setTimeout(() => {
        controller.abort();
      }, 200);

      await vi.advanceTimersByTimeAsync(250);
      const result = await turnPromise;

      expect(result.stopReason).toBe('aborted');
      expect(kosong.callCount).toBe(1);
      // When chat() rejects before emitting any delta, Soul MUST NOT
      // have written any partial assistant message into context.
      expect(context.assistantCalls()).toHaveLength(0);
      expect(sink.byType('step.interrupted')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
