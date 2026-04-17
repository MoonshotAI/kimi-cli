/**
 * SessionMetaService — Phase 16 / 决策 #113 / ADR-X.113 / v2 §6.13.7.
 *
 * Single write-funnel and single in-memory view for session metadata:
 * wire-truth fields (title / tags / description / archived) land here via
 * `setTitle` / `setTags`, and derived fields (turn_count / last_model /
 * last_updated) are accumulated by subscribing to SessionEventBus. Both
 * groups flow into a debounced `state.json` flush.
 *
 * Architectural invariants:
 *   - wire is the truth source; memory + state.json trail (铁律 5)
 *   - derived updates NEVER touch wire and NEVER emit
 *     `session_meta.changed` (§6.13.7 D6 — prevent UI noise; consumers
 *     already see `turn.end` / `model.changed`)
 *   - emit is fire-and-forget (铁律 4); listener failures never leak to
 *     the caller
 *   - the service is a SoulPlus `services` facade component; Soul never
 *     sees it (铁律 6 — Runtime is Soul's only window into SoulPlus)
 *
 * Tech debt (deferred to Phase 17+):
 *   - Subagent SoulPlus instances are NOT wired with their own
 *     SessionMetaService. A subagent that would ordinarily call
 *     `setTitle` has nowhere to write; the parent receives a
 *     `session_meta.changed` event through the shared EventBus only
 *     because `createSubagentSinkWrapper` forwards any SoulEvent — not
 *     because the subagent has independent wire/state machinery. This
 *     slice leaves the subagent wiring alone so the implementation
 *     surface stays contained; a follow-up slice needs to (a) allocate
 *     a child StateCache under `subagents/<agent_id>/state.json`,
 *     (b) thread it into the subagent-runner deps, and (c) construct
 *     an independent SessionMetaService there.
 */

import type { SessionJournal } from '../storage/session-journal.js';
import type { BusEvent, SessionEventBus, SessionEventListener } from './session-event-bus.js';
import type { SessionState, StateCache } from '../session/state-cache.js';

export type MetaSource = 'user' | 'auto' | 'system';

/**
 * Aggregated in-memory view of session metadata. Three tiers:
 *   - wire-truth: `title` / `tags` / `description` / `archived` — written
 *     to wire via SessionMetaService and mirrored into state.json.
 *   - derived: `last_model` / `turn_count` / `last_updated` — updated by
 *     bus subscriptions; never written to wire.
 *   - runtime-only: `last_exit_code` — owned by SessionLifecycle; the
 *     service reads it (as passed in via initialMeta) but does not flush
 *     it on its own.
 */
export interface SessionMeta {
  session_id: string;
  created_at: number;
  title?: string | undefined;
  tags?: string[] | undefined;
  description?: string | undefined;
  archived?: boolean | undefined;
  /**
   * Phase 16 reserved wire-truth slot (Phase 2+ wire method). Stays in
   * lock-step with `SessionMetaChangedRecord.patch.color` and
   * `ReplayProjectedState.sessionMetaPatch.color` so replay round-trips
   * don't silently drop it.
   */
  color?: string | undefined;
  last_model?: string | undefined;
  turn_count: number;
  last_updated: number;
  last_exit_code?: 'clean' | 'dirty' | undefined;
}

export type SessionMetaListener = (
  patch: Partial<SessionMeta>,
  source: MetaSource,
) => void;

export interface SessionMetaServiceDeps {
  readonly sessionId: string;
  readonly sessionJournal: SessionJournal;
  readonly eventBus: SessionEventBus;
  readonly stateCache: StateCache;
  /** Initial view; typically built from state.json + replay projection. */
  readonly initialMeta: SessionMeta;
  /** Debounce window for the state.json flush. Default 200ms. */
  readonly flushDebounceMs?: number;
}

const DEFAULT_FLUSH_DEBOUNCE_MS = 200;

export class SessionMetaService {
  private readonly deps: SessionMetaServiceDeps;
  private readonly flushDebounceMs: number;
  private meta: SessionMeta;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<SessionMetaListener>();
  private readonly busListener: SessionEventListener;

