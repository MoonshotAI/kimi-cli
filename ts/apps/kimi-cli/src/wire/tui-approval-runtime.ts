/**
 * TUIApprovalRuntime — bridge ApprovalRuntime impl for the Ink TUI
 * (Slice 4.2).
 *
 * ToolCallOrchestrator owns an `ApprovalRuntime` reference and calls
 * `request()` whenever a tool falls into the `ask` permission bucket.
 * This implementation forwards each request to the TUI as a wire
 * `request` message (`method: 'approval.request'`) and then blocks on
 * a `Deferred` promise. The TUI renders `ApprovalPanel`, the user
 * makes a choice, and `useWire.handleApprovalResponse` calls
 * `wireClient.respondToRequest(requestId, data)`. `KimiCoreClient`
 * routes that call into `resolveFromClient(requestId, data)`, which
 * resolves the Deferred and unblocks the orchestrator.
 *
 * Scope note: Slice 4.2 intentionally does NOT wire this runtime
 * through `WiredApprovalRuntime`, so approvals are not persisted to
 * `wire.jsonl` on the TUI path. Crash recovery of in-flight approvals
 * is a follow-up for a later slice (see the matching entry in the
 * Slice 4.2 status report).
 */

import { randomUUID } from 'node:crypto';

import type {
  ApprovalDisplay,
  ApprovalRequest,
  ApprovalRequestPayload,
  ApprovalResponseData,
  ApprovalResult,
  ApprovalRuntime,
  ApprovalSource,
  PermissionRule,
} from '@moonshot-ai/core';
import { NotImplementedError, actionToRulePattern } from '@moonshot-ai/core';

import type { ApprovalRequestData, DisplayBlock } from './events.js';
import { createRequest } from './wire-message.js';
import type { WireMessage } from './wire-message.js';

// ── Deps ────────────────────────────────────────────────────────────

export interface TUIApprovalRuntimeDeps {
  /**
   * Session id accessor — may be a fixed string or a late-bound
   * function. `KimiCoreClient` uses the function form because the
   * real session id is only known after `SessionManager.createSession`
   * resolves, but the runtime has to be constructed beforehand so
   * it can be handed to the `ToolCallOrchestrator`.
   */
  readonly sessionId: string | (() => string);
  /**
   * Called once per outbound `approval.request`. The bridge pushes the
   * returned envelope onto the per-session wire queue; `KimiCoreClient`
   * owns the queue.
   */
  readonly emit: (msg: WireMessage) => void;
  /**
   * Current turn id accessor. Optional — the envelope is still valid
   * without one, but wiring it when known keeps TUI correlation clean.
   */
  readonly currentTurnId?: (() => string | undefined) | undefined;
  /**
   * Deterministic id allocator for tests. Production uses `randomUUID`.
   */
  readonly allocateRequestId?: (() => string) | undefined;
  /**
   * Optional callback invoked when an `approve_for_session` response lands.
   * Host wires this to `TurnManager.addSessionRule` so the next same-action
   * tool call short-circuits without another prompt. Mirrors
   * `WiredApprovalRuntimeDeps.ruleInjector`; when omitted, rule injection
   * is skipped and the approve-for-session still cascades in-memory for
   * currently-pending peers.
   */
  readonly ruleInjector?: ((rule: PermissionRule) => void) | undefined;
}

/**
 * TUI-side approval response shape. The UI's `ApprovalPanelComponent`
 * emits a four-state enum (`approved_for_session` is the extra one), and
 * `resolveFromClient` normalises it into kimi-core's three-state
 * `ApprovalResponseData` (`{ response, scope? }`) before handing off.
 */
interface TuiApprovalResponseData {
  readonly response: 'approved' | 'approved_for_session' | 'rejected' | 'cancelled';
  readonly feedback?: string | undefined;
}

// ── Internal Deferred ───────────────────────────────────────────────

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
  readonly deferred: Deferred<ApprovalResult>;
  abortCleanup: (() => void) | undefined;
  settled: boolean;
}

