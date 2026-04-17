/**
 * WiredApprovalRuntime — the production `ApprovalRuntime` (v2 §9-G).
 *
 * Responsibilities:
 *   - Allocate request ids.
 *   - Write `approval_request` records to wire.jsonl **before** the in-
 *     memory waiter is installed (§9-G.3 落盘顺序 invariant — never flip
 *     this order).
 *   - Await the user response. On settle, write the `approval_response`
 *     record **before** the waiter is resolved.
 *   - Honor abort signals and `cancelBySource`. These write a synthetic
 *     cancelled record so `recoverPendingOnStartup` is idempotent (P0-2).
 *     Hard timeout is managed by the outer `withTimeout` wrapper in
 *     `buildBeforeToolCall`, not here (single source of truth — Codex R2 M3).
 *   - Persist session-scoped `auto_approve_actions` to `state.json` via
 *     an injected `ApprovalStateStore`. Short-circuit requests whose
 *     action is already in the cache (§9-G Python parity with
 *     `Approval.request`).
 *   - On `approve_for_session`: add to cache + inject a session-runtime
 *     `PermissionRule` via the optional injector + cascade-resolve every
 *     other pending approval sharing the same action (Python parity,
 *     `src/kimi_cli/soul/approval.py:160-169`).
 *   - `recoverPendingOnStartup`: scan wire.jsonl for dangling request /
 *     response pairs and append synthetic cancelled responses.
 *
 * NOT in scope (Slice 2.3):
 *   - `ingestRemoteRequest` / `resolveRemote` — stubbed as
 *     `NotImplementedError`; Slice 2.6+ TeamDaemon will wire these.
 *   - Front-end UI rendering of approvals — Slice 2.3 only reaches the
 *     wire protocol layer.
 */

import { randomUUID } from 'node:crypto';

import type { SessionJournal } from '../storage/session-journal.js';
import type { ApprovalSource, JournalInput, WireRecord } from '../storage/wire-record.js';
import {
  NotImplementedError,
  type ApprovalRequest,
  type ApprovalRequestPayload,
  type ApprovalResponseData,
  type ApprovalResult,
  type ApprovalRuntime,
} from './approval-runtime.js';

/**
 * Phase 17 §A.3 — reverse-RPC payload shape. Production sender wraps
 * this into an `approval.request` wire frame; tests inspect the raw
 * payload without booting the full transport.
 */
export interface ApprovalRequestFrame {
  readonly method: 'approval.request';
  readonly data: {
    readonly request_id: string;
    readonly tool_call_id: string;
    readonly tool_name: string;
    readonly action: string;
    readonly display: ApprovalRequest['display'];
    readonly source: ApprovalSource;
    readonly turn_id: string;
    readonly step: number;
  };
}
import type { ApprovalStateStore } from './approval-state-store.js';
import { actionToRulePattern } from './permission/action-label.js';
import type { PermissionRule } from './permission/types.js';

/** 300 s — matches Python #1724 fix. Duplicated here so the runtime has no
 * import-cycle dependency on `permission/before-tool-call.ts`. */
export const WIRED_APPROVAL_TIMEOUT_MS = 300_000;

// ── Internal types ────────────────────────────────────────────────────

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Pending {
  readonly requestId: string;
  readonly request: ApprovalRequest;
  readonly turnId: string;
  readonly step: number;
  readonly deferred: Deferred<ApprovalResult>;
  abortCleanup: (() => void) | undefined;
  /** `true` once a terminal path has claimed the entry. */
  settled: boolean;
}

// ── Deps ─────────────────────────────────────────────────────────────

export interface WiredApprovalRuntimeDeps {
  /** WAL window used to append approval_request / approval_response. */
  readonly sessionJournal: SessionJournal;
  /** Persistence for `auto_approve_actions`. Tests can inject in-memory. */
  readonly stateStore: ApprovalStateStore;
  /**
   * Read wire.jsonl (or equivalent log of WireRecords) for crash recovery.
   * Tests pass a fixed array; production wires this to the replay layer.
   */
  readonly loadJournalRecords: () => Promise<readonly WireRecord[]>;
  /**
   * Optional callback invoked when an `approve_for_session` response lands.
   * TurnManager passes a closure that appends to its `sessionRules` list
   * so the next turn's `checkRules` walk short-circuits on the same
   * action. When omitted, rule injection is skipped (auto-approve cache
   * still works via the runtime short-circuit).
   */
  readonly ruleInjector?: ((rule: PermissionRule) => void) | undefined;
  /** Deterministic id allocator for tests. */
  readonly allocateRequestId?: (() => string) | undefined;
  /**
   * Phase 17 §A.3 — reverse-RPC sender. When provided, each `request()`
   * dispatches an `approval.request` frame so a wire client can render
   * the prompt. Unprovided (TUI) runtime keeps the legacy local-resolve
   * path; `resolveRemote` still works, it just has no external fan-out.
   */
  readonly reverseRpcSender?: ((req: ApprovalRequestFrame) => void) | undefined;
}

