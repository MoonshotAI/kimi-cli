/**
 * Slice 3.3 — Soul-side compaction regression tests.
 *
 * Phase 2 (todo/phase-2-compaction-out-of-soul.md): the previous
 * M01 / M04 / C1 / M05 describe blocks drove the deleted
 * `runCompaction` function directly; compaction execution now lives on
 * `TurnManager.executeCompaction` and is covered by
 * `test/soul-plus/turn-manager-compaction-loop.test.ts`.
 *
 * What stays in this file:
 *   - `estimateTokens` heuristic (pure function, unchanged)
 *   - Soul negative path: when `compactionConfig` is undefined, Soul
 *     does not even probe compaction capabilities.
 *
 * What moved elsewhere:
 *   - M01 / M04 / C1: now tested on TurnManager.executeCompaction
 *     (see `test/soul-plus/turn-manager-compaction-loop.test.ts`).
 *   - M05 auto-compaction-inside-Soul: Soul no longer executes
 *     compaction; the Soul → TurnManager handoff is covered by
 *     `test/soul/run-turn-compaction-signal.test.ts` (T1) and the
 *     TurnManager while-loop by
 *     `test/soul-plus/turn-manager-compaction-loop.test.ts` (T2).
 */

import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../../src/soul/compaction.js';
import { runSoulTurn } from '../../src/soul/run-turn.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import {
  createFakeRuntime,
  createSpyCompactionProvider,
} from './fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

// ── M01: estimateTokens ──────────────────────────────────────────────

describe('estimateTokens — token estimation heuristic', () => {
  it('estimates ~1 token per 4 characters', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('rounds up for non-multiple-of-4 lengths', () => {
    expect(estimateTokens('abc')).toBe(1); // ceil(3/4) = 1
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/4) = 2
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles long text correctly', () => {
    const text = 'a'.repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });
});

// ── Soul negative path: no compactionConfig → no probes ─────────────

describe('Soul compaction gate — disabled when config is absent', () => {
  it('no compaction signal when compactionConfig is undefined', async () => {
    const ctx = new FakeContextState({
      initialTokenCountWithPending: 999_999,
    });
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done', { input: 5, output: 5 })],
    });
    const compactionProvider = createSpyCompactionProvider();
    const { runtime } = createFakeRuntime({ kosong, compactionProvider });
    const sink = new CollectingEventSink();

    const result = await runSoulTurn(
      { text: 'go' },
      { tools: [] }, // no compactionConfig
      ctx,
      runtime,
      sink,
      new AbortController().signal,
    );

    // Soul reaches the LLM and completes normally — no needs_compaction
    // signal raised because the gate is disabled.
    expect(result.stopReason).toBe('end_turn');
    expect(compactionProvider.calls.length).toBe(0);
  });
});
