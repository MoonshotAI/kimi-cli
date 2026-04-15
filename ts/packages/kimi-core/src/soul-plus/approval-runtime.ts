/**
 * ApprovalRuntime — interface + always-allow stub (§9-G).
 *
 * Phase 1 scope: complete interface definition + ADR + always-allow stub.
 * No real UI, no rule engine, no crash recovery implementation.
 *
 * Soul is completely unaware of ApprovalRuntime — it only sees the
 * `beforeToolCall` callback which returns `undefined` (allow) or
 * `{block, reason}` (deny). Embedders can replace the entire approval
 * subsystem by providing their own `beforeToolCall`.
 */

import type { ApprovalDisplay, ApprovalSource } from '../storage/wire-record.js';

// ── Request / Response types (§9-G.2) ─────────────────────────────────

export interface ApprovalRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ApprovalDisplay;
  readonly source: ApprovalSource;
}

export interface ApprovalResult {
  readonly approved: boolean;
  readonly feedback?: string | undefined;
}

export interface ApprovalResponseData {
  readonly response: 'approved' | 'rejected' | 'cancelled';
  readonly feedback?: string | undefined;
}

// ── Interface (§9-G.2) ────────────────────────────────────────────────

/**
 * ApprovalRuntime manages the "request → await user → resolve" lifecycle
 * for tool execution approval. SoulPlus owns the instance; Soul is unaware.
 *
 * Phase 1: only the interface + AlwaysAllowApprovalRuntime stub exist.
 * Real implementation (UI integration, rule engine, crash recovery) is
 * deferred to Phase 2.
 */
export interface ApprovalRuntime {
  /**
   * Initiate an approval request. Resolves when the user responds.
   * In the real implementation, this writes an approval_request record
   * to wire.jsonl and awaits the corresponding approval_response.
   */
  request(req: ApprovalRequest): Promise<ApprovalResult>;

  /**
   * Called on startup (§9-G.4): scan wire.jsonl for dangling
   * approval_requests (request without response), and write synthetic
   * cancelled approval_responses. Passive journal repair only.
   */
  recoverPendingOnStartup(): Promise<void>;

  /**
   * Wire server calls this when it receives an ApprovalResponse from
   * the client. Resolves the pending waiter for the given requestId.
   */
  resolve(requestId: string, response: ApprovalResponseData): void;

  /**
   * Batch-cancel all pending approvals matching the given source.
   * Part of the Abort Propagation Contract (§5.9 / D17).
   *
   * Typical callers:
   *   - TurnManager.abortTurn → cancelBySource({kind:'turn', turn_id})
   *   - Subagent killed → cancelBySource({kind:'subagent', agent_id})
   *   - Session shutdown → cancelBySource({kind:'session', session_id})
   */
  cancelBySource(source: ApprovalSource): void;
}

// ── Always-allow stub (Phase 1 default) ────────────────────────────────

/**
 * Phase 1 stub: every request is immediately approved, no records are
 * written, no waiter table exists. This is the default `ApprovalRuntime`
 * wired into SoulPlus when no real implementation is available.
 *
 * ADR (Architecture Decision Record):
 *   - Why stub: Phase 1 does not implement UI approval flows, permission
 *     rules, or crash recovery for approvals. The full implementation
 *     requires Transport (bidirectional client ↔ core), PermissionMode
 *     state machine, and UI integration — all deferred to Phase 2.
 *   - What it does: immediately returns `{approved: true}` for every
 *     request. `recoverPendingOnStartup` / `cancelBySource` / `resolve`
 *     are no-ops.
 *   - Embedder escape hatch: embedders bypass ApprovalRuntime entirely by
 *     providing their own `beforeToolCall` callback (§9-G.7).
 */
export class AlwaysAllowApprovalRuntime implements ApprovalRuntime {
  async request(_req: ApprovalRequest): Promise<ApprovalResult> {
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
}
