/**
 * SoulLifecycleGate — bridge between the 5-state
 * `SessionLifecycleStateMachine` (SoulPlus-internal) and the 3-state
 * `LifecycleGate` contract consumed by `JournalWriter` (Slice 1) and by
 * `Runtime.lifecycle` (Slice 2 / v2 §5.8.2).
 *
 * ── 5 → 3 mapping ─────────────────────────────────────────────────────
 *
 *   idle       → "active"      (writes allowed)
 *   active     → "active"
 *   compacting → "compacting"  (writes gated to compaction path)
 *   completing → "completing"  (writes gated — session shutting down)
 *   destroying → "completing"  (writes gated — destroy in progress)
 *
 * `destroying → completing` is a Phase 1 simplification — Slice 8
 * Recovery will revisit this if a "destroy phase writes final cleanup
 * records" requirement appears.
 *
 * The gate also implements `Runtime.lifecycle.transitionTo(active |
 * compacting | completing)` by translating those three Soul-visible states
 * into the underlying state machine's moves.
 *
 * Phase 4 rename (决策 #92): `LifecycleGateFacade` → `SoulLifecycleGate`.
 * The "facade" vocabulary is reserved for the SoulPlus 6-facade
 * aggregation (`LifecycleFacade` / `JournalFacade` / ...); the Soul-
 * facing gate deserves its own unambiguous name.
 */

import type {
  LifecycleGate as JournalLifecycleGate,
  LifecycleState,
} from '../storage/journal-writer.js';
import type { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';
import type { SessionLifecycleState } from './types.js';

// ── Lifecycle types (moved here from src/soul/runtime.ts — Phase 20 §C.1 / R-3) ──

/**
 * `transitionTo` exposes exactly three of the five internal lifecycle
 * states. `idle` / `destroying` are managed by SoulPlus and
 * intentionally invisible at this layer.
 *
 * Phase 2: no longer part of the Runtime aggregate — SoulPlus and
 * TurnManager use `SessionLifecycleStateMachine.transitionTo` directly.
 * This interface is retained as an exported type so existing test
 * fixtures and Phase 4 refactors can still reference it.
 */
export interface LifecycleGate {
  transitionTo(state: 'active' | 'compacting' | 'completing'): Promise<void>;
}

function mapTo3(internal: SessionLifecycleState): LifecycleState {
  switch (internal) {
    case 'idle':
    case 'active':
      return 'active';
    case 'compacting':
      return 'compacting';
    case 'completing':
    case 'destroying':
      return 'completing';
    default: {
      const _exhaustive: never = internal;
      return _exhaustive;
    }
  }
}

export class SoulLifecycleGate implements JournalLifecycleGate, LifecycleGate {
  constructor(private readonly stateMachine: SessionLifecycleStateMachine) {}

  /** Satisfies Slice 1 `LifecycleGate` — the JournalWriter read-side gate. */
  get state(): LifecycleState {
    return mapTo3(this.stateMachine.state);
  }

  /**
   * Satisfies Slice 2 `Runtime.lifecycle.transitionTo(...)`.
   *
   * Only the three Soul-visible states are accepted. Callers on the
   * SoulPlus-internal side (e.g. TurnManager setting `idle` after
   * `onTurnEnd`) must use `stateMachine.transitionTo` directly, not this
   * gate method.
   */
  async transitionTo(state: 'active' | 'compacting' | 'completing'): Promise<void> {
    this.stateMachine.transitionTo(state);
  }
}
