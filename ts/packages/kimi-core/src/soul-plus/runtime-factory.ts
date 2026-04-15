/**
 * createRuntime — assembles the 4-field `Runtime` (v2 §5.1.5 / §5.8.2)
 * from SoulPlus-internal parts.
 *
 * The Slice 2 `Runtime` interface is intentionally rigid: exactly four
 * fields, no more. This factory centralises the assembly so SoulPlus
 * constructor code is not tempted to sneak a fifth field in.
 */

import type {
  CompactionProvider,
  JournalCapability,
  KosongAdapter,
  LifecycleGate,
  Runtime,
} from '../soul/index.js';

export interface RuntimeFactoryDeps {
  readonly kosong: KosongAdapter;
  readonly compactionProvider: CompactionProvider;
  readonly lifecycle: LifecycleGate;
  readonly journal: JournalCapability;
}

export function createRuntime(deps: RuntimeFactoryDeps): Runtime {
  return {
    kosong: deps.kosong,
    compactionProvider: deps.compactionProvider,
    lifecycle: deps.lifecycle,
    journal: deps.journal,
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
  };
}
