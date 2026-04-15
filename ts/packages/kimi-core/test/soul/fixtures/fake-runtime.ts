/**
 * Test helper — assemble a v2 `Runtime` with the four required fields
 * (`kosong` / `compactionProvider` / `lifecycle` / `journal`). Callers pass
 * a `KosongAdapter` (usually the scripted one) and get back a Runtime with
 * no-op implementations for the three SoulPlus-owned fields.
 *
 * Compaction tests can override `compactionProvider` / `lifecycle` /
 * `journal` per-call to install a spy.
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
  const runtime: Runtime = {
    kosong: overrides.kosong,
    compactionProvider,
    lifecycle,
    journal,
  };
  return { runtime, compactionProvider, lifecycle, journal };
}
