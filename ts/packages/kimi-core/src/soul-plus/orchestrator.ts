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
 *   - PostToolUse: fires after successful execute
 *   - OnToolFailure: fires after failed execute (result.isError=true)
 *   - permission / approval: always-allow stubs
 *
 * TurnManager calls `buildBeforeToolCall()` / `buildAfterToolCall()` and
 * passes the returned closures to `SoulConfig`. TurnManager does not
 * directly call `hookEngine.executeHooks(...)` — that stays hidden here.
 */

import type { HookEngine } from '../hooks/engine.js';
import type {
  AfterToolCallContext,
  AfterToolCallHook,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallHook,
  BeforeToolCallResult,
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

export class ToolCallOrchestrator {
  constructor(private readonly deps: ToolCallOrchestratorDeps) {}

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
      const isError = atcCtx.result.isError === true;

      if (isError) {
        const hookInput = {
          event: 'OnToolFailure' as const,
          sessionId: this.deps.sessionId,
          turnId: ctx.turnId,
          stepNumber: ctx.stepNumber,
          agentId: this.deps.agentId,
          toolCall: atcCtx.toolCall,
          args: atcCtx.args,
          error: new Error(
            typeof atcCtx.result.content === 'string' ? atcCtx.result.content : 'Tool failed',
          ),
        };
        await this.deps.hookEngine.executeHooks('OnToolFailure', hookInput, signal);
      } else {
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
      }

      return undefined;
    };
  }
}
