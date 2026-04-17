/**
 * Compaction — Soul-side detection only (铁律 7, Phase 2).
 *
 * `shouldCompact` is the threshold gate called at every while-top safe
 * point inside `runSoulTurn`. When it returns true, Soul sets
 * `stopReason='needs_compaction'` and breaks; the actual lifecycle /
 * provider / journal / context-reset work is owned by the
 * `CompactionOrchestrator` in `src/soul-plus/compaction-orchestrator.ts`
 * (Phase 4 split from TurnManager — 决策 #109).
 *
 * This module previously also exported `runCompaction` and
 * `bridgeSummaryMessage`. Both moved to
 * `src/soul-plus/compaction-orchestrator.ts` (Phase 4); Phase 2
 * transitioned them out of Soul into `src/soul-plus/turn-manager.ts`,
 * and Phase 4 further extracted them into a dedicated orchestrator.
 */

import type { SoulContextState } from '../storage/context-state.js';

// ── Compaction configuration ──────────────────────────────────────────

/**
 * Configuration for the auto-compaction trigger.
 *
 * Two conditions, whichever fires first:
 *   - Ratio-based: tokenCountWithPending >= maxContextSize * triggerRatio
 *   - Reserved-based: tokenCountWithPending + reservedContextSize >= maxContextSize
 *
 * Aligned with Python `should_auto_compact` in `soul/compaction.py`.
 */
export interface CompactionConfig {
  /** Maximum context window size in tokens (model-dependent). */
  readonly maxContextSize: number;
  /** Fraction of maxContextSize at which compaction triggers. Default 0.85. */
  readonly triggerRatio?: number | undefined;
  /** Tokens to reserve for new messages. Default 50000. */
  readonly reservedContextSize?: number | undefined;
}

export const DEFAULT_TRIGGER_RATIO = 0.85;
export const DEFAULT_RESERVED_CONTEXT_SIZE = 50_000;

// ── shouldCompact ─────────────────────────────────────────────────────

/**
 * Determine whether auto-compaction should trigger.
 *
 * Aligned with Python `should_auto_compact`:
 *   - Ratio-based: tokenCountWithPending >= maxContextSize * triggerRatio
 *   - Reserved-based: tokenCountWithPending + reservedContextSize >= maxContextSize
 *
 * Returns false when config is undefined (no compaction configured).
 */
export function shouldCompact(context: SoulContextState, config?: CompactionConfig): boolean {
  if (config === undefined) return false;

  const triggerRatio = config.triggerRatio ?? DEFAULT_TRIGGER_RATIO;
  const reservedContextSize = config.reservedContextSize ?? DEFAULT_RESERVED_CONTEXT_SIZE;
  const tokens = context.tokenCountWithPending;

  // Ratio-based: tokenCountWithPending >= maxContextSize * triggerRatio
  if (tokens >= config.maxContextSize * triggerRatio) return true;

  // Reserved-based: tokenCountWithPending + reservedContextSize >= maxContextSize
  if (tokens + reservedContextSize >= config.maxContextSize) return true;

  return false;
}

// ── Token estimation ─────────────────────────────────────────────────

/**
 * Estimate token count from text content using a character-based heuristic.
 *
 * ~4 chars per token for English; somewhat underestimates for CJK text,
 * but this is a temporary estimate that gets corrected on the next LLM
 * call — the same heuristic Python's `estimate_text_tokens` uses.
 *
 * Slice 3.3 M01 fix: this replaces the buggy mapping of
 * `original_token_count` (which is the PRE-compaction token count) into
 * the `postCompactTokens` field. Using the pre-compaction count as the
 * post-compaction value caused `tokenCountWithPending` to remain at the
 * high-water mark after compaction, immediately re-triggering the
 * `shouldCompact` gate in an infinite loop.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
