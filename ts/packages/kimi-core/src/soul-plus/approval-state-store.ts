/**
 * ApprovalStateStore — persistent session-level auto-approve actions.
 *
 * `auto_approve_actions` is a Set<string> of action labels that the user
 * has granted "approve for this session" to. Slice 2.3 persists this set
 * in the session's `state.json` so a restart keeps the decisions intact
 * (Python parity — `src/kimi_cli/session_state.py:15-17` +
 * `soul/agent.py:293-305`).
 *
 * Two implementations live here:
 *   - `InMemoryApprovalStateStore`  — zero-dependency test double.
 *   - `SessionStateApprovalStateStore` — production adapter that reads
 *     and writes the `auto_approve_actions` field on the session's
 *     `state.json` via `StateCache`.
 *
 * The store is NOT part of the public `ApprovalRuntime` surface — it is
 * a constructor dependency of `WiredApprovalRuntime`, so embedders /
 * tests can inject any implementation.
 */

import type { SessionState, StateCache } from '../session/state-cache.js';

/**
 * Phase 17 §B.2 — `onChanged` callback surfaces auto-approve cache
 * mutations to observers (journal writers, UI refreshers). Callers
 * assign to `store.onChanged` after construction.
 */
export interface ApprovalStateChange {
  readonly kind: 'save';
  readonly before: ReadonlySet<string>;
  readonly after: ReadonlySet<string>;
}

export interface ApprovalStateStore {
  /** Load the current set of session-scoped auto-approve action labels. */
  load(): Promise<Set<string>>;
  /** Persist the full set (replaces previous contents). */
  save(actions: ReadonlySet<string>): Promise<void>;
  /**
   * Phase 17 §B.2 — optional observer. Fires AFTER the persistence
   * write succeeds (mirror-after-WAL). A missing callback must never
   * crash; assignments are idempotent.
   */
  onChanged?: ((event: ApprovalStateChange) => void) | undefined;
}

// ── In-memory implementation (tests / ephemeral sessions) ─────────────

export class InMemoryApprovalStateStore implements ApprovalStateStore {
  private actions = new Set<string>();
  onChanged?: ((event: ApprovalStateChange) => void) | undefined;

  constructor(initial?: Iterable<string>) {
    if (initial !== undefined) {
      this.actions = new Set(initial);
    }
  }

  async load(): Promise<Set<string>> {
    return new Set(this.actions);
  }

  async save(actions: ReadonlySet<string>): Promise<void> {
    const before = new Set(this.actions);
    this.actions = new Set(actions);
    this.onChanged?.({ kind: 'save', before, after: new Set(this.actions) });
  }

  /** Test helper: inspect without cloning. */
  snapshot(): ReadonlySet<string> {
    return this.actions;
  }
}

// ── StateCache-backed implementation (production) ─────────────────────

/**
 * Production adapter that reads / writes `auto_approve_actions` on the
 * session's `state.json` file via the existing `StateCache` service.
 * The rest of the state.json fields are preserved on write — we only
 * rewrite the action list.
 *
 * Session metadata timestamps (`updated_at`) are refreshed on every
 * save so downstream session-list tooling sees the activity.
 */
export class SessionStateApprovalStateStore implements ApprovalStateStore {
  onChanged?: ((event: ApprovalStateChange) => void) | undefined;

  constructor(
    private readonly stateCache: StateCache,
    private readonly sessionId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<Set<string>> {
    const state = await this.stateCache.read();
    const raw = state?.auto_approve_actions;
    if (raw === undefined) return new Set();
    return new Set(raw);
  }

  async save(actions: ReadonlySet<string>): Promise<void> {
    const current = await this.stateCache.read();
    const before = new Set(current?.auto_approve_actions ?? []);
    const now = this.now();
    const next: SessionState = current
      ? { ...current, auto_approve_actions: [...actions], updated_at: now }
      : {
          session_id: this.sessionId,
          auto_approve_actions: [...actions],
          created_at: now,
          updated_at: now,
        };
    await this.stateCache.write(next);
    this.onChanged?.({ kind: 'save', before, after: new Set(actions) });
  }
}
