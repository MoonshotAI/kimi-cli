/**
 * Compaction — Soul-driven context compression (§4.7 / §5.1.7).
 *
 * `shouldCompact` is the threshold gate called at every while-top safe
 * point inside `runSoulTurn`. When it returns true, `runCompaction`
 * executes the full lifecycle:
 *
 *   1. lifecycle.transitionTo("compacting") — drain writes
 *   2. compactionProvider.run(messages, signal) — generate summary
 *   3. journal.rotate(boundaryRecord) — atomic file rotation
 *   4. context.resetToSummary(summary) — reset in-memory history
 *   5. lifecycle.transitionTo("active") — always, even on failure
 *
 * These functions are pure (in the §5.0 rule 1 sense) — they receive
 * all dependencies via parameters, hold no module-level state, and are
 * testable in isolation.
 */

import type {
  SoulContextState,
  SummaryMessage as StorageSummaryMessage,
} from '../storage/context-state.js';
import type { EventSink } from './event-sink.js';
import type { Runtime, SummaryMessage as RuntimeSummaryMessage } from './runtime.js';

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

// ── SummaryMessage bridge ─────────────────────────────────────────────

/**
 * Convert runtime's `SummaryMessage` (from CompactionProvider) to
 * storage's `SummaryMessage` (for ContextState.resetToSummary).
 */
function bridgeSummaryMessage(
  providerSummary: RuntimeSummaryMessage,
  messagesCount: number,
  preCompactTokens: number,
): StorageSummaryMessage {
  return {
    summary: providerSummary.content,
    // compactedRange is relative to the current wire file, not the
    // session-global turn index. fromTurn=1 is correct even after prior
    // compactions because each wire file starts numbering from 1.
    compactedRange: {
      fromTurn: 1,
      toTurn: providerSummary.original_turn_count ?? messagesCount,
      messageCount: messagesCount,
    },
    preCompactTokens,
    postCompactTokens: providerSummary.original_token_count ?? 0,
    trigger: 'auto',
  };
}

// ── runCompaction (§5.1.7 L1534-L1564) ────────────────────────────────

/**
 * Execute the full compaction lifecycle. Called from `runSoulTurn` when
 * `shouldCompact` returns true.
 *
 * Contract per §5.1.7:
 *   - Transitions lifecycle to "compacting" at entry
 *   - Calls compactionProvider.run to generate summary
 *   - Calls journal.rotate with a CompactionBoundaryRecord
 *   - Calls context.resetToSummary to replace in-memory history
 *   - ALWAYS transitions lifecycle back to "active" in finally block
 *   - Emits compaction.begin / compaction.end events via sink
 */
export async function runCompaction(
  context: SoulContextState,
  runtime: Runtime,
  sink: EventSink,
  signal: AbortSignal,
): Promise<void> {
  await runtime.lifecycle.transitionTo('compacting');
  try {
    sink.emit({ type: 'compaction.begin' });
    signal.throwIfAborted();

    const messages = context.buildMessages();
    const preCompactTokens = context.tokenCountWithPending;
    const summary = await runtime.compactionProvider.run(messages, signal);
    signal.throwIfAborted();

    await runtime.journal.rotate({
      type: 'compaction_boundary',
      summary,
      parent_file: 'wire.jsonl',
    });
    signal.throwIfAborted();

    const storageSummary = bridgeSummaryMessage(summary, messages.length, preCompactTokens);
    await context.resetToSummary(storageSummary);
    signal.throwIfAborted();

    sink.emit({
      type: 'compaction.end',
      tokensBefore: preCompactTokens,
      tokensAfter: storageSummary.postCompactTokens,
    });
  } finally {
    await runtime.lifecycle.transitionTo('active');
  }
}
