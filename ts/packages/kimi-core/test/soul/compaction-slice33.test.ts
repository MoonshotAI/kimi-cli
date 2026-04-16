/**
 * Slice 3.3 — Compaction regression + end-to-end tests.
 *
 * Covers:
 *   - M01 regression: shouldCompact returns false after compaction
 *   - M01: estimateTokens correctness
 *   - M04: runCompaction threads archiveFile through to resetToSummary
 *   - M05: TurnManager wires compactionConfig
 *   - End-to-end: auto-compaction in Soul loop
 */

import { describe, expect, it } from 'vitest';

import {
  type CompactionConfig,
  estimateTokens,
  runCompaction,
  shouldCompact,
} from '../../src/soul/compaction.js';
import { runSoulTurn } from '../../src/soul/run-turn.js';
import type {
  KosongAdapter,
  SummaryMessage as RuntimeSummaryMessage,
} from '../../src/soul/runtime.js';
import { InMemoryContextState } from '../../src/storage/context-state.js';
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

// ── M01 regression: no infinite compaction loop ─────────────────────

describe('M01 regression — compaction does not self-trigger', () => {
  const noopKosong: KosongAdapter = {
    async chat() {
      throw new Error('runCompaction should not call kosong.chat');
    },
  };

  it('after runCompaction, shouldCompact returns false (no re-trigger)', async () => {
    // Setup: context with high token count that triggers compaction
    const config: CompactionConfig = { maxContextSize: 200_000 };

    // Summary content: ~50 chars = ~13 tokens (estimateTokens)
    const summaryContent = 'User greeted. Assistant responded with world.';
    const summaryFromProvider: RuntimeSummaryMessage = {
      content: summaryContent,
      original_turn_count: 1,
      // Critically: original_token_count is the PRE-compaction count (high).
      // M01 bug: this used to be mapped to postCompactTokens, keeping
      // tokenCountWithPending high and re-triggering compaction.
      original_token_count: 200_000,
    };

    // Use InMemoryContextState which actually updates tokenCountWithPending
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });
    // Seed some history to simulate high token count
    await ctx.appendAssistantMessage({
      text: 'long response',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 100_000, output_tokens: 70_000 },
    });

    // Pre-condition: shouldCompact returns true
    expect(shouldCompact(ctx, config)).toBe(true);

    const sink = new CollectingEventSink();
    const lifecycleGate = createSpyLifecycleGate();
    const compactionProvider = createSpyCompactionProvider(summaryFromProvider);
    const journalCapability = createSpyJournalCapability();

    const { runtime } = createFakeRuntime({
      kosong: noopKosong,
      compactionProvider,
      lifecycle: lifecycleGate,
      journal: journalCapability,
    });

    await runCompaction(ctx, runtime, sink, new AbortController().signal);

    // Post-condition: tokenCountWithPending is now based on the summary's
    // estimated tokens (~12), NOT original_token_count (200K).
    // shouldCompact should return false.
    expect(ctx.tokenCountWithPending).toBe(estimateTokens(summaryContent));
    expect(ctx.tokenCountWithPending).toBeLessThan(200_000);
    expect(shouldCompact(ctx, config)).toBe(false);
  });

  it('postCompactTokens in bridged SummaryMessage is estimated from content, not original_token_count', async () => {
    const summaryContent = 'Short summary of the conversation.';
    const summaryFromProvider: RuntimeSummaryMessage = {
      content: summaryContent,
      original_token_count: 999_999, // This should NOT become postCompactTokens
    };

    const ctx = new FakeContextState({
      buildMessagesReturn: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
      initialTokenCountWithPending: 150_000,
    });
    const sink = new CollectingEventSink();
    const compactionProvider = createSpyCompactionProvider(summaryFromProvider);
    const journalCapability = createSpyJournalCapability();
    const lifecycleGate = createSpyLifecycleGate();

    const { runtime } = createFakeRuntime({
      kosong: noopKosong,
      compactionProvider,
      lifecycle: lifecycleGate,
      journal: journalCapability,
    });

    await runCompaction(ctx, runtime, sink, new AbortController().signal);

    const resetCalls = ctx.calls.filter((c) => c.kind === 'resetToSummary');
    expect(resetCalls.length).toBe(1);
    const summary = resetCalls[0]!.summary;

    // postCompactTokens should be estimated from content length, NOT 999_999
    expect(summary.postCompactTokens).toBe(estimateTokens(summaryContent));
    expect(summary.postCompactTokens).not.toBe(999_999);
    // preCompactTokens should be the original value
    expect(summary.preCompactTokens).toBe(150_000);
  });
});

// ── M04: archiveFile threaded through ────────────────────────────────

