/**
 * PermissionClosureBuilder — pure permission logic extracted from
 * TurnManager (v2 §6.4 / 决策 #109 / phase-4 todo Part A.3).
 *
 * Three methods:
 *
 *   - `computeTurnRules(sessionRules, pendingOverrides?)` — merge
 *     session rules with per-turn `activeTools` / `disallowedTools`
 *     overrides into a fresh `turn-override` scope PermissionRule[]
 *     that the orchestrator consumes for the next tool-call decision.
 *
 *   - `buildBeforeToolCall(ctx)` — return the full pre-tool-call closure
 *     (PreToolUse hook + permission rule walk + approval). Delegates to
 *     `ToolCallOrchestrator.buildBeforeToolCall` when an orchestrator is
 *     supplied; otherwise returns an always-allow closure suitable for
 *     embed / test scenarios.
 *
 *   - `buildAfterToolCall(ctx)` — same delegation shape for the
 *     post-tool-call hook (PostToolUse / OnToolFailure).
 *
 * Zero state — every call is self-contained. Keeps TurnManager a
 * coordinator without baking permission semantics into it.
 */

import type { AfterToolCallHook, BeforeToolCallHook, Tool } from '../soul/types.js';
import type { HookEngine } from '../hooks/engine.js';
import type { ApprovalSource } from '../storage/wire-record.js';
import type { ToolCallOrchestrator } from './orchestrator.js';
import type { PermissionMode, PermissionRule } from './permission/index.js';

export interface PermissionClosureBuilderDeps {
  readonly orchestrator?: ToolCallOrchestrator | undefined;
  readonly hookEngine?: HookEngine | undefined;
}

/**
 * Per-turn permission overrides (v2 §9-E.6 — "FullTurnOverrides").
 * Drained after each `launchTurn` so the next turn starts from a clean
 * slate (Q6 regression guarantee). Phase 4 ownership migration (决策 #109):
 * this type now lives with `PermissionClosureBuilder` — the permission
 * subsystem, not TurnManager, is the authority for permission shapes.
 * `turn-manager.ts` re-exports it for backward-compat callers.
 */
export interface TurnPermissionOverrides {
  readonly activeTools?: readonly string[] | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
}

export interface PermissionClosureContext {
  readonly turnId: string;
  readonly permissionRules: readonly PermissionRule[];
  readonly permissionMode: PermissionMode;
  readonly approvalSource: ApprovalSource;
  readonly stepNumber?: number | undefined;
  readonly approvalTimeoutMs?: number | undefined;
  /**
   * Slice 5 / 决策 #96 L1 — name-keyed lookup of the tools the
   * orchestrator wrapped for this turn. Threaded into
   * `orchestrator.buildAfterToolCall` so the budget seam can resolve
   * the live `maxResultSizeChars` for every tool call. Optional so
   * tests / embed scenarios that don't care about budget can omit it.
   */
  readonly toolsByName?: ReadonlyMap<string, Tool> | undefined;
}

export class PermissionClosureBuilder {
  constructor(private readonly deps: PermissionClosureBuilderDeps) {}

  /**
   * Merge `sessionRules` with the per-turn `activeTools` (allow) and
   * `disallowedTools` (deny) overrides. Session rules come first so the
   * turn-override rules win at walk time (later rules overtake earlier
   * when the rule table is scanned in forward order).
   *
   * Returns the input `sessionRules` unchanged when no overrides are
   * present — the caller may freely cache this reference.
   */
  computeTurnRules(
    sessionRules: readonly PermissionRule[],
    pendingOverrides: TurnPermissionOverrides | undefined,
  ): readonly PermissionRule[] {
    if (pendingOverrides === undefined) {
      return sessionRules;
    }
    const turnRules: PermissionRule[] = [];
    if (pendingOverrides.activeTools !== undefined) {
      for (const toolName of pendingOverrides.activeTools) {
        turnRules.push({
          decision: 'allow',
          scope: 'turn-override',
          pattern: toolName,
          reason: 'activeTools turn override',
        });
      }
    }
    if (pendingOverrides.disallowedTools !== undefined) {
      for (const toolName of pendingOverrides.disallowedTools) {
        turnRules.push({
          decision: 'deny',
          scope: 'turn-override',
          pattern: toolName,
          reason: 'disallowedTools turn override',
        });
      }
    }
    return [...sessionRules, ...turnRules];
  }

  buildBeforeToolCall(ctx: PermissionClosureContext): BeforeToolCallHook {
    const orchestrator = this.deps.orchestrator;
    if (orchestrator !== undefined) {
      return orchestrator.buildBeforeToolCall({
        turnId: ctx.turnId,
        permissionRules: ctx.permissionRules,
        permissionMode: ctx.permissionMode,
        approvalSource: ctx.approvalSource,
        ...(ctx.stepNumber !== undefined ? { stepNumber: ctx.stepNumber } : {}),
        ...(ctx.approvalTimeoutMs !== undefined
          ? { approvalTimeoutMs: ctx.approvalTimeoutMs }
          : {}),
      });
    }
    // oxlint-disable-next-line unicorn/no-useless-undefined
    return async () => undefined;
  }

  buildAfterToolCall(ctx: PermissionClosureContext): AfterToolCallHook {
    const orchestrator = this.deps.orchestrator;
    if (orchestrator !== undefined) {
      return orchestrator.buildAfterToolCall(
        {
          turnId: ctx.turnId,
          ...(ctx.stepNumber !== undefined ? { stepNumber: ctx.stepNumber } : {}),
        },
        ctx.toolsByName,
      );
    }
    // oxlint-disable-next-line unicorn/no-useless-undefined
    return async () => undefined;
  }
}
