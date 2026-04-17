/**
 * Test approval factories — Phase 9 §3.
 *
 * Two shapes:
 *   - `createTestApproval({yolo:true})` — always-approve; matches the
 *     production `AlwaysAllowApprovalRuntime`. `yolo:false` returns a
 *     rejecting runtime that always denies.
 *   - `createScriptedApproval({decisions, perToolName, defaultDecision})`
 *     — plays back a queue of decisions, or a per-tool-name table, or a
 *     single default. Exposes the recorded request log so tests can
 *     assert on order / shape.
 */

import {
  AlwaysAllowApprovalRuntime,
  type ApprovalRequest,
  type ApprovalRequestPayload,
  type ApprovalResponseData,
  type ApprovalResult,
  type ApprovalRuntime,
  NotImplementedError,
} from '../../../src/soul-plus/approval-runtime.js';
import type { ApprovalSource } from '../../../src/storage/wire-record.js';

export type ScriptedApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'approve_for_session' }
  | { kind: 'reject'; feedback?: string | undefined }
  | { kind: 'cancel' }
  | { kind: 'timeout' };

export interface CreateTestApprovalOptions {
  readonly yolo?: boolean;
}

/**
 * Yolo-mode default: always-approve. When `yolo: false`, denies every
 * request (useful for tests that exercise the reject path).
 */
export function createTestApproval(opts?: CreateTestApprovalOptions): ApprovalRuntime {
  if ((opts?.yolo ?? true)) return new AlwaysAllowApprovalRuntime();
  return {
    async request(): Promise<ApprovalResult> {
      return { approved: false, feedback: 'createTestApproval: yolo=false always rejects' };
    },
    async recoverPendingOnStartup(): Promise<void> {
      /* no-op */
    },
    resolve(_requestId: string, _response: ApprovalResponseData): void {
      /* no-op */
    },
    cancelBySource(_source: ApprovalSource): void {
      /* no-op */
    },
    async ingestRemoteRequest(_data: ApprovalRequestPayload): Promise<void> {
      throw new NotImplementedError('ApprovalRuntime.ingestRemoteRequest');
    },
    resolveRemote(_data: { request_id: string } & ApprovalResponseData): void {
      throw new NotImplementedError('ApprovalRuntime.resolveRemote');
    },
  };
}

export interface CreateScriptedApprovalOptions {
  readonly decisions?: readonly ScriptedApprovalDecision[];
  readonly perToolName?: Readonly<Record<string, ScriptedApprovalDecision>>;
  readonly defaultDecision?: ScriptedApprovalDecision;
}

export interface ScriptedApprovalResult {
  readonly approval: ApprovalRuntime;
  /** Ordered log of every request the adapter received. */
  readonly requests: readonly ApprovalRequest[];
}

/**
 * Build an approval runtime with per-request decisions.
 *
 * Resolution order for each incoming request:
 *   1. `perToolName[req.toolName]` when defined
 *   2. the next unconsumed entry from `decisions`
 *   3. `defaultDecision` (default: `{kind:'approve'}`)
 *
 * `timeout` decisions simulate a hung UI — the promise never resolves.
 * Callers should pair these with the request's `signal` to force
 * termination.
 */
export function createScriptedApproval(
  opts?: CreateScriptedApprovalOptions,
): ScriptedApprovalResult {
  const queue: ScriptedApprovalDecision[] = [...(opts?.decisions ?? [])];
  const perTool = opts?.perToolName;
  const fallback: ScriptedApprovalDecision = opts?.defaultDecision ?? { kind: 'approve' };
  const requests: ApprovalRequest[] = [];

  function nextDecision(req: ApprovalRequest): ScriptedApprovalDecision {
    if (perTool !== undefined) {
      const hit = perTool[req.toolName];
      if (hit !== undefined) return hit;
    }
    const next = queue.shift();
    if (next !== undefined) return next;
    return fallback;
  }

  function translate(
    decision: ScriptedApprovalDecision,
    signal: AbortSignal | undefined,
  ): Promise<ApprovalResult> {
    switch (decision.kind) {
      case 'approve':
      case 'approve_for_session':
        return Promise.resolve({ approved: true });
      case 'reject':
        return Promise.resolve({
          approved: false,
          ...(decision.feedback !== undefined ? { feedback: decision.feedback } : {}),
        });
      case 'cancel':
        return Promise.resolve({ approved: false, feedback: 'cancelled' });
      case 'timeout':
        return new Promise<ApprovalResult>((_, reject) => {
          if (signal?.aborted === true) {
            reject(new Error('approval aborted'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('approval aborted'));
            },
            { once: true },
          );
        });
      default: {
        const _exhaustive: never = decision;
        void _exhaustive;
        return Promise.reject(new Error('unreachable: unknown decision'));
      }
    }
  }

  const approval: ApprovalRuntime = {
    async request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResult> {
      requests.push(req);
      const decision = nextDecision(req);
      return translate(decision, signal);
    },
    async recoverPendingOnStartup(): Promise<void> {
      /* no-op */
    },
    resolve(_requestId: string, _response: ApprovalResponseData): void {
      /* no-op */
    },
    cancelBySource(_source: ApprovalSource): void {
      /* no-op */
    },
    async ingestRemoteRequest(_data: ApprovalRequestPayload): Promise<void> {
      throw new NotImplementedError('ApprovalRuntime.ingestRemoteRequest');
    },
    resolveRemote(_data: { request_id: string } & ApprovalResponseData): void {
      throw new NotImplementedError('ApprovalRuntime.resolveRemote');
    },
  };

  return { approval, requests };
}
