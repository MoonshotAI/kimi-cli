/**
 * createRuntime — assembles the single-field Soul-visible `Runtime`.
 *
 * Phase 2 (todo/phase-2-compaction-out-of-soul.md Step 9): Runtime
 * collapsed to `{kosong}`. The previous 4-field shape included
 * `compactionProvider` / `lifecycle` / `journal`, which Soul drove
 * through `runCompaction`; that work moved into
 * `TurnManager.executeCompaction`. Those capabilities are now wired
 * directly onto `SoulPlusDeps` (and forwarded to `TurnManagerDeps`),
 * not onto Runtime.
 */

import type {
  CompactionProvider,
  JournalCapability,
  KosongAdapter,
  Runtime,
} from '../soul/index.js';

export interface RuntimeFactoryDeps {
  readonly kosong: KosongAdapter;
  /**
   * Phase 2: retained on the input type for backward-compat with
   * existing call sites that still pass a compaction provider, but
   * silently dropped by `createRuntime`. New capabilities travel via
   * `SoulPlusDeps` (and `TurnManagerDeps`) instead.
   */
  readonly compactionProvider?: CompactionProvider | undefined;
  /** Phase 2: accepted for compat, ignored. See `compactionProvider`. */
  readonly lifecycle?: unknown;
  /** Phase 2: accepted for compat, ignored. See `compactionProvider`. */
  readonly journal?: JournalCapability | undefined;
}

export function createRuntime(deps: RuntimeFactoryDeps): Runtime {
  return {
    kosong: deps.kosong,
  };
}

// ── Slice 3 placeholders ────────────────────────────────────────────

/**
 * Slice 3 compaction provider placeholder — Slice 6 will replace this
 * with a real summarisation path. The stub throws if anyone actually
 * calls `run`, because the Soul loop's `shouldCompact` stays false until
 * Slice 6 lands and nothing else should be reaching into compaction yet.
 */
export function createStubCompactionProvider(): CompactionProvider {
  return {
    async run() {
      throw new Error('compaction provider not implemented until Slice 6');
    },
  };
}

/**
 * Slice 3 journal capability placeholder — Slice 3.3 provides
 * `WiredJournalCapability` as the real implementation. The stub is a
 * silent no-op so code that optimistically calls `rotate` in a test
 * harness does not blow up.
 */
export function createStubJournalCapability(): JournalCapability {
  let rotationCount = 0;
  return {
    async rotate() {
      rotationCount += 1;
      return { archiveFile: `wire.${rotationCount}.jsonl` };
    },
    async readSessionInitialized() {
      throw new Error('createStubJournalCapability.readSessionInitialized is not supported');
    },
    async appendBoundary() {
      // No-op: stub capability doesn't actually rotate the wire, so
      // there's nothing to copy.
    },
  };
}
