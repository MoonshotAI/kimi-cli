/**
 * SessionLifecycleStateMachine — canonical 5-state lifecycle owner for a
 * single SoulPlus instance (v2 §5.8.2 / appendix D.7).
 *
 * This class is the authoritative state field; `SoulLifecycleGate` and
 * `JournalWriter` are downstream observers that gate their behaviour on it.
 *
 * Valid transitions (Slice 3 subset — Slice 6 Compaction adds the
 * `compacting` fan-in / fan-out):
 *
 *   idle       → active | destroying
 *   active     → completing | compacting | destroying
 *   completing → idle | active | destroying
 *   compacting → active | destroying
 *   destroying → (terminal)
 *
 * Any attempt to transition to a non-adjacent state is rejected and the
 * current state is left unchanged.
 */

import type { SessionLifecycleState } from './types.js';

const TRANSITIONS: Readonly<Record<SessionLifecycleState, readonly SessionLifecycleState[]>> = {
  idle: ['active', 'destroying'],
  active: ['completing', 'compacting', 'destroying'],
  completing: ['idle', 'active', 'destroying'],
  compacting: ['active', 'destroying'],
  destroying: [],
};

export class SessionLifecycleStateMachine {
  private _state: SessionLifecycleState;

  constructor(initialState: SessionLifecycleState = 'idle') {
    this._state = initialState;
  }

  get state(): SessionLifecycleState {
    return this._state;
  }

  isIdle(): boolean {
    return this._state === 'idle';
  }

  isActive(): boolean {
    return this._state === 'active';
  }

  isCompleting(): boolean {
    return this._state === 'completing';
  }

  isCompacting(): boolean {
    return this._state === 'compacting';
  }

  isDestroying(): boolean {
    return this._state === 'destroying';
  }

  /**
   * Attempt to transition to `next`. Throws `Error` if the transition is
   * not in the allowed matrix. Transition is synchronous — the asynchronous
   * "drain in-flight writes" semantics of `LifecycleGate.transitionTo` live
   * in `SoulLifecycleGate`, not here.
   */
  transitionTo(next: SessionLifecycleState): void {
    const allowed = TRANSITIONS[this._state];
    if (!allowed.includes(next)) {
      throw new Error(`SessionLifecycleStateMachine: illegal transition ${this._state} → ${next}`);
    }
    this._state = next;
  }
}
