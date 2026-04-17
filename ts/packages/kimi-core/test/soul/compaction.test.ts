/**
 * Soul-layer compaction detection tests.
 *
 * Covers:
 *   - `shouldCompact` threshold logic (ratio-based + reserved-based)
 *
 * Phase 2 (todo/phase-2-compaction-out-of-soul.md): the previous
 * `runCompaction` orchestration describe block was removed along with
 * the function itself. The equivalent execution pipeline now lives on
 * `TurnManager.executeCompaction` and is covered by
 * `test/soul-plus/turn-manager-compaction-loop.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  type CompactionConfig,
  DEFAULT_RESERVED_CONTEXT_SIZE,
  DEFAULT_TRIGGER_RATIO,
  shouldCompact,
} from '../../src/soul/compaction.js';
import { FakeContextState } from './fixtures/fake-context-state.js';

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