// ── Implementation ──────────────────────────────────────────────────

export class TUIApprovalRuntime implements ApprovalRuntime {
  private readonly deps: TUIApprovalRuntimeDeps;
  private readonly allocateRequestId: () => string;
  private readonly ruleInjector: ((rule: PermissionRule) => void) | undefined;
  private readonly pending = new Map<string, Pending>();
  /** Sources passed to `cancelBySource` that had no matching entry at
   * the time — checked retroactively inside `request()` so a cancel
   * in the WAL-free bridge still catches a racing incoming request. */
  private readonly cancelledSources: ApprovalSource[] = [];
  /**
   * In-memory auto-approve cache. Mirrors `WiredApprovalRuntime.autoApproveActions`
   * (wired-approval-runtime.ts:128) so an `approve_for_session` decision
   * short-circuits subsequent same-action calls inside the **current**
   * turn. Without this, the next call still goes through the approval
   * panel because the injected `PermissionRule` is only picked up when
   * `TurnManager.launchTurn` builds the next turn's permission closure.
   * WAL-free: not persisted, lives only for the runtime's lifetime.
   */
  private readonly approvedActions = new Set<string>();

  constructor(deps: TUIApprovalRuntimeDeps) {
    this.deps = deps;
    this.allocateRequestId = deps.allocateRequestId ?? (() => `appr_${randomUUID()}`);
    this.ruleInjector = deps.ruleInjector;
  }

  async request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResult> {
    // Bail immediately if the caller already aborted — do NOT emit a
    // request the TUI will never see a response for.
    if (signal !== undefined && signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }

    // Auto-approve fast path — matches WiredApprovalRuntime.request
    // (wired-approval-runtime.ts:158-163). Required for in-turn
    // short-circuit because injected session rules only take effect on
    // the NEXT turn's permission closure.
    if (this.approvedActions.has(req.action)) {
      return { approved: true };
    }

    const requestId = this.allocateRequestId();
    const deferred = makeDeferred<ApprovalResult>();

    // Abort propagation: on signal, settle the deferred with a synthetic
    // cancelled result so the permission closure returns a clean block.
    let abortCleanup: (() => void) | undefined;
    let listener: (() => void) | undefined;
    if (signal !== undefined) {
      listener = (): void => {
        this.cancelOne(requestId, 'cancelled by signal');
      };
      signal.addEventListener('abort', listener, { once: true });
      abortCleanup = () => {
        // `listener` is set synchronously in the branch above before
        // this closure captures it; the cast narrows the nullable slot.
        signal.removeEventListener('abort', listener as () => void);
      };
    }

    const entry: Pending = {
      requestId,
      request: req,
      deferred,
      abortCleanup,
      settled: false,
    };
    this.pending.set(requestId, entry);

    // Emit the TUI wire request AFTER the pending entry is installed
    // so a racing `respondToRequest` call (from a test harness) still
    // sees the waiter. The payload shape matches `ApprovalRequestData`
    // (`apps/kimi-cli/src/wire/events.ts`) which `useWire.processMessage`
    // consumes — NOT kimi-core's internal `ApprovalRequestPayload`.
    // The display union is adapted on the fly so the TUI's existing
    // `DiffPreview` / shell / brief renderers work unchanged.
    const data: ApprovalRequestData = {
      id: requestId,
      tool_call_id: req.toolCallId,
      tool_name: req.toolName,
      action: req.action,
      description: describeApproval(req),
      display: adaptDisplay(req.display),
    };
    const resolvedSessionId =
      typeof this.deps.sessionId === 'string' ? this.deps.sessionId : this.deps.sessionId();
    const msg = createRequest('approval.request', data, {
      session_id: resolvedSessionId,
      ...(this.deps.currentTurnId?.() !== undefined
        ? { turn_id: this.deps.currentTurnId?.() as string }
        : {}),
    });
    // Re-use the allocated approval request id as the envelope id so
    // `wireClient.respondToRequest(msg.id, ...)` routes cleanly back
    // to `resolveFromClient(requestId, ...)` without a second lookup.
    msg.id = requestId;
    this.deps.emit(msg);

    // Retroactive source-cancel check — if `cancelBySource` fired while
    // we were between `pending.set` and the emit, catch it now.
    for (const src of this.cancelledSources) {
      if (matchesSource(req.source, src)) {
        this.cancelOne(requestId, 'cancelled by source');
        break;
      }
    }

    return deferred.promise;
  }

