/**
 * Slice 3 test harness helpers.
 *
 * The goal is to keep individual test files focused on assertions, not on
 * plumbing the 8 dependencies a `TurnManager` needs. The harness wires up
 * real Slice 1 storage + real Slice 2 `runSoulTurn` with a scripted
 * kosong adapter from the Slice 2 fixture suite.
 *
 * Reuse order:
 *   1. Slice 2 fixtures (`../../soul/fixtures/*`) — `ScriptedKosongAdapter`,
 *      `CollectingEventSink`, `EchoTool`, `buildContext()`, ...
 *   2. Slice 1 real implementations — `InMemoryContextState`,
 *      `InMemorySessionJournalImpl`
 *   3. Slice 3 stubs — `SessionLifecycleStateMachine`,
 *      `SoulLifecycleGate`, `SessionEventBus`, `SoulRegistry`,
 *      `createRuntime`, `TurnManager`, `SoulPlus`
 */

import type {
  CompactionProvider,
  JournalCapability,
  KosongAdapter,
  LifecycleGate as SoulLifecycleGate,
  Runtime,
} from '../../../src/soul/index.js';
import { InMemoryContextState } from '../../../src/storage/context-state.js';
import type { FullContextState } from '../../../src/storage/context-state.js';
import type {
  LifecycleGate as JournalLifecycleGate,
  LifecycleState,
} from '../../../src/storage/journal-writer.js';
import type { InMemorySessionJournal } from '../../../src/storage/session-journal.js';
import { InMemorySessionJournalImpl } from '../../../src/storage/session-journal.js';

// ── Spy lifecycle gate ───────────────────────────────────────────────

/**
 * A hand-rolled spy LifecycleGate used by tests that want to assert on
 * `transitionTo` order without spinning up a real
 * `SessionLifecycleStateMachine`.
 */
export interface SpyLifecycleGate extends JournalLifecycleGate, SoulLifecycleGate {
  readonly transitions: string[];
  setState(state: LifecycleState): void;
}

export function createSpyLifecycleGate(initial: LifecycleState = 'active'): SpyLifecycleGate {
  const transitions: string[] = [];
  let current: LifecycleState = initial;
  return {
    transitions,
    get state(): LifecycleState {
      return current;
    },
    setState(state: LifecycleState): void {
      current = state;
    },
    async transitionTo(next: 'active' | 'compacting' | 'completing'): Promise<void> {
      transitions.push(next);
      current = next;
    },
  };
}

// ── Stub compaction / journal capabilities ──────────────────────────

export function createNoopCompactionProvider(): CompactionProvider {
  return {
    async run() {
      throw new Error('compaction not expected in Slice 3 tests');
    },
  };
}

export function createNoopJournalCapability(): JournalCapability {
  const rotations: number[] = [];
  return {
    async rotate() {
      rotations.push(rotations.length);
      return { archiveFile: `wire.${rotations.length}.jsonl` };
    },
  };
}

// ── Runtime factory (test-only) ─────────────────────────────────────

export interface HarnessRuntimeOptions {
  readonly kosong: KosongAdapter;
  readonly lifecycle?: SoulLifecycleGate | undefined;
  readonly compactionProvider?: CompactionProvider | undefined;
  readonly journal?: JournalCapability | undefined;
}

export function createHarnessRuntime(opts: HarnessRuntimeOptions): Runtime {
  // Phase 2: Runtime narrowed to `{kosong}`. The other fields on
  // HarnessRuntimeOptions stay on the type for backward-compat with
  // callers that pass them in, but they are silently ignored — Soul no
  // longer reads compactionProvider / lifecycle / journal from Runtime.
  void opts.compactionProvider;
  void opts.lifecycle;
  void opts.journal;
  return { kosong: opts.kosong };
}

// ── Context / journal factories ─────────────────────────────────────

export function createHarnessContextState(
  opts: {
    readonly currentTurnId?: () => string;
    readonly initialModel?: string;
  } = {},
): FullContextState {
  const base: {
    readonly initialModel: string;
    currentTurnId?: () => string;
  } = {
    initialModel: opts.initialModel ?? 'test-model',
  };
  if (opts.currentTurnId) {
    base.currentTurnId = opts.currentTurnId;
  }
  return new InMemoryContextState(base);
}

export function createHarnessSessionJournal(): InMemorySessionJournal {
  return new InMemorySessionJournalImpl();
}
