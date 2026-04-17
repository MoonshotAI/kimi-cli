/**
 * ApprovalStateStore — persistent session-level auto-approve state.
 *
 * Holds two durable pieces of approval state:
 *   - `auto_approve_actions` — Set<string> of action labels the user has
 *     granted "approve for this session" to (Slice 2.3, Python parity
 *     `src/kimi_cli/session_state.py:15-17` + `soul/agent.py:293-305`).
 *   - `yolo` — session-scoped bypass-permissions flag (Phase 17 B.2,
 *     Python parity `kimi_cli/soul/approval.py::ApprovalState.yolo`).
 *
 * The two pieces sit side-by-side on disk (state.json) and in memory so
 * a restart keeps both intact without depending on wire.jsonl replay.
 *
 * Store changes are broadcast through `onChanged(listener)` — both
 * `setYolo` and `save(actions)` fire the listener with a snapshot
 * (`{ yolo, autoApproveActions }`) so downstream observers (wire record
 * writer, `status.update` event emitter) can reflect the new state
 * (Python parity with `ApprovalState.notify_change`).
 *
 * Two implementations live here:
 *   - `InMemoryApprovalStateStore`  — zero-dependency test double.
 *   - `SessionStateApprovalStateStore` — production adapter that reads
 *     and writes the `auto_approve_actions` + `yolo` fields on the
 *     session's `state.json` via `StateCache`.
 *
 * The store is NOT part of the public `ApprovalRuntime` surface — it is
 * a constructor dependency of `WiredApprovalRuntime`, so embedders /
 * tests can inject any implementation.
 */

import type { SessionState, StateCache } from '../session/state-cache.js';

// ── Change snapshot (Phase 17 B.2) ──────────────────────────────────────

export interface ApprovalStateSnapshot {
  readonly yolo: boolean;
  readonly autoApproveActions: ReadonlySet<string>;
}

export type ApprovalStateChangeListener = (snapshot: ApprovalStateSnapshot) => void;

export interface ApprovalStateStore {
  /** Load the current set of session-scoped auto-approve action labels. */
  load(): Promise<Set<string>>;
  /** Persist the full set (replaces previous contents). */
  save(actions: ReadonlySet<string>): Promise<void>;
  /** Read the current yolo (bypass-permissions) flag. */
  getYolo(): Promise<boolean> | boolean;
  /** Persist the yolo flag and notify subscribers. */
  setYolo(enabled: boolean): Promise<void>;
  /**
   * Subscribe to state-change notifications. Returns an unsubscribe
   * callback. Listeners fire after every `save` / `setYolo` with a
   * fresh snapshot. Listener errors are isolated — a throwing listener
   * never prevents other listeners from running.
   */
  onChanged(listener: ApprovalStateChangeListener): () => void;
}

// ── Shared listener fan-out ─────────────────────────────────────────────

class ChangeListenerRegistry {
  private readonly listeners = new Set<ApprovalStateChangeListener>();

  add(listener: ApprovalStateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  fire(snapshot: ApprovalStateSnapshot): void {
    // Iterate over a snapshot so a listener that unsubscribes itself
    // cannot shift the iteration it is part of.
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Listener errors must never propagate back to callers
        // (parity with SessionEventBus.safeDispatch).
      }
    }
  }
}

// ── In-memory implementation (tests / ephemeral sessions) ─────────────

export class InMemoryApprovalStateStore implements ApprovalStateStore {
  private actions = new Set<string>();
  private yolo = false;
  private readonly listeners = new ChangeListenerRegistry();

  constructor(initial?: Iterable<string>) {
    if (initial !== undefined) {
      this.actions = new Set(initial);
    }
  }

  async load(): Promise<Set<string>> {
    return new Set(this.actions);
  }

  async save(actions: ReadonlySet<string>): Promise<void> {
    this.actions = new Set(actions);
    this.fireChanged();
  }

  getYolo(): boolean {
    return this.yolo;
  }

  async setYolo(enabled: boolean): Promise<void> {
    this.yolo = enabled;
    this.fireChanged();
  }

  onChanged(listener: ApprovalStateChangeListener): () => void {
    return this.listeners.add(listener);
  }

  /** Test helper: inspect without cloning. */
  snapshot(): ReadonlySet<string> {
    return this.actions;
  }

  private fireChanged(): void {
    this.listeners.fire({
      yolo: this.yolo,
      autoApproveActions: this.actions,
    });
  }
}

// ── StateCache-backed implementation (production) ─────────────────────

/**
 * Production adapter that reads / writes `auto_approve_actions` + `yolo`
 * on the session's `state.json` file via the existing `StateCache`
 * service. The rest of the state.json fields are preserved on write —
 * we only rewrite the approval-state fields.
 *
 * Session metadata timestamps (`updated_at`) are refreshed on every
 * save so downstream session-list tooling sees the activity.
 */
export class SessionStateApprovalStateStore implements ApprovalStateStore {
  private readonly listeners = new ChangeListenerRegistry();
  /**
   * In-memory mirror of the fields we own. Populated lazily on first
   * read, updated on every write. Keeps `getYolo` synchronous-ish so
   * callers (wire handlers that need the current flag in a hot path)
   * avoid a disk-read every call.
   */
  private cachedYolo: boolean | undefined;
  private cachedActions: Set<string> | undefined;

  constructor(
    private readonly stateCache: StateCache,
    private readonly sessionId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<Set<string>> {
    const state = await this.stateCache.read();
    const raw = state?.auto_approve_actions;
    const actions = raw === undefined ? new Set<string>() : new Set(raw);
    this.cachedActions = new Set(actions);
    this.cachedYolo = state?.yolo ?? false;
    return actions;
  }

  async save(actions: ReadonlySet<string>): Promise<void> {
    await this.writeState({ actions });
    this.cachedActions = new Set(actions);
    this.fireChanged();
  }

  async getYolo(): Promise<boolean> {
    if (this.cachedYolo !== undefined) return this.cachedYolo;
    const state = await this.stateCache.read();
    this.cachedYolo = state?.yolo ?? false;
    this.cachedActions = new Set(state?.auto_approve_actions ?? []);
    return this.cachedYolo;
  }

  async setYolo(enabled: boolean): Promise<void> {
    await this.writeState({ yolo: enabled });
    this.cachedYolo = enabled;
    this.fireChanged();
  }

  onChanged(listener: ApprovalStateChangeListener): () => void {
    return this.listeners.add(listener);
  }

  private async writeState(patch: {
    actions?: ReadonlySet<string>;
    yolo?: boolean;
  }): Promise<void> {
    const current = await this.stateCache.read();
    const now = this.now();
    const nextActions =
      patch.actions !== undefined
        ? [...patch.actions]
        : current?.auto_approve_actions !== undefined
          ? [...current.auto_approve_actions]
          : undefined;
    const nextYolo = patch.yolo !== undefined ? patch.yolo : current?.yolo;

    const base: SessionState = current
      ? { ...current, updated_at: now }
      : {
          session_id: this.sessionId,
          created_at: now,
          updated_at: now,
        };
    const next: SessionState = {
      ...base,
      ...(nextActions !== undefined ? { auto_approve_actions: nextActions } : {}),
      ...(nextYolo !== undefined ? { yolo: nextYolo } : {}),
    };
    await this.stateCache.write(next);
  }

  private fireChanged(): void {
    this.listeners.fire({
      yolo: this.cachedYolo ?? false,
      autoApproveActions: this.cachedActions ?? new Set(),
    });
  }
}