  /**
   * Route a TUI response into the runtime. Called from
   * `KimiCoreClient.respondToRequest` — the primary entry point for
   * user-initiated approval responses.
   *
   * The TUI uses a four-state enum that includes `approved_for_session`;
   * kimi-core's internal `ApprovalResponseData` is three-state with a
   * separate `scope: 'session'` field. Normalise here so downstream
   * `resolve()` only deals with the canonical shape.
   */
  resolveFromClient(requestId: string, data: unknown): void {
    if (!isTuiApprovalResponseData(data)) {
      return;
    }
    const normalized: ApprovalResponseData =
      data.response === 'approved_for_session'
        ? {
            response: 'approved',
            scope: 'session',
            ...(data.feedback !== undefined ? { feedback: data.feedback } : {}),
          }
        : {
            response: data.response,
            ...(data.feedback !== undefined ? { feedback: data.feedback } : {}),
          };
    this.resolve(requestId, normalized);
  }

  resolve(requestId: string, response: ApprovalResponseData): void {
    const entry = this.claim(requestId);
    if (entry === undefined) return;

    const isSessionApprove =
      response.scope === 'session' && response.response === 'approved';

    // Snapshot cascade targets BEFORE resolving the current entry. The
    // current entry has already been removed from `pending` by `claim`,
    // so this loop only sees unrelated peers.
    const cascadeTargets: Pending[] = [];
    if (isSessionApprove) {
      // Populate the auto-approve cache BEFORE the cascade snapshot so
      // any racing in-flight `request()` entering the fast path observes
      // the cached state (matches WiredApprovalRuntime ordering).
      this.approvedActions.add(entry.request.action);

      for (const other of this.pending.values()) {
        if (!other.settled && other.request.action === entry.request.action) {
          cascadeTargets.push(other);
        }
      }
    }

    // Rule injection — mirrors `WiredApprovalRuntime.recordSessionApproval`
    // so the NEXT turn's permission closure short-circuits via the
    // session rule walk. The current turn relies on `approvedActions`
    // above instead, because closures are built once at turn launch.
    if (isSessionApprove && this.ruleInjector !== undefined) {
      this.ruleInjector({
        decision: 'allow',
        scope: 'session-runtime',
        pattern: actionToRulePattern(entry.request.action, entry.request.toolName),
        reason: `approve_for_session: ${entry.request.action}`,
      });
    }

    const result: ApprovalResult = {
      approved: response.response === 'approved',
      ...(response.feedback !== undefined ? { feedback: response.feedback } : {}),
    };
    entry.deferred.resolve(result);

    // Cascade — queueMicrotask avoids re-entrant recursion through
    // `resolve`, matching WiredApprovalRuntime's cascade ordering.
    for (const target of cascadeTargets) {
      queueMicrotask(() => {
        this.resolve(target.requestId, { response: 'approved' });
      });
    }
  }

  async recoverPendingOnStartup(): Promise<void> {
    // WAL-free bridge: nothing durable to recover. The outer
    // KimiCoreClient is responsible for clearing stale UI state on
    // session boot.
  }

  cancelBySource(source: ApprovalSource): void {
    this.cancelledSources.push(source);
    const matches: string[] = [];
    for (const entry of this.pending.values()) {
      if (!entry.settled && matchesSource(entry.request.source, source)) {
        matches.push(entry.requestId);
      }
    }
    for (const requestId of matches) {
      this.cancelOne(requestId, 'cancelled by source');
    }
  }