describe('M04 — archiveFile is threaded to resetToSummary', () => {
  const noopKosong: KosongAdapter = {
    async chat() {
      throw new Error('not expected');
    },
  };

  it('resetToSummary receives archiveFile from journal.rotate', async () => {
    const summaryFromProvider: RuntimeSummaryMessage = {
      content: 'compacted summary',
    };
    const ctx = new FakeContextState({
      buildMessagesReturn: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
      initialTokenCountWithPending: 100_000,
    });
    const sink = new CollectingEventSink();
    const compactionProvider = createSpyCompactionProvider(summaryFromProvider);
    const journalCapability = createSpyJournalCapability();
    const lifecycleGate = createSpyLifecycleGate();

    const { runtime } = createFakeRuntime({
      kosong: noopKosong,
      compactionProvider,
      lifecycle: lifecycleGate,
      journal: journalCapability,
    });

    await runCompaction(ctx, runtime, sink, new AbortController().signal);

    const resetCalls = ctx.calls.filter((c) => c.kind === 'resetToSummary');
    expect(resetCalls.length).toBe(1);
    // The spy journal capability returns 'wire.N.jsonl' based on rotation count
    expect(resetCalls[0]!.summary.archiveFile).toBe('wire.1.jsonl');
  });

  it('compaction.end event reports correct post-compact tokens', async () => {
    const summaryContent = 'A brief summary of the conversation so far.';
    const summaryFromProvider: RuntimeSummaryMessage = {
      content: summaryContent,
      original_token_count: 500_000, // This is the PRE-compact count
    };
    const ctx = new FakeContextState({
      buildMessagesReturn: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
      initialTokenCountWithPending: 180_000,
    });
    const sink = new CollectingEventSink();
    const compactionProvider = createSpyCompactionProvider(summaryFromProvider);
    const journalCapability = createSpyJournalCapability();
    const lifecycleGate = createSpyLifecycleGate();

    const { runtime } = createFakeRuntime({
      kosong: noopKosong,
      compactionProvider,
      lifecycle: lifecycleGate,
      journal: journalCapability,
    });

    await runCompaction(ctx, runtime, sink, new AbortController().signal);

    const endEvents = sink.events.filter((e) => e.type === 'compaction.end');
    expect(endEvents.length).toBe(1);
    const endEvent = endEvents[0] as {
      type: 'compaction.end';
      tokensBefore: number;
      tokensAfter: number;
    };
    expect(endEvent.tokensBefore).toBe(180_000);
    expect(endEvent.tokensAfter).toBe(estimateTokens(summaryContent));
  });
});

// ── C1: cancel during rotate — critical section integrity ────────────

describe('C1 — abort after rotate does not break critical section', () => {
  const noopKosong: KosongAdapter = {
    async chat() {
      throw new Error('runCompaction should not call kosong.chat');
    },
  };

  it('abort signalled during rotate still completes resetToSummary', async () => {
    // Setup: an AbortController that fires abort DURING the rotate await.
    // The journal capability's rotate() triggers the abort, simulating
    // a cancel arriving while rotate is in-flight. After rotate resolves,
    // the critical section must NOT check signal — it must proceed to
    // resetToSummary and complete it.
    const controller = new AbortController();
    const summaryContent = 'Compacted conversation summary.';
    const summaryFromProvider: RuntimeSummaryMessage = {
      content: summaryContent,
    };

    const ctx = new FakeContextState({
      buildMessagesReturn: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
      initialTokenCountWithPending: 150_000,
    });
    const sink = new CollectingEventSink();
    const compactionProvider = createSpyCompactionProvider(summaryFromProvider);
    const lifecycleGate = createSpyLifecycleGate();

    // Custom journal capability that aborts mid-rotate
    const journalCapability = createSpyJournalCapability();
    const originalRotate = journalCapability.rotate.bind(journalCapability);
    const abortingJournal: typeof journalCapability = {
      rotations: journalCapability.rotations,
      async rotate(boundaryRecord) {
        const result = await originalRotate(boundaryRecord);
        // Simulate abort arriving while rotate is executing
        controller.abort();
        return result;
      },
    };

    const { runtime } = createFakeRuntime({
      kosong: noopKosong,
      compactionProvider,
      lifecycle: lifecycleGate,
      journal: abortingJournal,
    });

    // runCompaction should complete successfully — the abort after
    // rotate must not interrupt the critical section.
    await runCompaction(ctx, runtime, sink, controller.signal);

    // Verify rotate was called
    expect(abortingJournal.rotations.length).toBe(1);

    // Verify resetToSummary was called (the critical section completed)
    const resetCalls = ctx.calls.filter((c) => c.kind === 'resetToSummary');
    expect(resetCalls.length).toBe(1);
    expect(resetCalls[0]!.summary.archiveFile).toBe('wire.1.jsonl');

    // Verify lifecycle returned to active
    expect(lifecycleGate.transitions).toContain('compacting');
    expect(lifecycleGate.transitions.at(-1)).toBe('active');

    // Verify compaction events were emitted
    expect(sink.typesIn()).toContain('compaction.begin');
    expect(sink.typesIn()).toContain('compaction.end');
  });

  it('abort before rotate (during provider.run) still aborts compaction', async () => {
    // This verifies the signal.throwIfAborted() BEFORE rotate is preserved.
    const controller = new AbortController();

    const ctx = new FakeContextState({
      buildMessagesReturn: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
      initialTokenCountWithPending: 150_000,
    });
    const sink = new CollectingEventSink();
    const lifecycleGate = createSpyLifecycleGate();
    const journalCapability = createSpyJournalCapability();

    // Compaction provider that aborts mid-run
    const abortingProvider = {
      calls: [] as unknown[],
      async run() {
        controller.abort();
        return { content: 'should not matter' };
      },
    };

    const { runtime } = createFakeRuntime({
      kosong: noopKosong,
      compactionProvider: abortingProvider as unknown as ReturnType<
        typeof createSpyCompactionProvider
      >,
      lifecycle: lifecycleGate,
      journal: journalCapability,
    });

    // Should throw AbortError because the abort happens before the critical section
    await expect(runCompaction(ctx, runtime, sink, controller.signal)).rejects.toThrow();

    // rotate should NOT have been called
    expect(journalCapability.rotations.length).toBe(0);

    // resetToSummary should NOT have been called
    const resetCalls = ctx.calls.filter((c) => c.kind === 'resetToSummary');
    expect(resetCalls.length).toBe(0);

    // lifecycle should still return to active (finally block)
    expect(lifecycleGate.transitions.at(-1)).toBe('active');
  });
});

