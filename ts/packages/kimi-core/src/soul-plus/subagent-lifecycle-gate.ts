/**
 * AlwaysAllowLifecycleGate — trivial lifecycle implementations for subagent souls.
 *
 * Subagents don't participate in the parent's lifecycle state machine.
 * Two interfaces need satisfying:
 *
 *   1. `JournalWriterLifecycleGate` (storage/journal-writer.ts) — read-side
 *      gate for the child's WiredJournalWriter. Always returns 'active'.
 *
 *   2. `RuntimeLifecycleGate` (soul/runtime.ts) — Soul-side gate with
 *      `transitionTo`. Subagent turns never compact or complete via the
 *      lifecycle FSM, so `transitionTo` is a no-op.
 */

import type { LifecycleGate as JournalWriterLifecycleGate, LifecycleState } from '../storage/journal-writer.js';
import type { LifecycleGate as RuntimeLifecycleGate, JournalCapability } from '../soul/runtime.js';

/**
 * Journal-writer gate: always 'active' so child wire.jsonl writes are
 * never blocked.
 */
export class SubagentJournalGate implements JournalWriterLifecycleGate {
  get state(): LifecycleState {
    return 'active';
  }
}

/**
 * Runtime lifecycle gate: `transitionTo` is a no-op. Subagent souls
 * never drive compaction or completing transitions.
 */
export class SubagentRuntimeLifecycleGate implements RuntimeLifecycleGate {
  async transitionTo(_state: 'active' | 'compacting' | 'completing'): Promise<void> {
    // No-op for subagents
  }
}

/**
 * Subagent JournalCapability stub. Subagents don't rotate their journal
 * files (no compaction in 5.3).
 */
export const SUBAGENT_JOURNAL_CAPABILITY: JournalCapability = {
  async rotate() {
    throw new Error('Subagent journal rotation is not supported');
  },
  async readSessionInitialized() {
    throw new Error('Subagent journal rotation is not supported');
  },
  async appendBoundary() {
    throw new Error('Subagent journal rotation is not supported');
  },
};
