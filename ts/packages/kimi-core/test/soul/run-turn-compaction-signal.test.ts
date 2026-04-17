/**
 * Phase 2 (Slice 2 / todo phase-2-compaction-out-of-soul.md) — Soul's new
 * compaction contract.
 *
 * Semantics this file pins:
 *
 *   1. When `shouldCompact(context, config.compactionConfig)` is true at
 *      the while-top safe point, `runSoulTurn` must set
 *      `stopReason = 'needs_compaction'` and `break` WITHOUT executing any
 *      compaction side effect. The signal is the only thing Soul is
 *      allowed to produce — the actual lifecycle / provider / journal /
 *      context-reset work belongs to `TurnManager.executeCompaction` from
 *      this point on (铁律 7).
 *
 *   2. When `shouldCompact` is false, the existing single-step end_turn
 *      flow is unchanged (regression guard so the v1 happy path does not
 *      drift while we rewire the compaction branch).
 *
 * This file is expected to FAIL against the current code:
 *   - `StopReason` does not yet include `'needs_compaction'` (src/soul/types.ts)
 *   - The while-top block still calls `runCompaction(...)` which drives
 *     lifecycle / compactionProvider / journal / resetToSummary through
 *     Runtime. Those spies will record activity, failing the
 *     `length === 0` assertions.
 *
 * After Phase 2 implementation:
 *   - `StopReason` gains `'needs_compaction'`
 *   - `runSoulTurn` reports + breaks; none of the three capability spies
 *     observe a call.
 */

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/run-turn.js';
import type { KosongAdapter, Runtime } from '../../src/soul/runtime.js';
import type { SoulConfig } from '../../src/soul/types.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import {
  createFakeRuntime,
  createSpyCompactionProvider,
  createSpyJournalCapability,
  createSpyLifecycleGate,
} from './fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

const noopKosong: KosongAdapter = {
  async chat() {
    throw new Error('kosong.chat must not be called on a needs_compaction-signal turn');
  },
};

describe('runSoulTurn — Phase 2 needs_compaction signal', () => {
  it('A — shouldCompact=true on the first iteration → returns {stopReason:needs_compaction, steps:0} without driving any compaction capability', async () => {
    // 200K-model defaults: reserved threshold = 150K. Seed 200K so the
    // while-top `shouldCompact` gate fires on the very first iteration,
    // BEFORE any LLM call or step-counter increment.
    const ctx = new FakeContextState({ initialTokenCountWithPending: 200_000 });
    // Guard against the *pre-Phase-2* codepath looping forever:
    // current `runCompaction` calls `context.resetToSummary` but
    // `FakeContextState.resetToSummary` only records the call; it
    // does NOT reset `tokenCountWithPending`, so `shouldCompact` stays
    // true on the next iteration and the while loop OOMs. We patch the
    // method on this instance so the pre-Phase-2 run exits the loop
    // after one `runCompaction` call, then fails loudly inside
    // `noopKosong.chat`. After Phase 2 the method is never called, so
    // this patch is simply inert (and `calls.length` for `resetToSummary`
    // stays at 0).
    const originalReset = ctx.resetToSummary.bind(ctx);
    ctx.resetToSummary = async (summary) => {
      await originalReset(summary);
      ctx.setTokenCountWithPending(0);
    };
    const sink = new CollectingEventSink();
    const lifecycleGate = createSpyLifecycleGate();
    const compactionProvider = createSpyCompactionProvider();
    const journalCapability = createSpyJournalCapability();
    const { runtime } = createFakeRuntime({
      kosong: noopKosong,
      compactionProvider,
      lifecycle: lifecycleGate,
      journal: journalCapability,
    });
    const controller = new AbortController();
    const soulConfig: SoulConfig = {
      tools: [],
      compactionConfig: { maxContextSize: 200_000 },
    };

    const result = await runSoulTurn(
      { text: 'hi' },
      soulConfig,
      ctx,
      runtime,
      sink,
      controller.signal,
    ).catch((err: unknown) => {
      // Under pre-Phase-2 code, `runCompaction` runs once, `resetToSummary`
      // zeros the token count (see patch above), and the next iteration
      // tries to step which invokes `noopKosong.chat` and throws. Re-raise
      // so the test fails loudly rather than silently swallowing the error;
      // the `toBe('needs_compaction')` assertion below on a rejected
      // promise would never run, so we surface the error explicitly.
      throw err;
    });

    // Core signal contract.
    expect(result.stopReason).toBe('needs_compaction');
    expect(result.steps).toBe(0);

    // Zero-side-effect contract (铁律 7): Soul reports, TurnManager executes.
    expect(lifecycleGate.transitions).toEqual([]);
    expect(compactionProvider.calls.length).toBe(0);
    expect(journalCapability.rotations.length).toBe(0);
    expect(ctx.calls.filter((c) => c.kind === 'resetToSummary').length).toBe(0);

    // The Soul-layer sink must NOT have witnessed compaction lifecycle
    // events — those are now TurnManager's to emit from executeCompaction.
    expect(sink.typesIn()).not.toContain('compaction.begin');
    expect(sink.typesIn()).not.toContain('compaction.end');
    // And Soul must not have started a step either (steps=0 above, plus
    // no step.begin event).
    expect(sink.typesIn()).not.toContain('step.begin');
  });

  it('B — shouldCompact=false → existing one-step end_turn regression is intact', async () => {
    // Token count well under both default thresholds; Soul stays on the
    // pre-compaction code path and runs a single step to completion.
    const ctx = new FakeContextState({ initialTokenCountWithPending: 0 });
    const sink = new CollectingEventSink();
    const lifecycleGate = createSpyLifecycleGate();
    const compactionProvider = createSpyCompactionProvider();
    const journalCapability = createSpyJournalCapability();
    const scripted = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('ok', { input: 1, output: 1 })],
    });
    const { runtime } = createFakeRuntime({
      kosong: scripted,
      compactionProvider,
      lifecycle: lifecycleGate,
      journal: journalCapability,
    });
    const controller = new AbortController();
    const soulConfig: SoulConfig = {
      tools: [],
      compactionConfig: { maxContextSize: 200_000 },
    };

    const result = await runSoulTurn(
      { text: 'hi' },
      soulConfig,
      ctx,
      runtime,
      sink,
      controller.signal,
    );

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(1);
    // No compaction capability was driven — shouldCompact was false.
    expect(lifecycleGate.transitions).toEqual([]);
    expect(compactionProvider.calls.length).toBe(0);
    expect(journalCapability.rotations.length).toBe(0);
  });
});

// `Runtime` is imported only to keep the type reference live — the test
// does not exercise its shape (T3 does that). Importing it here ensures
// this file rebreaks visibly if the Runtime import path is moved.
type _RuntimeTypeAnchor = Runtime;
