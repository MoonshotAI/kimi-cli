/**
 * ToolCallOrchestrator — tool execution pipeline (v2 §9-H / D18).
 *
 * Sits inside SoulPlus, invisible to Soul. Builds the `beforeToolCall` /
 * `afterToolCall` closures that get passed into `SoulConfig`. Internally
 * wires the fixed-phase pipeline:
 *
 *   validate (Soul) → preHook → permission → approval →
 *   execute (Soul) → postHook → OnToolFailure
 *
 * Slice 2.2 scope:
 *   - PreToolUse:  placeholder (no arg mutation, can blockAction)
 *   - permission:  PermissionRule walk + PermissionMode overlay
 *                  (`src/soul-plus/permission`); turn-scoped closure
 *                  rebuilt every `launchTurn` so disallowedTools never
 *                  leaks across turns (Q6 regression).
 *   - approval:    `ApprovalRuntime.request()` under a 300 s hard
 *                  timeout (Python #1724). `AlwaysAllowApprovalRuntime`
 *                  stays as the default stub until Slice 2.3.
 *   - PostToolUse: fires after successful execute (no throw)
 *   - OnToolFailure: fires ONLY on execute *throw* — not on
 *     `result.isError=true` (Slice 4 audit M5, §14.3 D18).
 *
 * Orchestrator wraps each tool via `wrapTools()` to detect execute throws
 * at the orchestrator level without modifying the Soul layer's callback
 * signature. The wrapper records the throw outcome and re-throws so Soul's
 * catch path produces its standard synthetic `ToolResult`.
 *
 * TurnManager calls `wrapTools()`, `buildBeforeToolCall()` /
 * `buildAfterToolCall()` and passes the returned closures + wrapped tools
 * to `SoulConfig`. TurnManager does not directly call
 * `hookEngine.executeHooks(...)` — that stays hidden here.
 */

