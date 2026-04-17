/**
 * TurnLifecycleTracker — turn-handle container extracted from
 * TurnManager (v2 §6.4 / 决策 #109 / phase-4 todo Part A.4).
 *
 * Owns the per-turn bookkeeping that used to sit directly on
 * TurnManager: id counter, AbortController / promise maps, current
 * turn pointer, lifecycle observer fan-out. Zero external deps — it is
 * a pure state container.
 *
 * Synchronous `fireLifecycleEvent` is deliberate: back-to-back prompts
 * must observe `turn.end#N` strictly before `turn.begin#N+1`, so no
 * microtask queue hop between the turn drain and the listener
 * notification.
 */

import type { TurnResult } from '../soul/index.js';

export interface TurnState {
  readonly turnId: string;
  readonly controller: AbortController;
  readonly promise: Promise<TurnResult | undefined>;
}

/**
 * Phase 4 — `TurnLifecycleEvent` + `TurnLifecycleListener` moved from
 * `turn-manager.ts` to this file so `TurnLifecycleTracker` can be the
 * single owner of both the state container and the event types. The
 * former module keeps re-exports for backward-compat callers.
 */
export type TurnLifecycleEvent =
  | {
      readonly kind: 'begin';
      readonly turnId: string;
      readonly userInput: string;
      readonly inputKind: 'user' | 'system_trigger';
      readonly agentType: 'main' | 'sub' | 'independent';
    }
  | {
      readonly kind: 'end';
      readonly turnId: string;
      readonly reason: 'done' | 'cancelled' | 'error';
      readonly success: boolean;
      readonly agentType: 'main' | 'sub' | 'independent';
      readonly usage?: TurnResult['usage'] | undefined;
    };

export type TurnLifecycleListener = (event: TurnLifecycleEvent) => void;

export class TurnLifecycleTracker {
  private readonly turnPromises = new Map<string, Promise<TurnResult | undefined>>();
  private readonly turnStates = new Map<string, TurnState>();
  private readonly listeners = new Set<TurnLifecycleListener>();
  private currentTurnId: string | undefined;
  private turnIdCounter = 0;

  allocateTurnId(): string {
    this.turnIdCounter += 1;
    return `turn_${this.turnIdCounter}`;
  }

  getCurrentTurnId(): string | undefined {
    return this.currentTurnId;
  }

  /**
   * Register a freshly launched turn. The caller has already allocated
   * the id via `allocateTurnId`. Attaches a terminal `.catch` to the
   * promise so the tracker itself never surfaces an unhandled rejection
   * even if nobody else observes the promise.
   */
  registerTurn(
    turnId: string,
    controller: AbortController,
    promise: Promise<TurnResult | undefined>,
  ): void {
    // Attach a terminal catch so Node doesn't flag unhandled rejection
    // when the turn is registered but nobody awaits it (fire-and-forget
    // path in TurnManager.launchTurn).
    promise.catch(() => {
      // swallow — real observers (awaitTurn / cancelTurn) still see the
      // original promise through the map; this catch only exists so the
      // tracker's own reference doesn't leak an unhandled rejection.
    });
    this.turnStates.set(turnId, { turnId, controller, promise });
    this.turnPromises.set(turnId, promise);
    this.currentTurnId = turnId;
  }

  /**
   * Clear the per-turn in-flight state. Keeps the promise in the map so
   * a late `awaitTurn(turnId)` call after settlement still resolves.
   * Only clears `currentTurnId` when it still points at this turn — an
   * out-of-order `completeTurn('turn_x')` for a non-current turn is a
   * no-op on `currentTurnId`.
   */
  completeTurn(turnId: string): void {
    this.turnStates.delete(turnId);
    if (this.currentTurnId === turnId) {
      this.currentTurnId = undefined;
    }
  }

  /**
   * Abort the controller for the given turn and wait for the turn
   * promise to settle (so the caller of `cancelTurn` is guaranteed the
   * turn has fully drained). Swallows the promise rejection — callers
   * only care that the drain is complete, not about the underlying
   * turn failure.
   *
   * No-op when the turn id is unknown (already completed or never
   * existed).
   */
  async cancelTurn(turnId: string): Promise<void> {
    const state = this.turnStates.get(turnId);
    if (state === undefined) return;
    state.controller.abort();
    try {
      await state.promise;
    } catch {
      // swallow — cancel does not surface turn errors
    }
  }

  /**
   * Return the registered promise for the given turn. Resolves to
   * `undefined` when the turn id is unknown so tests can call it
   * unconditionally.
   */
  async awaitTurn(turnId: string): Promise<TurnResult | undefined> {
    const existing = this.turnPromises.get(turnId);
    if (existing === undefined) return undefined;
    return existing;
  }

  /**
   * Subscribe a lifecycle listener. Returns an unsubscribe handle the
   * caller can invoke when the session tears down.
   */
  addListener(listener: TurnLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Fan out a lifecycle event synchronously. Listener errors are
   * isolated — a throwing listener does not prevent the others from
   * receiving the event.
   */
  fireLifecycleEvent(event: TurnLifecycleEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors are isolated — consistent with the
        // SessionEventBus / HookEngine "never brick a turn" invariant.
      }
    }
  }
}