// ── M05: TurnManager wires compactionConfig ──────────────────────────

describe('M05 — TurnManager compactionConfig wiring', () => {
  it('auto-compaction triggers during Soul turn when token pressure is high', async () => {
    // Setup: context with high tokens + compactionConfig → shouldCompact
    // returns true → runCompaction is called → summary replaces history →
    // shouldCompact returns false → turn continues → end_turn.
    //
    // Key insight: after compaction, the `continue` at the while-top goes
    // back to the shouldCompact check. With M01 fixed, the estimated
    // tokens from the summary are low enough that shouldCompact returns
    // false, and the turn proceeds to the next LLM call.
    const summaryContent = 'Previous conversation was compacted.';
    const summaryFromProvider: RuntimeSummaryMessage = {
      content: summaryContent,
    };

    // FakeContextState lets us set initialTokenCountWithPending high
    // to trigger compaction, then after resetToSummary it stays at the
    // initial value (FakeContextState doesn't actually update it).
    // But FakeContextState's shouldCompact check uses the initial value,
    // so we need it to return true on the FIRST check and false after.
    // We'll use a custom context that flips after the first compaction.

    let compactionDone = false;
    const ctx = new FakeContextState({
      buildMessagesReturn: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
      initialTokenCountWithPending: 180_000,
    });

    // Override tokenCountWithPending to drop after compaction
    const originalResetToSummary = ctx.resetToSummary.bind(ctx);
    ctx.resetToSummary = async (summary) => {
      await originalResetToSummary(summary);
      ctx.setTokenCountWithPending(estimateTokens(summaryContent));
      compactionDone = true;
    };

    const config: CompactionConfig = { maxContextSize: 200_000 };
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done', { input: 5, output: 5 })],
    });
    const compactionProvider = createSpyCompactionProvider(summaryFromProvider);
    const lifecycleGate = createSpyLifecycleGate();
    const journalCapability = createSpyJournalCapability();

    const { runtime } = createFakeRuntime({
      kosong,
      compactionProvider,
      lifecycle: lifecycleGate,
      journal: journalCapability,
    });
    const sink = new CollectingEventSink();

    const result = await runSoulTurn(
      { text: 'go' },
      { tools: [], compactionConfig: config },
      ctx,
      runtime,
      sink,
      new AbortController().signal,
    );

    // Verify compaction happened
    expect(compactionDone).toBe(true);
    expect(compactionProvider.calls.length).toBe(1);
    expect(lifecycleGate.transitions).toContain('compacting');
    expect(lifecycleGate.transitions).toContain('active');
    expect(journalCapability.rotations.length).toBe(1);

    // Verify the turn still completed normally after compaction
    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(1);

    // Verify events
    expect(sink.typesIn()).toContain('compaction.begin');
    expect(sink.typesIn()).toContain('compaction.end');
  });

  it('no compaction when compactionConfig is undefined', async () => {
    const ctx = new FakeContextState({
      initialTokenCountWithPending: 999_999,
    });
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done', { input: 5, output: 5 })],
    });
    const compactionProvider = createSpyCompactionProvider();
    const { runtime } = createFakeRuntime({ kosong, compactionProvider });
    const sink = new CollectingEventSink();

    await runSoulTurn(
      { text: 'go' },
      { tools: [] }, // no compactionConfig
      ctx,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(compactionProvider.calls.length).toBe(0);
  });
});