import type { HookEngine } from '../hooks/engine.js';
import type {
  AfterToolCallContext,
  AfterToolCallHook,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallHook,
  BeforeToolCallResult,
  Tool,
  ToolResult,
  ToolUpdate,
} from '../soul/types.js';
import type { ApprovalSource } from '../storage/wire-record.js';
import type { ApprovalRuntime } from './approval-runtime.js';
import {
  buildBeforeToolCall as buildPermissionClosure,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from './permission/index.js';
import type { PermissionMode, PermissionRule } from './permission/index.js';

export interface ToolCallOrchestratorDeps {
  readonly hookEngine: HookEngine;
  readonly sessionId: string;
  readonly agentId: string;
  readonly approvalRuntime: ApprovalRuntime;
}

export interface ToolCallOrchestratorContext {
  readonly turnId: string;
  readonly stepNumber?: number | undefined;
  /**
   * Live rule snapshot for this turn (v2 §9-E.7). The orchestrator
   * treats the array as a value — each turn rebuilds it from
   * `sessionRules + turn-override rules` so closures from prior turns
   * never leak stale `disallowedTools` into the next turn (Q6).
   */
  readonly permissionRules?: readonly PermissionRule[] | undefined;
  readonly permissionMode?: PermissionMode | undefined;
  readonly approvalSource?: ApprovalSource | undefined;
  /** Override used by tests; production callers rely on the default. */
  readonly approvalTimeoutMs?: number | undefined;
}

// ── Internal outcome tracking ─────────────────────────────────────────

type ToolOutcome = { kind: 'throw'; error: Error } | { kind: 'abort' };

function isAbortLike(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}

export class ToolCallOrchestrator {
  private readonly toolOutcomes = new Map<string, ToolOutcome>();

  constructor(private readonly deps: ToolCallOrchestratorDeps) {}

  /**
   * Wrap all tools so the orchestrator can detect execute-level throws
   * and distinguish them from normal `isError` returns. The wrapper
   * re-throws after recording the outcome — Soul still runs its catch
   * path unchanged.
   *
   * TurnManager calls this once per `launchTurn`, passing the wrapped
   * array into `SoulConfig.tools`.
   */
  wrapTools(tools: readonly Tool[]): Tool[] {
    return tools.map((inner) => this.wrapSingle(inner));
  }

  private wrapSingle(inner: Tool): Tool {
    const outcomes = this.toolOutcomes;
    return {
      name: inner.name,
      description: inner.description,
      inputSchema: inner.inputSchema,
      async execute(
        toolCallId: string,
        args: unknown,
        signal: AbortSignal,
        onUpdate?: (update: ToolUpdate) => void,
      ): Promise<ToolResult> {
        try {
          return await inner.execute(toolCallId, args, signal, onUpdate);
        } catch (error: unknown) {
          if (isAbortLike(error, signal)) {
            outcomes.set(toolCallId, { kind: 'abort' });
          } else {
            outcomes.set(toolCallId, {
              kind: 'throw',
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
          throw error;
        }
      },
    };
  }

  /**
   * Build the per-turn `beforeToolCall` closure.
   *
   * Phase order (v2 §9-E.7 + §9-H):
   *   1. PreToolUse hook — can block; hook result short-circuits.
   *   2. Permission check — `checkRules` rule walk + mode overlay.
   *   3. Approval — `ApprovalRuntime.request` under a hard timeout
   *      when the rule walk returns `ask`.
   *
   * The permission closure (steps 2-3) is built once here and captured
   * by reference; it is invoked from inside the returned async callback
   * so PreToolUse always runs *before* the rule walk. Each `launchTurn`
   * must call this factory fresh so turn-override rules never leak
   * across turns (Q6 regression).
   */
  buildBeforeToolCall(ctx: ToolCallOrchestratorContext): BeforeToolCallHook {
    const rules = ctx.permissionRules ?? [];
    const mode: PermissionMode = ctx.permissionMode ?? 'default';
    const approvalSource: ApprovalSource = ctx.approvalSource ?? {
      kind: 'soul',
      agent_id: this.deps.agentId,
    };
    const permissionClosure = buildPermissionClosure({
      rules,
      mode,
      approvalRuntime: this.deps.approvalRuntime,
      approvalSource,
      turnId: ctx.turnId,
      approvalTimeoutMs: ctx.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    });

    return async (
      btcCtx: BeforeToolCallContext,
      signal: AbortSignal,
    ): Promise<BeforeToolCallResult | undefined> => {
      const hookInput = {
        event: 'PreToolUse' as const,
        sessionId: this.deps.sessionId,
        turnId: ctx.turnId,
        stepNumber: ctx.stepNumber,
        agentId: this.deps.agentId,
        toolCall: btcCtx.toolCall,
        args: btcCtx.args,
      };

      const hookResult = await this.deps.hookEngine.executeHooks('PreToolUse', hookInput, signal);

      if (hookResult.blockAction) {
        return { block: true, reason: hookResult.reason };
      }

      // Slice 2.2: run the permission phase after the pre-hook has
      // cleared the call. `permissionClosure` owns the deny/ask/allow
      // walk, approval routing, and timeout contract.
      return permissionClosure(btcCtx, signal);
    };
  }

  buildAfterToolCall(ctx: ToolCallOrchestratorContext): AfterToolCallHook {
    return async (
      atcCtx: AfterToolCallContext,
      signal: AbortSignal,
    ): Promise<AfterToolCallResult | undefined> => {
      const toolCallId = atcCtx.toolCall.id;
      const outcome = this.toolOutcomes.get(toolCallId);
      this.toolOutcomes.delete(toolCallId);

      // (a) Abort — neither PostToolUse nor OnToolFailure fires.
      if (outcome?.kind === 'abort') {
        return undefined;
      }

      // (b) Real throw — OnToolFailure with original error.
      if (outcome?.kind === 'throw') {
        const hookInput = {
          event: 'OnToolFailure' as const,
          sessionId: this.deps.sessionId,
          turnId: ctx.turnId,
          stepNumber: ctx.stepNumber,
          agentId: this.deps.agentId,
          toolCall: atcCtx.toolCall,
          args: atcCtx.args,
          error: outcome.error,
        };
        await this.deps.hookEngine.executeHooks('OnToolFailure', hookInput, signal);
        return undefined;
      }

      // (c) Normal return (success or soft isError=true) — PostToolUse.
      const hookInput = {
        event: 'PostToolUse' as const,
        sessionId: this.deps.sessionId,
        turnId: ctx.turnId,
        stepNumber: ctx.stepNumber,
        agentId: this.deps.agentId,
        toolCall: atcCtx.toolCall,
        args: atcCtx.args,
        result: atcCtx.result,
      };
      await this.deps.hookEngine.executeHooks('PostToolUse', hookInput, signal);
      return undefined;
    };
  }
}
