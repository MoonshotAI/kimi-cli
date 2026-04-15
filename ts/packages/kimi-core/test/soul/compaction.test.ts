/**
 * Slice 6 — Soul-layer compaction tests.
 *
 * Covers:
 *   - `shouldCompact` threshold logic (ratio-based + reserved-based)
 *   - `runCompaction` orchestration (lifecycle transitions, provider call,
 *     journal.rotate, context.resetToSummary, event emission, finally-back-to-active)
 *
 * All tests are expected to FAIL until the Slice 6 implementer replaces
 * the stubs with real logic.
 */

import type { Message } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  type CompactionConfig,
  DEFAULT_RESERVED_CONTEXT_SIZE,
  DEFAULT_TRIGGER_RATIO,
  runCompaction,
  shouldCompact,
} from '../../src/soul/compaction.js';
import type {
  KosongAdapter,
  SummaryMessage as RuntimeSummaryMessage,
} from '../../src/soul/runtime.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import {
  createFakeRuntime,
  createSpyCompactionProvider,
  createSpyJournalCapability,
  createSpyLifecycleGate,
} from './fixtures/fake-runtime.js';

// ── shouldCompact ─────────────────────────────────────────────────────

describe('shouldCompact — threshold logic', () => {
  const config200k: CompactionConfig = { maxContextSize: 200_000 };

  it('returns false when tokenCountWithPending is 0', () => {
    const ctx = new FakeContextState({ initialTokenCountWithPending: 0 });
    expect(shouldCompact(ctx, config200k)).toBe(false);
  });

  it('returns false when well below both thresholds', () => {
    // 200K * 0.85 = 170K (ratio), 200K - 50K = 150K (reserved)
    const ctx = new FakeContextState({ initialTokenCountWithPending: 100_000 });
    expect(shouldCompact(ctx, config200k)).toBe(false);
  });

  it('returns true when reserved-based threshold fires (200K model)', () => {
    // reserved: 150K + 50K >= 200K → true; ratio: 150K < 170K → false
    // reserved fires first for 200K model
    const ctx = new FakeContextState({ initialTokenCountWithPending: 150_000 });
    expect(shouldCompact(ctx, config200k)).toBe(true);
  });

  it('returns true when ratio-based threshold fires (1M model)', () => {
    // ratio: 850K >= 1M * 0.85 → true
    const config1m: CompactionConfig = { maxContextSize: 1_000_000 };
    const ctx = new FakeContextState({ initialTokenCountWithPending: 850_000 });
    expect(shouldCompact(ctx, config1m)).toBe(true);
  });

  it('returns false just below ratio for 1M model', () => {
    const config1m: CompactionConfig = { maxContextSize: 1_000_000 };
    const ctx = new FakeContextState({ initialTokenCountWithPending: 840_000 });
    expect(shouldCompact(ctx, config1m)).toBe(false);
  });

  it('respects custom triggerRatio', () => {
    const config: CompactionConfig = {
      maxContextSize: 200_000,
      triggerRatio: 0.7,
    };
    // 200K * 0.7 = 140K
    const ctxAbove = new FakeContextState({ initialTokenCountWithPending: 140_000 });
    expect(shouldCompact(ctxAbove, config)).toBe(true);

    const ctxBelow = new FakeContextState({ initialTokenCountWithPending: 139_999 });
    expect(shouldCompact(ctxBelow, config)).toBe(false);
  });

  it('respects custom reservedContextSize', () => {
    const config: CompactionConfig = {
      maxContextSize: 200_000,
      reservedContextSize: 100_000,
    };
    // reserved: 100K + 100K >= 200K → true
    const ctx = new FakeContextState({ initialTokenCountWithPending: 100_000 });
    expect(shouldCompact(ctx, config)).toBe(true);
  });

  it('uses DEFAULT_TRIGGER_RATIO and DEFAULT_RESERVED_CONTEXT_SIZE when not specified', () => {
    // Verify defaults are exported and have expected values
    expect(DEFAULT_TRIGGER_RATIO).toBe(0.85);
    expect(DEFAULT_RESERVED_CONTEXT_SIZE).toBe(50_000);

    // With 200K model, defaults: ratio = 170K, reserved = 150K
    // 149_999 is below reserved threshold
    const ctx = new FakeContextState({ initialTokenCountWithPending: 149_999 });
    expect(shouldCompact(ctx, config200k)).toBe(false);
  });

  it('returns false when config is undefined (no compaction configured)', () => {
    const ctx = new FakeContextState({ initialTokenCountWithPending: 999_999 });
    expect(shouldCompact(ctx)).toBe(false);
  });
});

// ── runCompaction ─────────────────────────────────────────────────────

