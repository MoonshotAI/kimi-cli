/**
 * ApprovalRuntime — interface + default stub (§9-G).
 *
 * Slice 2.3 upgrades the Phase 1 `AlwaysAllowApprovalRuntime` stub with a
 * real `WiredApprovalRuntime` (see `./wired-approval-runtime.ts`) that
 * persists requests/responses to wire.jsonl, supports crash recovery,
 * cancellation, timeouts, and session-scoped auto-approve.
 *
 * Soul is completely unaware of ApprovalRuntime — it only sees the
 * `beforeToolCall` callback which returns `undefined` (allow) or
 * `{block, reason}` (deny). Embedders can replace the entire approval
 * subsystem by providing their own `beforeToolCall`.
 */

import type { ApprovalDisplay, ApprovalSource } from '../storage/wire-record.js';

// ── Error shared across the subsystem ─────────────────────────────────

/**
 * Thrown when a cross-process / team forwarding hook is invoked before
 * the TeamDaemon wiring lands (Slice 2.6+). Callers should treat this as
 * an unrecoverable misconfiguration in Slice 2.3.
 */
export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} not implemented in Slice 2.3 (deferred to TeamDaemon)`);
    this.name = 'NotImplementedError';
  }
}

// ── Request / Response types (§9-G.2) ─────────────────────────────────

export interface ApprovalRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  /** Coarse action label (e.g. "run command"). Drives approve_for_session. */
  readonly action: string;
  readonly display: ApprovalDisplay;
  readonly source: ApprovalSource;
  /** Turn id for wire-record correlation. Optional for back-compat. */
  readonly turnId?: string | undefined;
  /** Step within the current turn for wire-record correlation. */
  readonly step?: number | undefined;
}

export interface ApprovalResult {
  readonly approved: boolean;
  readonly feedback?: string | undefined;
}

export interface ApprovalResponseData {
  readonly response: 'approved' | 'rejected' | 'cancelled';
  readonly feedback?: string | undefined;
  /**
   * Optional UI-level scope hint. When `'session'`, the runtime treats the
   * response as `approve_for_session`: persists the action to the
   * session's auto-approve cache, injects a session-runtime permission
   * rule via the `ruleInjector` callback (if provided), and cascade-
   * resolves every other pending approval with the same action.
   *
   * This field is **not** persisted on the wire record — `approval_response`
   * still serialises the three-state v2 enum. The session-scope side-
   * effects happen out-of-band via state.json.
   */
  readonly scope?: 'session' | undefined;
}

/**
 * Shape used by `ingestRemoteRequest` (v2 §9-G.2 L5318). Mirrors the
 * `approval_request` wire envelope payload (§7.3.3). Slice 2.3 only
 * declares the type so the interface is complete; the method itself
 * throws `NotImplementedError` until Slice 2.6+ lands TeamDaemon.
 */
export interface ApprovalRequestPayload {
  readonly request_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly action: string;
  readonly display: ApprovalDisplay;
  readonly source: ApprovalSource;
  readonly turn_id?: string | undefined;
  readonly step?: number | undefined;
}

// ── Interface (§9-G.2) ────────────────────────────────────────────────

/**
 * ApprovalRuntime manages the "request → await user → resolve" lifecycle
 * for tool execution approval. SoulPlus owns the instance; Soul is unaware.
 */
export interface ApprovalRuntime {
  /**
   * Initiate an approval request. Resolves when the user responds.
   * Writes an `approval_request` record to wire.jsonl **before** the
   * waiter is installed (§9-G.3 落盘顺序 invariant) and the returned
   * promise resolves after the matching `approval_response` has been
   * persisted.
   *
   * `signal` — optional abort signal; when the signal fires the runtime
   * writes a synthetic cancelled response and rejects the waiter.
   */
  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResult>;

  /**
   * Called on startup (§9-G.4): scan wire.jsonl for dangling
   * approval_requests (request without response), and write synthetic
   * cancelled approval_responses. Passive journal repair only. Idempotent:
   * a second call after all dangling have been repaired is a no-op.
   */
  recoverPendingOnStartup(): Promise<void>;

  /**
   * Wire server calls this when it receives an ApprovalResponse from the
   * client. Persists the wire record, then resolves the pending waiter
   * for the given requestId. When `response.scope === 'session'`, the
   * runtime also updates its session-level auto-approve cache, injects a
   * session-runtime permission rule (via the optional rule injector),
   * and cascade-resolves other pending approvals sharing the same action.
   *
   * Second / unknown-id resolves are silent no-ops.
   */
  resolve(requestId: string, response: ApprovalResponseData): void;

  /**
   * Batch-cancel all pending approvals matching the given source.
   * Each cancelled waiter gets a synthetic cancelled `approval_response`
   * record written to wire.jsonl. Part of the Abort Propagation Contract
   * (§5.9 / D17).
   *
   * Typical callers:
   *   - TurnManager.abortTurn → cancelBySource({kind:'turn', turn_id})
   *   - Subagent killed       → cancelBySource({kind:'subagent', agent_id})
   *   - Session shutdown      → cancelBySource({kind:'session', session_id})
   *
   * ── Synchronous void contract (v2 §7.2 / 决策 #102) ───────────────────
   *
   * This method is declared `void`, NOT `Promise<void>`, to lock the
   * synchronous semantics at the type level:
   *
   *   - Any in-memory pending `ApprovalWaiter` whose source matches the
   *     argument MUST be rejected AND a cancel event emitted BEFORE
   *     this method returns. Callers (TurnManager.abortTurn) rely on
   *     this so the subsequent `orchestrator.discardStreaming` and
   *     `tracker.cancelTurn` steps see a clean slate.
   *   - wire.jsonl persistence for the synthetic cancelled
   *     `approval_response` record is NOT guaranteed before return — it
   *     rides the normal async journal path.
   *   - Cross-process cancellation (kill remote subagent, send cancel
   *     envelope, etc.) is NOT promised here either; it is handled
   *     out-of-band by the TeamDaemon.
   *
   * Callers MUST NOT `await` this method — the `void` return forbids it
   * at compile time.
   */
  cancelBySource(source: ApprovalSource): void;

  /**
   * TeamDaemon calls this when a cross-process teammate forwards an
   * approval_request envelope. Slice 2.3 stubs this out — the real
   * implementation lands in Slice 2.6+ (TeamDaemon).
   */
  ingestRemoteRequest(data: ApprovalRequestPayload): Promise<void>;

  /**
   * TeamDaemon calls this when a cross-process teammate forwards an
   * approval_response envelope. Slice 2.3 stubs this out.
   */
  resolveRemote(data: { request_id: string } & ApprovalResponseData): void;
}

// ── Always-allow stub (default when nothing is wired) ─────────────────

/**
 * Default stub used when no wire/UI integration is required (e.g. unit
 * tests of unrelated layers, or embedder harnesses that bypass approvals
 * entirely via their own `beforeToolCall`). Every request is immediately
 * approved and no records are written.
 *
 * For the real implementation see `./wired-approval-runtime.ts`.
 */
export class AlwaysAllowApprovalRuntime implements ApprovalRuntime {
  async request(_req: ApprovalRequest, _signal?: AbortSignal): Promise<ApprovalResult> {
    return { approved: true };
  }

  async recoverPendingOnStartup(): Promise<void> {
    // No-op: always-allow stub has no pending approvals to recover.
  }

  resolve(_requestId: string, _response: ApprovalResponseData): void {
    // No-op: always-allow stub has no waiters to resolve.
  }

  cancelBySource(_source: ApprovalSource): void {
    // No-op: always-allow stub has no pending approvals to cancel.
  }

  async ingestRemoteRequest(_data: ApprovalRequestPayload): Promise<void> {
    throw new NotImplementedError('ApprovalRuntime.ingestRemoteRequest');
  }

  resolveRemote(_data: { request_id: string } & ApprovalResponseData): void {
    throw new NotImplementedError('ApprovalRuntime.resolveRemote');
  }
}