  constructor(deps: SessionMetaServiceDeps) {
    this.deps = deps;
    this.flushDebounceMs = deps.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;
    this.meta = cloneMeta(deps.initialMeta);
    this.busListener = (event) => this.handleBusEvent(event);
    this.deps.eventBus.on(this.busListener);
  }

  // ── Read API ──────────────────────────────────────────────────────────

  /** Snapshot view — mutations on the returned object never leak in. */
  get(): SessionMeta {
    return cloneMeta(this.meta);
  }

  subscribe(handler: SessionMetaListener): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  // ── Write API (wire-truth fields) ─────────────────────────────────────

  async setTitle(title: string, source: MetaSource, reason?: string): Promise<void> {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new Error('SessionMetaService.setTitle: title cannot be empty or whitespace-only');
    }
    if (this.meta.title === trimmed) return;
    await this.applyPatch({ title: trimmed }, source, reason);
  }

  async setTags(
    tags: readonly string[],
    source: MetaSource,
    reason?: string,
  ): Promise<void> {
    const next = [...tags];
    if (shallowArrayEqual(this.meta.tags, next)) return;
    await this.applyPatch({ tags: next }, source, reason);
  }

  // ── Startup recovery ──────────────────────────────────────────────────

  /**
   * Overwrite the in-memory view with replay-derived fields (dirty-exit
   * path). Does not emit any event and does not write wire — the caller
   * already knows the values come from wire (that's the whole point).
   * Schedules a state.json flush so the derived cache catches up.
   */
  recoverFromReplay(replayedMeta: Partial<SessionMeta>): void {
    if (replayedMeta.title !== undefined) this.meta.title = replayedMeta.title;
    if (replayedMeta.tags !== undefined) this.meta.tags = [...replayedMeta.tags];
    if (replayedMeta.description !== undefined) {
      this.meta.description = replayedMeta.description;
    }
    if (replayedMeta.archived !== undefined) this.meta.archived = replayedMeta.archived;
    if (replayedMeta.color !== undefined) this.meta.color = replayedMeta.color;
    if (replayedMeta.last_model !== undefined) {
      this.meta.last_model = replayedMeta.last_model;
    }
    if (replayedMeta.turn_count !== undefined) {
      this.meta.turn_count = replayedMeta.turn_count;
    }
    if (replayedMeta.last_updated !== undefined) {
      this.meta.last_updated = replayedMeta.last_updated;
    }
    if (replayedMeta.last_exit_code !== undefined) {
      this.meta.last_exit_code = replayedMeta.last_exit_code;
    }
    this.scheduleStateFlush();
  }

  // ── Shutdown ─────────────────────────────────────────────────────────

  /** Drain any pending state.json flush synchronously. */
  async flushPending(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.flushStateJson();
    } catch {
      // Swallow — flushStateJson already isolates its own writes; callers
      // (closeSession) should not abort shutdown on a state.json miss.
    }
  }

  /**
   * Detach from the EventBus. Call when the session shuts down to prevent
   * listener-count leaks across createSession / closeSession cycles.
   */
  dispose(): void {
    this.deps.eventBus.off(this.busListener);
    this.listeners.clear();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async applyPatch(
    patch: Partial<SessionMeta>,
    source: MetaSource,
    reason?: string,
  ): Promise<void> {
    // 1. wire (truth source) — awaited so a write failure surfaces to the
    //    caller before any side effect lands.
    await this.deps.sessionJournal.appendSessionMetaChanged({
      type: 'session_meta_changed',
      patch: toWirePatch(patch),
      source,
      ...(reason !== undefined ? { reason } : {}),
    });
    // 2. in-memory view
    if (patch.title !== undefined) this.meta.title = patch.title;
    if (patch.tags !== undefined) this.meta.tags = [...patch.tags];
    if (patch.description !== undefined) this.meta.description = patch.description;
    if (patch.archived !== undefined) this.meta.archived = patch.archived;
    if (patch.color !== undefined) this.meta.color = patch.color;
    this.meta.last_updated = Date.now();
    // 3. fan out wire event — fire-and-forget (铁律 4).
    this.deps.eventBus.emit({
      type: 'session_meta.changed',
      data: {
        patch: toWirePatch(patch),
        source,
      },
    });
    // 4. local subscribers — each isolated so a bad one can't starve peers.
    const subscribers = Array.from(this.listeners);
    for (const h of subscribers) {
      try {
        h(patch, source);
      } catch {
        // swallow
      }
    }
    // 5. debounced state.json flush.
    this.scheduleStateFlush();
  }

  private handleBusEvent(event: BusEvent): void {
    switch (event.type) {
      case 'turn.end':
        this.meta.turn_count += 1;
        this.meta.last_updated = Date.now();
        this.scheduleStateFlush();
        break;
      case 'model.changed':
        this.meta.last_model = event.data.new_model;
        this.meta.last_updated = Date.now();
        this.scheduleStateFlush();
        break;
      default:
        break;
    }
  }

  private scheduleStateFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // Fire the async flush chain. The wrapper ensures the chain's
      // first I/O step (stateCache.write) is queued within this tick so
      // fake-timer harnesses that rely on advanceTimersByTimeAsync see
      // the resulting side effect (SpyStateCache.writes++) before the
      // advance resolves. We intentionally do NOT await this promise —
      // listeners must never back-pressure Soul (铁律 4).
      void this.flushStateJson().catch(() => {
        // Swallow — next write will retry.
      });
    }, this.flushDebounceMs);
    const refable = this.flushTimer as unknown as { unref?: () => void };
    refable.unref?.();
  }

  /**
   * Merge the in-memory SessionMeta onto the current state.json and
   * write it back. Read-then-merge preserves fields written by other
   * owners (createSession / closeSession / slash-commands) — SessionMeta
   * only projects its own slice (title / tags / description / archived
   * / model via last_model / created_at / updated_at). Multi-writer
   * state.json is a slice-16 trade-off (see `v2 decision #113 / D8`):
   * the clean approach (single-writer) is deferred to a future slice
   * because createSession / closeSession / plan_mode / yolo all need
   * to migrate off direct state.json writes first.
   */
  private async flushStateJson(): Promise<void> {
    const existing = (await this.deps.stateCache.read()) ?? {
      session_id: this.meta.session_id,
      created_at: this.meta.created_at,
      updated_at: this.meta.last_updated,
    };
    const next: SessionState = {
      ...existing,
      session_id: this.meta.session_id,
      created_at: this.meta.created_at,
      updated_at: this.meta.last_updated,
      ...(this.meta.title !== undefined ? { custom_title: this.meta.title } : {}),
      ...(this.meta.tags !== undefined ? { tags: [...this.meta.tags] } : {}),
      ...(this.meta.description !== undefined ? { description: this.meta.description } : {}),
      ...(this.meta.archived !== undefined ? { archived: this.meta.archived } : {}),
      ...(this.meta.last_model !== undefined ? { model: this.meta.last_model } : {}),
    };
    await this.deps.stateCache.write(next);
  }
}

function cloneMeta(meta: SessionMeta): SessionMeta {
  return {
    ...meta,
    ...(meta.tags !== undefined ? { tags: [...meta.tags] } : {}),
  };
}

function shallowArrayEqual(a: string[] | undefined, b: readonly string[]): boolean {
  if (a === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function toWirePatch(p: Partial<SessionMeta>): {
  title?: string;
  tags?: string[];
  description?: string;
  archived?: boolean;
  color?: string;
} {
  const out: {
    title?: string;
    tags?: string[];
    description?: string;
    archived?: boolean;
    color?: string;
  } = {};
  if (p.title !== undefined) out.title = p.title;
  if (p.tags !== undefined) out.tags = [...p.tags];
  if (p.description !== undefined) out.description = p.description;
  if (p.archived !== undefined) out.archived = p.archived;
  if (p.color !== undefined) out.color = p.color;
  return out;
}