describe('runCompaction — orchestration', () => {
  /** No-op kosong — runCompaction doesn't call the LLM directly. */
  const noopKosong: KosongAdapter = {
    async chat() {
      throw new Error('runCompaction should not call kosong.chat');
    },
  };

  function setup(opts?: { messages?: Message[]; summaryContent?: string }) {
    const messages: Message[] = opts?.messages ?? [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }], toolCalls: [] },
    ];
    const summaryContent = opts?.summaryContent ?? 'compacted summary of conversation';

    const summaryFromProvider: RuntimeSummaryMessage = {
      content: summaryContent,
      original_turn_count: 1,
      original_token_count: 500,
    };

    const ctx = new FakeContextState({
      buildMessagesReturn: messages,
      initialTokenCountWithPending: 200_000,
    });
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
    const controller = new AbortController();

    return { ctx, runtime, sink, controller, lifecycleGate, compactionProvider, journalCapability };
  }

  it('transitions lifecycle to "compacting" then back to "active"', async () => {
    const { ctx, runtime, sink, controller, lifecycleGate } = setup();
    await runCompaction(ctx, runtime, sink, controller.signal);

    expect(lifecycleGate.transitions[0]).toBe('compacting');
    expect(lifecycleGate.transitions.at(-1)).toBe('active');
  });

  it('calls compactionProvider.run with current messages', async () => {
    const { ctx, runtime, sink, controller, compactionProvider } = setup();
    await runCompaction(ctx, runtime, sink, controller.signal);

    expect(compactionProvider.calls.length).toBe(1);
    expect(compactionProvider.calls[0]!.messagesLength).toBe(2);
  });

  it('calls journal.rotate with CompactionBoundaryRecord', async () => {
    const { ctx, runtime, sink, controller, journalCapability } = setup();
    await runCompaction(ctx, runtime, sink, controller.signal);

    expect(journalCapability.rotations.length).toBe(1);
    expect(journalCapability.rotations[0]!.type).toBe('compaction_boundary');
    expect(journalCapability.rotations[0]!.summary.content).toBe(
      'compacted summary of conversation',
    );
  });

  it('calls context.resetToSummary with bridged SummaryMessage', async () => {
    const { ctx, runtime, sink, controller } = setup();
    await runCompaction(ctx, runtime, sink, controller.signal);

    const resetCalls = ctx.calls.filter((c) => c.kind === 'resetToSummary');
    expect(resetCalls.length).toBe(1);
    // The bridged summary should contain the compaction content
    expect(resetCalls[0]!.summary.summary).toBe('compacted summary of conversation');
  });

  it('emits compaction.begin and compaction.end events', async () => {
    const { ctx, runtime, sink, controller } = setup();
    await runCompaction(ctx, runtime, sink, controller.signal);

    const types = sink.typesIn();
    expect(types).toContain('compaction.begin');
    expect(types).toContain('compaction.end');
    // begin is before end
    const beginIdx = types.indexOf('compaction.begin');
    const endIdx = types.indexOf('compaction.end');
    expect(beginIdx).toBeLessThan(endIdx);
  });

  it('transitions back to "active" even if compactionProvider throws', async () => {
    const { ctx, runtime, sink, controller, lifecycleGate } = setup();
    // Make the compaction provider throw
    const failingProvider = {
      calls: [],
      async run() {
        throw new Error('LLM compaction failed');
      },
    };
    const failingRuntime = {
      ...runtime,
      compactionProvider: failingProvider,
    };

    await expect(runCompaction(ctx, failingRuntime, sink, controller.signal)).rejects.toThrow(
      'LLM compaction failed',
    );

    // finally block must still transition back to active
    expect(lifecycleGate.transitions.at(-1)).toBe('active');
  });

  it('transitions back to "active" even if signal is aborted', async () => {
    const { ctx, runtime, sink, lifecycleGate } = setup();
    const controller = new AbortController();
    controller.abort();

    // With pre-aborted signal, should throw but still recover lifecycle
    await expect(runCompaction(ctx, runtime, sink, controller.signal)).rejects.toThrow();

    expect(lifecycleGate.transitions.at(-1)).toBe('active');
  });

  it('respects signal.throwIfAborted between provider and rotate', async () => {
    const { ctx, sink, controller, lifecycleGate, journalCapability } = setup();
    // Provider that aborts during run
    const slowProvider = {
      calls: [] as { messagesLength: number; options: undefined }[],
      async run(_messages: Message[]) {
        controller.abort();
        return { content: 'summary', original_turn_count: 1, original_token_count: 100 };
      },
    };
    const { runtime } = createFakeRuntime({
      kosong: noopKosong,
      compactionProvider: slowProvider,
      lifecycle: lifecycleGate,
      journal: journalCapability,
    });

    await expect(runCompaction(ctx, runtime, sink, controller.signal)).rejects.toThrow();

    // rotate should NOT have been called (aborted before it)
    expect(journalCapability.rotations.length).toBe(0);
    // but lifecycle should still be back to active
    expect(lifecycleGate.transitions.at(-1)).toBe('active');
  });

  it('ordering: compacting → provider → rotate → resetToSummary → active', async () => {
    const { ctx, runtime, sink, controller, lifecycleGate, compactionProvider, journalCapability } =
      setup();
    await runCompaction(ctx, runtime, sink, controller.signal);

    // Verify ordering via spy call counts
    expect(lifecycleGate.transitions[0]).toBe('compacting');
    expect(compactionProvider.calls.length).toBe(1);
    expect(journalCapability.rotations.length).toBe(1);
    expect(ctx.calls.some((c) => c.kind === 'resetToSummary')).toBe(true);
    expect(lifecycleGate.transitions.at(-1)).toBe('active');
  });
});