// ── Implementation ────────────────────────────────────────────────────

export class WiredApprovalRuntime implements ApprovalRuntime {
  private readonly sessionJournal: SessionJournal;
  private readonly stateStore: ApprovalStateStore;
  private readonly loadJournalRecords: () => Promise<readonly WireRecord[]>;
  private readonly ruleInjector: ((rule: PermissionRule) => void) | undefined;
  private readonly allocateRequestId: () => string;
  private readonly pending = new Map<string, Pending>();
  private readonly reverseRpcSender:
    | ((req: ApprovalRequestFrame) => void)
    | undefined;

  /**
   * Sources that have been passed to `cancelBySource`. Checked
   * retroactively by `request()` after `pending.set` so that entries
   * still in the WAL window at cancel time are caught. (Codex R2 M2)
   */
  private readonly cancelledSources: ApprovalSource[] = [];

  /**
   * Session-level auto-approve cache. Populated lazily on first access
   * and mutated in place by `resolve()` when `approve_for_session` fires.
   * Tests can call `init()` eagerly.
   */
  private autoApproveActions: Set<string> | undefined;
  private loadPromise: Promise<Set<string>> | undefined;

  constructor(deps: WiredApprovalRuntimeDeps) {
    this.sessionJournal = deps.sessionJournal;
    this.stateStore = deps.stateStore;
    this.loadJournalRecords = deps.loadJournalRecords;
    this.ruleInjector = deps.ruleInjector;
    this.allocateRequestId = deps.allocateRequestId ?? (() => `appr_${randomUUID()}`);
    this.reverseRpcSender = deps.reverseRpcSender;
  }

  /**
   * Eagerly load the auto-approve cache. Callers that skip this will
   * trigger the lazy load on the first `request(...)`. Safe to call
   * multiple times.
   */
  async init(): Promise<void> {
    await this.ensureLoaded();
  }

  private async ensureLoaded(): Promise<Set<string>> {
    if (this.autoApproveActions !== undefined) return this.autoApproveActions;
    this.loadPromise ??= this.stateStore.load();
    this.autoApproveActions = await this.loadPromise;
    return this.autoApproveActions;
  }

  // ── request() — write WAL, install waiter, await result ────────────

  async request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResult> {
    // Sync fast-path on already-loaded auto-approve cache (§9-G Python
    // parity). When `init()` or a prior request primed the cache this
    // resolves without awaiting — keeps the hot path off the microtask
    // queue.
    if (this.autoApproveActions !== undefined && this.autoApproveActions.has(req.action)) {
      return { approved: true };
    }

    // Early abort check — if the caller already cancelled, we do NOT
    // allocate a request id nor touch wire.jsonl.
    if (signal !== undefined && isAborted(signal)) {
      throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }

    const requestId = this.allocateRequestId();
    const turnId = req.turnId ?? 'turn_unknown';
    const step = req.step ?? 0;

    // Phase 17 §A.3 — install the pending entry + fire the reverse-RPC
    // frame BEFORE any await so wire clients observe the prompt in the
    // same microtask as request() was called from. The subsequent WAL
    // append still lands before any `resolve` response because
    // `doResolve` awaits `appendApprovalResponse` which is serialised
    // after this append on the journal's internal queue.
    const deferred = makeDeferred<ApprovalResult>();

    let abortCleanup: (() => void) | undefined;
    let listener: (() => void) | undefined;
    if (signal !== undefined) {
      listener = (): void => {
        void this.cancelOne(requestId, 'cancelled by signal');
      };
      signal.addEventListener('abort', listener, { once: true });
      abortCleanup = () => {
        signal.removeEventListener('abort', listener as () => void);
      };
    }

    const entry: Pending = {
      requestId,
      request: req,
      turnId,
      step,
      deferred,
      abortCleanup,
      settled: false,
    };
    this.pending.set(requestId, entry);

    if (this.reverseRpcSender !== undefined) {
      const frame: ApprovalRequestFrame = {
        method: 'approval.request',
        data: {
          request_id: requestId,
          tool_call_id: req.toolCallId,
          tool_name: req.toolName,
          action: req.action,
          display: req.display,
          source: req.source,
          turn_id: turnId,
          step,
        },
      };
      try {
        this.reverseRpcSender(frame);
      } catch {
        /* swallow — transport failures must not break local resolve */
      }
    }

    // Kick off the auto-approve cache load. If the load races the WAL
    // append, the one-shot `loadPromise` field means both awaits
    // observe the same result without double-loading.
    const loadPromise = this.ensureLoaded();

    // P0-1: write the approval_request wire record. Crash between
    // pending install and WAL is safe — the waiter is in memory only
    // and dies with the process; no orphan response needed.
    const requestRecord: JournalInput<'approval_request'> = {
      type: 'approval_request',
      turn_id: turnId,
      step,
      data: {
        request_id: requestId,
        tool_call_id: req.toolCallId,
        tool_name: req.toolName,
        action: req.action,
        display: req.display,
        source: req.source,
      },
    };

    const cache = await loadPromise;
    if (cache.has(req.action)) {
      // Retroactive auto-approve hit (Codex R2 M1 + §9-G Python parity):
      // short-circuit BEFORE writing the WAL request record so auto-
      // approved actions leave no trace in wire.jsonl.
      const claimed = this.claim(requestId);
      if (claimed !== undefined) {
        return { approved: true };
      }
      return deferred.promise;
    }

    await this.sessionJournal.appendApprovalRequest(requestRecord);

    // Retroactive abort trigger (Round 1 M1). If the caller aborted the
    // signal during the WAL window, the abort event was dispatched before
    // our listener was attached. Re-check after the entry is in the map
    // so `cancelOne` can claim it.
    if (isAborted(signal) && listener !== undefined) {
      listener();
    }

    // Retroactive source-cancel check (Codex R2 M2). If cancelBySource
    // ran while we were in the WAL window, it only scanned entries
    // already in `this.pending` and missed us.
    for (const src of this.cancelledSources) {
      if (matchesSource(req.source, src)) {
        queueMicrotask(() => {
          void this.cancelOne(requestId, 'cancelled by source');
        });
        break;
      }
    }

    return deferred.promise;
  }