  async ingestRemoteRequest(_data: ApprovalRequestPayload): Promise<void> {
    throw new NotImplementedError('TUIApprovalRuntime.ingestRemoteRequest');
  }

  resolveRemote(_data: { request_id: string } & ApprovalResponseData): void {
    throw new NotImplementedError('TUIApprovalRuntime.resolveRemote');
  }

  /** Cancel all outstanding requests — called when the session tears down. */
  disposeAll(reason = 'session closed'): void {
    for (const requestId of Array.from(this.pending.keys())) {
      this.cancelOne(requestId, reason);
    }
  }

  /** Test helper — number of in-flight approvals. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ── Internal ──────────────────────────────────────────────────────

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

  private cancelOne(requestId: string, feedback: string): void {
    const entry = this.claim(requestId);
    if (entry === undefined) return;
    entry.deferred.resolve({ approved: false, feedback });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

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

function isTuiApprovalResponseData(value: unknown): value is TuiApprovalResponseData {
  if (typeof value !== 'object' || value === null) return false;
  const response = (value as { response?: unknown }).response;
  return (
    response === 'approved' ||
    response === 'approved_for_session' ||
    response === 'rejected' ||
    response === 'cancelled'
  );
}

/**
 * Produce a one-line human-readable description for the approval
 * panel subtitle. The TUI's `ApprovalPanel` renders this under the
 * `{tool_name} is requesting approval to {action}` header.
 */
function describeApproval(req: ApprovalRequest): string {
  const display = req.display;
  switch (display.kind) {
    case 'generic':
      // Prefer the long-form `detail` (analog of the legacy `body` field)
      // when present; fall back to the short `summary` headline.
      if (typeof display.detail === 'string' && display.detail.length > 0) {
        return display.detail;
      }
      return display.summary;
    case 'command':
      return display.description ?? display.command;
    case 'diff':
      return `edit ${display.path}`;
    case 'file_io':
      return `${display.operation} ${display.path}`;
    case 'task_stop':
      return `stop task: ${display.task_description}`;
    case 'agent_call':
      return `spawn ${display.agent_name}`;
    case 'skill_call':
      return `invoke skill ${display.skill_name}`;
    case 'url_fetch':
      return `fetch ${display.url}`;
    case 'search':
      return `search: ${display.query}`;
    case 'todo_list':
      return `update todo list (${String(display.items.length)} items)`;
    case 'background_task':
      return `${display.status} task ${display.task_id}: ${display.description}`;
  }
}

/**
 * Translate kimi-core's `ApprovalDisplay` union into the TUI's
 * `DisplayBlock[]` shape consumed by `ApprovalPanel`. Most kinds map
 * to one display block; the `generic` body is already surfaced via the
 * top-level `description` field, so it intentionally emits no extra
 * display block to avoid duplicate content in the approval dialog.
 */
function adaptDisplay(display: ApprovalDisplay): DisplayBlock[] {
  switch (display.kind) {
    case 'command':
      return [
        {
          type: 'shell',
          language: 'bash',
          command: display.command,
        },
      ];
    case 'diff':
      return [
        {
          type: 'diff',
          path: display.path,
          old_text: display.before,
          new_text: display.after,
        },
      ];
    case 'file_io':
      return [
        {
          type: 'brief',
          text: `${display.operation} ${display.path}${display.detail !== undefined ? `\n${display.detail}` : ''}`,
        },
      ];
    case 'task_stop':
      return [
        {
          type: 'brief',
          text: `Stop task ${display.task_id}: ${display.task_description}`,
        },
      ];
    case 'generic':
      return [];
    case 'agent_call':
    case 'skill_call':
    case 'url_fetch':
    case 'search':
    case 'todo_list':
    case 'background_task':
      // Slice 5 — newer kinds surface as a simple brief block; the panel
      // header (via `describeApproval`) already covers the headline, so
      // emit nothing extra to keep the dialog tight.
      return [];
  }
}
