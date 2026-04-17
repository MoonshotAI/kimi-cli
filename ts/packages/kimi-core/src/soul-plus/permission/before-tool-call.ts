/**
 * buildBeforeToolCall — the closure factory that bakes a PermissionRule
 * snapshot + PermissionMode + ApprovalRuntime reference into a single
 * `BeforeToolCallHook` (v2 §9-E.7).
 *
 * This function is called by `ToolCallOrchestrator.buildBeforeToolCall`
 * once per turn (see `TurnManager.launchTurn`). The returned closure
 * captures the *current* rule snapshot so a future turn cannot observe
 * a stale cached callback with last-turn's disallowedTools (Q6
 * regression guarantee).
 *
 * Flow per tool call:
 *   1. `checkRulesDetailed(...)` decides allow / deny / ask + matched rule
 *   2. allow → return undefined  (Soul continues)
 *   3. deny  → return {block:true, reason}  — `matchedRule.reason` is
 *              threaded into the block reason so the UI can show the
 *              user why the call was blocked (Slice 2.2 reviewer N2).
 *   4. ask   → `approvalRuntime.request(...)` under `withTimeout` guard
 *              - approved → return undefined
 *              - rejected / timed out / aborted → return {block:true, reason}
 *
 * Slice 2.3 changes:
 *   - Threads real `turnId` through each request so the wire record
 *     correlates to the current turn.
 *   - Derives the coarse `action` label via `describeApprovalAction(...)`
 *     so `approve_for_session` can cache decisions.
 *   - Propagates `rule.reason` into the block reason (reviewer N2).
 *   - Passes the parent `AbortSignal` into `approvalRuntime.request(...)`
 *     so the runtime itself can write the synthetic cancelled record.
 */

import type {
  BeforeToolCallContext,
  BeforeToolCallHook,
  BeforeToolCallResult,
} from '../../soul/types.js';
import type { ApprovalDisplay, ApprovalSource } from '../../storage/wire-record.js';
import type { ApprovalRuntime } from '../approval-runtime.js';
import { describeApprovalAction } from './action-label.js';
import { checkRulesDetailed } from './check-rules.js';
import { formatMessage } from './errors.js';
import type { PermissionMode, PermissionRule } from './types.js';
import { ApprovalTimeoutError, withTimeout } from './with-timeout.js';

/** Default 300 s — matches Python #1724 fix (`wait_for_response` hard cap). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

export interface BuildBeforeToolCallOptions {
  readonly rules: readonly PermissionRule[];
  readonly mode: PermissionMode;
  readonly approvalRuntime: ApprovalRuntime;
  readonly approvalSource: ApprovalSource;
  /** Turn id threaded into every outbound ApprovalRequest. */
  readonly turnId?: string | undefined;
  /** Default: 300_000 ms. Tests override to smaller values. */
  readonly approvalTimeoutMs?: number | undefined;
  /**
   * Optional action-label override — Slice 2.5 hooks that introduce a
   * richer `BeforeToolCallContext.actionLabel` surface will wire this.
   * When omitted, the closure derives the label from the approval
   * display + tool name (see `describeApprovalAction`).
   */
  readonly actionLabelOverride?:
    | ((toolName: string, args: unknown) => string | undefined)
    | undefined;
}

export function buildBeforeToolCall(options: BuildBeforeToolCallOptions): BeforeToolCallHook {
  // Snapshot everything by value so the returned closure never observes
  // a mutation from the caller between turns (Q6 regression guarantee).
  const rules = [...options.rules];
  const mode = options.mode;
  const approvalRuntime = options.approvalRuntime;
  const approvalSource = options.approvalSource;
  const turnId = options.turnId;
  const timeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const actionLabelOverride = options.actionLabelOverride;
  const isSubagent = approvalSource.kind === 'subagent';

  let stepCounter = 0;

  return async (
    ctx: BeforeToolCallContext,
    signal: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    const toolName = ctx.toolCall.name;
    const args = ctx.args;

    const { decision, matchedRule } = checkRulesDetailed(rules, toolName, args, mode);

    if (decision === 'allow') {
      return undefined;
    }

    if (decision === 'deny') {
      // Surface rule.reason to the UI when available (reviewer N2).
      return {
        block: true,
        reason: formatMessage(toolName, isSubagent, matchedRule?.reason),
      };
    }

    // decision === 'ask' → bounce through ApprovalRuntime.
    const display: ApprovalDisplay = {
      kind: 'generic',
      summary: `Approve ${toolName}`,
      detail: args,
    };

    const override = actionLabelOverride?.(toolName, args);
    const action = describeApprovalAction(toolName, args, display, override);
    stepCounter += 1;
    const step = stepCounter;

    try {
      const result = await withTimeout(
        approvalRuntime.request(
          {
            toolCallId: ctx.toolCall.id,
            toolName,
            action,
            display,
            source: approvalSource,
            ...(turnId !== undefined ? { turnId } : {}),
            step,
          },
          signal,
        ),
        timeoutMs,
        signal,
      );
      if (result.approved) return undefined;
      return {
        block: true,
        reason:
          result.feedback ?? formatMessage(toolName, isSubagent, 'user rejected approval request'),
      };
    } catch (error) {
      if (error instanceof ApprovalTimeoutError) {
        return {
          block: true,
          reason: formatMessage(toolName, isSubagent, `approval timed out after ${timeoutMs}ms`),
        };
      }
      // Abort: bubble up so Soul treats it as a genuine abort and
      // doesn't persist a synthetic "denied" tool result. Any other
      // unexpected error from the approval runtime is surfaced to the
      // tool_result pipeline via Soul's catch (run-turn.ts L180).
      throw error;
    }
  };
}