  /**
   * Claim ownership of a pending entry synchronously — clear timers /
   * listeners and remove from the map. Returns the entry if it was
   * successfully claimed, or `undefined` if another path already
   * settled it. Called by every terminal path (resolve / cancelOne /
   * cancelBySource) BEFORE the async WAL append so there can be at
   * most one WAL writer per entry.
   */
  private claim(requestId: string): Pending | undefined {
    const entry = this.pending.get(requestId);
    if (entry === undefined || entry.settled) return undefined;
    entry.settled = true;
    if (entry.abortCleanup !== undefined) {
      entry.abortCleanup();
      entry.abortCleanup = undefined;
    }
    this.pending.delete(requestId);
    return entry;
  }

  // ── resolve() — WAL, then release the waiter ───────────────────────

  resolve(requestId: string, response: ApprovalResponseData): void {
    // Public method is synchronous (matches §9-G.2 signature); route
    // through an async helper so we can `await` the WAL append before
    // touching the waiter. Unhandled rejection from the append is
    // swallowed — callers of `resolve()` don't observe durability.
    void this.doResolve(requestId, response);
  }

  private async doResolve(requestId: string, response: ApprovalResponseData): Promise<void> {
    const entry = this.claim(requestId);
    if (entry === undefined) return;

    try {
      // approve_for_session: persist + rule inject. We must do this
      // BEFORE building the cascade snapshot so any new request that
      // enters the short-circuit fast path observes the cached state.
      if (response.scope === 'session' && response.response === 'approved') {
        await this.recordSessionApproval(entry.request.action, entry.request.toolName);
      }

      // Snapshot of remaining pending with the same action. These get
      // cascade-resolved on the next microtask to avoid re-entrant
      // recursion through `doResolve` (P0-3).
      const cascadeTargets: Pending[] = [];
      if (response.scope === 'session' && response.response === 'approved') {
        for (const other of this.pending.values()) {
          if (!other.settled && other.request.action === entry.request.action) {
            cascadeTargets.push(other);
          }
        }
      }

      // P0-1: append the approval_response wire record BEFORE resolving
      // the in-memory waiter.
      const responseRecord: JournalInput<'approval_response'> = {
        type: 'approval_response',
        turn_id: entry.turnId,
        step: entry.step,
        data: {
          request_id: requestId,
          response: response.response,
          ...(response.feedback !== undefined ? { feedback: response.feedback } : {}),
        },
      };
      await this.sessionJournal.appendApprovalResponse(responseRecord);

      const result: ApprovalResult = {
        approved: response.response === 'approved',
        ...(response.feedback !== undefined ? { feedback: response.feedback } : {}),
      };
      entry.deferred.resolve(result);

      for (const target of cascadeTargets) {
        queueMicrotask(() => {
          void this.doResolve(target.requestId, { response: 'approved' });
        });
      }
    } catch (error) {
      entry.deferred.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async recordSessionApproval(action: string, toolName: string): Promise<void> {
    const cache = await this.ensureLoaded();
    if (!cache.has(action)) {
      cache.add(action);
      await this.stateStore.save(cache);
    }
    if (this.ruleInjector !== undefined) {
      this.ruleInjector({
        decision: 'allow',
        scope: 'session-runtime',
        pattern: actionToRulePattern(action, toolName),
        reason: `approve_for_session: ${action}`,
      });
    }
  }

  // ── cancelBySource / cancelOne — synthetic cancelled response ──────

  cancelBySource(source: ApprovalSource): void {
    // Record the source so retroactive checks in `request()` can catch
    // entries that are still in the WAL window (Codex R2 M2).
    this.cancelledSources.push(source);

    // Snapshot request ids — we mutate `pending` via cancelOne below.
    const matches: string[] = [];
    for (const entry of this.pending.values()) {
      if (!entry.settled && matchesSource(entry.request.source, source)) {
        matches.push(entry.requestId);
      }
    }
    for (const requestId of matches) {
      void this.cancelOne(requestId, 'cancelled by source');
    }
  }

  private async cancelOne(requestId: string, feedback: string): Promise<void> {
    const entry = this.claim(requestId);
    if (entry === undefined) return;

    try {
      const responseRecord: JournalInput<'approval_response'> = {
        type: 'approval_response',
        turn_id: entry.turnId,
        step: entry.step,
        data: {
          request_id: requestId,
          response: 'cancelled',
          feedback,
          synthetic: true,
        },
      };
      await this.sessionJournal.appendApprovalResponse(responseRecord);

      entry.deferred.resolve({ approved: false, feedback });
    } catch (error) {
      entry.deferred.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ── recoverPendingOnStartup (§9-G.4) ───────────────────────────────

  async recoverPendingOnStartup(): Promise<void> {
    const records = await this.loadJournalRecords();

    const pendingMap = new Map<string, { turnId: string; step: number }>();
    for (const r of records) {
      if (r.type === 'approval_request') {
        pendingMap.set(r.data.request_id, { turnId: r.turn_id, step: r.step });
      } else if (r.type === 'approval_response') {
        pendingMap.delete(r.data.request_id);
      }
    }

    for (const [requestId, anchor] of pendingMap) {
      const responseRecord: JournalInput<'approval_response'> = {
        type: 'approval_response',
        turn_id: anchor.turnId,
        step: anchor.step,
        data: {
          request_id: requestId,
          response: 'cancelled',
          feedback: 'cancelled on startup',
          synthetic: true,
        },
      };
      await this.sessionJournal.appendApprovalResponse(responseRecord);
    }
  }

  // ── Remote (TeamDaemon) hooks — stubbed in Slice 2.3 ───────────────

  async ingestRemoteRequest(_data: ApprovalRequestPayload): Promise<void> {
    // Reserved for Slice 2.6+ TeamDaemon — peer daemons pushing a
    // request originated on another node. Phase 17 §A.3 scope stops at
    // the local reverse-RPC round-trip.
    throw new NotImplementedError('WiredApprovalRuntime.ingestRemoteRequest');
  }

  /**
   * Phase 17 §A.3 — client-side `approval.response` wire frames land
   * here. Routes back into the normal `resolve` path so WAL ordering
   * invariants apply identically to local and remote resolves.
   */
  resolveRemote(data: { request_id: string } & ApprovalResponseData): void {
    const { request_id, ...response } = data;
    this.resolve(request_id, response);
  }

  // ── Test helpers ───────────────────────────────────────────────────

  /** Number of currently in-flight approvals. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Snapshot of currently cached auto-approve actions (test-only). */
  getAutoApproveActions(): ReadonlySet<string> {
    return this.autoApproveActions ?? new Set();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Read `signal.aborted` through a function call so TypeScript does not
 * narrow the value across the early-throw + async-await sequence in
 * `request()`. Without the indirection, the post-await re-check would
 * be flagged as an "always false" comparison and the M1 retroactive
 * trigger would not type-check.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function matchesSource(candidate: ApprovalSource, filter: ApprovalSource): boolean {
  if (candidate.kind !== filter.kind) return false;
  if (filter.kind === 'soul' && candidate.kind === 'soul') {
    return candidate.agent_id === filter.agent_id;
  }
  if (filter.kind === 'subagent' && candidate.kind === 'subagent') {
    return candidate.agent_id === filter.agent_id;
  }
  if (filter.kind === 'turn' && candidate.kind === 'turn') {
    return candidate.turn_id === filter.turn_id;
  }
  if (filter.kind === 'session' && candidate.kind === 'session') {
    return candidate.session_id === filter.session_id;
  }
  return false;
}
