/**
 * Test helper — assemble a Soul `Runtime`.
 *
 * Phase 2: Runtime collapsed to `{kosong}`. The spy capability factories
 * (`createSpyCompactionProvider` / `createSpyLifecycleGate` /
 * `createSpyJournalCapability`) are retained because existing tests still
 * assert that Soul does NOT drive those capabilities — we need spies
 * whose call counters stay at zero. They are surfaced in the returned
 * `FakeRuntimeBundle` alongside the narrow `runtime`, so tests that inject
 * them into `TurnManagerDeps` or pass them to an old-style `runCompaction`
 * fixture can still reach them by name.
 */

import type {
  CompactionBoundaryRecord,
  CompactionOptions,
  CompactionProvider,
  JournalCapability,
  KosongAdapter,
  LifecycleGate,
  RotateResult,
  Runtime,
  SummaryMessage,
} from '../../../src/soul/index.js';

export interface SpyCompactionProvider extends CompactionProvider {
  readonly calls: {
    messagesLength: number;
    options: CompactionOptions | undefined;
  }[];
}

export interface SpyLifecycleGate extends LifecycleGate {
  readonly transitions: string[];
}

export interface SpyJournalCapability extends JournalCapability {
  readonly rotations: CompactionBoundaryRecord[];
}

export function createSpyCompactionProvider(summary?: SummaryMessage): SpyCompactionProvider {
  const effectiveSummary: SummaryMessage = summary ?? { content: 'test summary' };
  const calls: { messagesLength: number; options: CompactionOptions | undefined }[] = [];
  return {
    calls,
    async run(messages, _signal, options) {
      calls.push({ messagesLength: messages.length, options });
      return effectiveSummary;
    },
  };
}

export function createSpyLifecycleGate(): SpyLifecycleGate {
  const transitions: string[] = [];
  return {
    transitions,
    async transitionTo(state) {
      transitions.push(state);
    },
  };
}

export function createSpyJournalCapability(): SpyJournalCapability {
  const rotations: CompactionBoundaryRecord[] = [];
  return {
    rotations,
    async rotate(boundaryRecord): Promise<RotateResult> {
      rotations.push(boundaryRecord);
      return { archiveFile: `wire.${rotations.length}.jsonl` };
    },
  };
}

export interface FakeRuntimeOverrides {
  kosong: KosongAdapter;
  compactionProvider?: CompactionProvider;
  lifecycle?: LifecycleGate;
  journal?: JournalCapability;
}

export interface FakeRuntimeBundle {
  runtime: Runtime;
  compactionProvider: CompactionProvider;
  lifecycle: LifecycleGate;
  journal: JournalCapability;
}

export function createFakeRuntime(overrides: FakeRuntimeOverrides): FakeRuntimeBundle {
  const compactionProvider = overrides.compactionProvider ?? createSpyCompactionProvider();
  const lifecycle = overrides.lifecycle ?? createSpyLifecycleGate();
  const journal = overrides.journal ?? createSpyJournalCapability();
  // Phase 2: Runtime now only has `kosong`. We still surface the spy
  // capabilities on the returned bundle so tests can pin "Soul did NOT
  // touch them" assertions (T1 A / compaction-gate).
  const runtime: Runtime = {
    kosong: overrides.kosong,
  };
  return { runtime, compactionProvider, lifecycle, journal };
}
