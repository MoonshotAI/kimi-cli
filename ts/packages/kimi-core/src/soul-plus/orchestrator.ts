/**
 * ToolCallOrchestrator — tool execution pipeline (v2 §9-H / D18).
 *
 * Sits inside SoulPlus, invisible to Soul. Builds the `beforeToolCall` /
 * `afterToolCall` closures that get passed into `SoulConfig`. Internally
 * wires the fixed-phase pipeline:
 *
 *   validate (Soul) → preHook → permission(stub) → approval(stub) →
 *   execute (Soul) → postHook → OnToolFailure
 *
 * Phase 1 scope:
 *   - PreToolUse:  placeholder (no arg mutation, can blockAction)
 *   - PostToolUse: fires after successful execute (no throw)
 *   - OnToolFailure: fires ONLY on execute *throw* — not on
 *     `result.isError=true` (Slice 4 audit M5, §14.3 D18).
 *   - permission / approval: always-allow stubs
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

export interface ToolCallOrchestratorDeps {
  readonly hookEngine: HookEngine;
  readonly sessionId: string;
  readonly agentId: string;
}

export interface ToolCallOrchestratorContext {
  readonly turnId: string;
  readonly stepNumber?: number | undefined;
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

  buildBeforeToolCall(ctx: ToolCallOrchestratorContext): BeforeToolCallHook {
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

      const result = await this.deps.hookEngine.executeHooks('PreToolUse', hookInput, signal);

      if (result.blockAction) {
        return { block: true, reason: result.reason };
      }

      // Phase 1: updatedInput is intentionally NOT passed through
      return undefined;
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
