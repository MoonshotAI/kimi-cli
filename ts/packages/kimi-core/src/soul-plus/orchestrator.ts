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

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { HookEngine } from '../hooks/engine.js';
import type { PathConfig } from '../session/path-config.js';
import type {
  AfterToolCallContext,
  AfterToolCallHook,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallHook,
  BeforeToolCallResult,
  Tool,
  ToolCall,
  ToolResult,
  ToolUpdate,
} from '../soul/types.js';
import { DEFAULT_BUILTIN_MAX_RESULT_CHARS } from '../tools/display-defaults.js';
import type { ApprovalSource } from '../storage/wire-record.js';
import type { ApprovalRuntime } from './approval-runtime.js';
import {
  buildBeforeToolCall as buildPermissionClosure,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from './permission/index.js';
import type { PermissionMode, PermissionRule } from './permission/index.js';

/** Preview length copied into the in-context replacement marker. */
const PREVIEW_SIZE_CHARS = 2_000;

export interface ToolCallOrchestratorDeps {
  readonly hookEngine: HookEngine;
  /**
   * Session id stamped onto every hook input payload. Accepts either a
   * literal string (static sessions / tests) or a closure evaluated
   * lazily on each access (late-bound binding used by the TUI bridge —
   * `KimiCoreClient` constructs the orchestrator before
   * `SessionManager.createSession` has allocated the id, and resolves
   * the real id via a closure over its per-session record).
   */
  readonly sessionId: string | (() => string);
  readonly agentId: string;
  readonly approvalRuntime: ApprovalRuntime;
  /**
   * Slice 5 / 决策 #96 L1 — required for `enforceResultBudget` to spill
   * over-sized tool results to disk. Optional so existing test fixtures
   * that never trigger persistence keep working; persistence is silently
   * skipped when absent.
   */
  readonly pathConfig?: PathConfig | undefined;
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

function contentToString(content: ToolResult['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : '[non-text block]'))
    .join('');
}

export class ToolCallOrchestrator {
  private readonly toolOutcomes = new Map<string, ToolOutcome>();

  constructor(private readonly deps: ToolCallOrchestratorDeps) {}

  /**
   * Resolve the session id. When `deps.sessionId` is a closure (late-
   * bound binding from the TUI bridge), this calls it fresh on every
   * access so a session id that is allocated AFTER the orchestrator
   * is constructed still lands on each hook input payload.
   */
  private resolveSessionId(): string {
    const slot = this.deps.sessionId;
    return typeof slot === 'function' ? slot() : slot;
  }

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
    const wrapped = tools.map((inner) => this.wrapSingle(inner));
    // Populate the per-turn tool registry `executeStreaming` consults.
    // `wrapTools` is called once per launchTurn; this side-effect keeps
    // the streaming path O(1) per tool_use event without re-threading
    // tool arrays through the wrapper/orchestrator boundary.
    this.currentTools = new Map(wrapped.map((t) => [t.name, t]));
    return wrapped;
  }

  /**
   * **Phase 5+ contributors**: any new field added to `Tool` (e.g.
   * `maxResultSizeChars`, `display`, `isConcurrencySafe`) MUST be
   * forwarded here. The wrapper is what Soul actually sees; if a field
   * is dropped on the floor here, every downstream consumer
   * (`enforceResultBudget`, the streaming scheduler, display hooks)
   * silently observes `undefined` and the feature collapses without
   * a test failure. See Slice 5 review (Blocker 1).
   */
  private wrapSingle(inner: Tool): Tool {
    const outcomes = this.toolOutcomes;
    const wrapped: Tool = {
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
    // Forward Slice 5 optional fields verbatim. We attach via mutable
    // object expansion (rather than spread inside the literal above) so
    // each field stays `undefined`-safe under
    // `exactOptionalPropertyTypes`.
    if (inner.maxResultSizeChars !== undefined) {
      (wrapped as { maxResultSizeChars?: number }).maxResultSizeChars =
        inner.maxResultSizeChars;
    }
    if (inner.display !== undefined) {
      (wrapped as { display?: typeof inner.display }).display = inner.display;
    }
    if (inner.isConcurrencySafe !== undefined) {
      const predicate = inner.isConcurrencySafe.bind(inner);
      (wrapped as { isConcurrencySafe?: (input: unknown) => boolean }).isConcurrencySafe =
        predicate;
    }
    return wrapped;
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
        sessionId: this.resolveSessionId(),
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
      const permissionResult = await permissionClosure(btcCtx, signal);
      if (permissionResult?.block === true) {
        return permissionResult;
      }

      // Phase 25 Stage I (slice 25c-3) — atomic `tool_call` WAL row.
      // We take contextState from `btcCtx.context` (not `this.deps`)
      // because the orchestrator is typically constructed at app-level
      // *before* any session exists; `btcCtx` always carries the active
      // session's `SoulContextState` by construction (`runSoulTurn`
      // passes its `context` parameter into every call). Runs only when
      // Soul has threaded the per-step dynamic context (turnId /
      // stepNumber / stepUuid) onto btcCtx; missing fields leave the
      // hook transparent (back-compat for fixtures that don't drive
      // the atomic WAL path).
      //
      // WAL-then-memory ordering: the `set(...)` into the shared map
      // happens ONLY after `appendToolCall` resolves, so a durable-write
      // throw never leaves an in-memory wireUuid registration that lacks
      // a backing WAL row (test A.10).
      if (
        btcCtx.stepUuid !== undefined &&
        btcCtx.turnId !== undefined &&
        btcCtx.stepNumber !== undefined
      ) {
        const wireUuid = randomUUID();
        const wrappedTool = this.currentTools.get(btcCtx.toolCall.name);
        const display = wrappedTool?.display;
        // `as never` absorbs the generic-parameter mismatch — `Tool` is
        // erased to `Tool<unknown, unknown>` after registration, and
        // `ToolDisplayHooks<Input>.getXxx` takes `Partial<Input>` /
        // `Input`. `btcCtx.args` is `unknown`, which is not assignable
        // into `Partial<unknown>` under strict variance, so we bridge
        // through `never` — safe because each Tool's hooks only ever
        // receive its own args at the call site below.
        const activityDescription = display?.getActivityDescription?.(btcCtx.args as never);
        const userFacingName = display?.getUserFacingName?.(btcCtx.args as never);
        const inputDisplay = display?.getInputDisplay?.(btcCtx.args as never);

        await btcCtx.context.appendToolCall({
          uuid: wireUuid,
          turnId: btcCtx.turnId,
          step: btcCtx.stepNumber,
          stepUuid: btcCtx.stepUuid,
          data: {
            tool_call_id: btcCtx.toolCall.id,
            tool_name: btcCtx.toolCall.name,
            args: btcCtx.args,
            ...(activityDescription !== undefined
              ? { activity_description: activityDescription }
              : {}),
            ...(userFacingName !== undefined ? { user_facing_name: userFacingName } : {}),
            ...(inputDisplay !== undefined ? { input_display: inputDisplay } : {}),
          },
        });

        btcCtx.toolCallByProviderId?.set(btcCtx.toolCall.id, wireUuid);
      }

      return permissionResult;
    };
  }

  // ── Phase 15 B.4 D1 — streaming scheduler surface ────────────────────
  //
  // `StreamingKosongWrapper` owns a sub-controller + in-flight map per
  // `chat()` call, and attaches itself via `bindStreaming()` so the
  // orchestrator can route `discardStreaming(reason)` (issued by
  // `TurnManager.abortTurn`) back into the wrapper and drain the
  // final prefetched map on behalf of the next `Soul` loop iteration.
  //
  // Critically — `executeStreaming` is OWNED by the orchestrator, not
  // delegated to the binding. Round-1 review caught an infinite
  // recursion (wrapper → orchestrator.executeStreaming → binding → back
  // into wrapper). The fix: orchestrator does the real work here —
  // look up the tool in `currentTools`, probe `isConcurrencySafe`, and
  // return `tool.execute(...)` directly. No binding call on this path.

  private currentTools: ReadonlyMap<string, Tool> = new Map();

  private streamingBinding:
    | {
        readonly drainPrefetched: () => ReadonlyMap<string, ToolResult>;
        readonly discardStreaming: (reason: 'aborted' | 'timeout' | 'fallback') => void;
      }
    | undefined;

  /**
   * On unbind, the wrapper's completed map is copied here so post-chat
   * callers (Soul's main loop, abort-path recovery) can still drain
   * the results. Cleared on read (MAJ-2 — completed-before-abort
   * results survive even when `raw.chat` threw and the wrapper's
   * local scope GC'd).
   */
  private stashedPrefetched: Map<string, ToolResult> | undefined;

  /**
   * Phase 15 B.4 D1 — attach a streaming binding. Returns an `unbind`
   * function the caller (`StreamingKosongWrapper`) invokes once `chat()`
   * settles so the next wrapper instance can claim the slot. Multiple
   * concurrent chat() calls on the same orchestrator are not supported
   * and would overwrite each other; TurnManager holds one adapter per
   * turn so this is fine in practice.
   *
   * `binding.drainPrefetched()` is invoked during `unbind` so whatever
   * the wrapper collected up to that moment is stashed on the
   * orchestrator and remains reachable via `this.drainPrefetched()`
   * after the chat promise settles (success OR throw).
   */
  bindStreaming(binding: {
    drainPrefetched: () => ReadonlyMap<string, ToolResult>;
    discardStreaming: (reason: 'aborted' | 'timeout' | 'fallback') => void;
  }): () => void {
    this.streamingBinding = binding;
    return () => {
      if (this.streamingBinding !== binding) return;
      // Harvest the wrapper's final completed map into orchestrator-
      // scoped storage so a post-abort caller still sees results that
      // completed before the sub-controller aborted (铁律 L16).
      try {
        const harvested = binding.drainPrefetched();
        if (harvested.size > 0) {
          const stash = this.stashedPrefetched ?? new Map<string, ToolResult>();
          for (const [id, result] of harvested) stash.set(id, result);
          this.stashedPrefetched = stash;
        }
      } catch {
        /* never let a broken binding poison unbind */
      }
      this.streamingBinding = undefined;
    };
  }

  /**
   * Phase 4 — abort-contract (v2 §7.2) second step. TurnManager.abortTurn
   * calls this between `approvalRuntime.cancelBySource` and
   * `tracker.cancelTurn`. When a streaming binding is attached, the
   * method delegates; otherwise it is a no-op so older fixtures keep
   * compiling (铁律 L16 — two steps before `controller.abort`).
   */
  discardStreaming(reason: 'aborted' | 'timeout' | 'fallback'): void {
    this.streamingBinding?.discardStreaming(reason);
  }

  /**
   * Phase 15 B.4 D1 — offer a completed streaming tool_use block to
   * the prefetch scheduler. The orchestrator resolves
   * `tool.isConcurrencySafe(args)`: a truthy opt-in returns
   * `Promise<ToolResult>` (the tool's own `execute`); anything else
   * returns `undefined` so the streaming wrapper leaves the call to
   * `Soul`'s main loop.
   *
   * `currentTools` is populated by `wrapTools` on every turn. A
   * `toolCall.name` that does not match a current tool returns
   * `undefined` (defensive — should not happen in production because
   * Soul only emits tool_use for tools it was handed).
   */
  executeStreaming(
    toolCall: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolResult> | undefined {
    const tool = this.currentTools.get(toolCall.name);
    if (tool === undefined) return undefined;
    if (tool.isConcurrencySafe === undefined) return undefined;
    let safe: boolean;
    try {
      safe = tool.isConcurrencySafe(toolCall.args);
    } catch {
      return undefined;
    }
    if (!safe) return undefined;
    return tool.execute(toolCall.id, toolCall.args, signal);
  }

  /**
   * Phase 15 B.4 D1 — drain + clear prefetched results. Prefers the
   * wrapper's live map when a binding is active; otherwise returns
   * (and clears) the post-unbind stash so the abort-throw path still
   * yields completed prefetches.
   */
  drainPrefetched(): ReadonlyMap<string, ToolResult> {
    if (this.streamingBinding !== undefined) {
      return this.streamingBinding.drainPrefetched();
    }
    const stash = this.stashedPrefetched;
    this.stashedPrefetched = undefined;
    return stash ?? new Map<string, ToolResult>();
  }

  /**
   * Slice 5 / 决策 #96 L1 — afterToolCall budget seam. Computes the
   * effective character ceiling, persists oversized content to
   * `pathConfig.toolResultArchivePath`, and returns a result whose
   * `content` is the in-context preview marker. `Infinity` short-circuits
   * persistence (already-self-limited tools like Read).
   */
  async enforceResultBudget(
    tool: Tool,
    toolCallId: string,
    result: ToolResult,
  ): Promise<ToolResult> {
    const maxChars = tool.maxResultSizeChars ?? DEFAULT_BUILTIN_MAX_RESULT_CHARS;
    if (!Number.isFinite(maxChars)) return result;

    const fullContent = contentToString(result.content);
    if (fullContent.length <= maxChars) return result;

    const pathConfig = this.deps.pathConfig;
    if (pathConfig === undefined) return result;

    const archivePath = pathConfig.toolResultArchivePath(this.resolveSessionId(), toolCallId);
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, fullContent, 'utf8');

    const preview = fullContent.slice(0, PREVIEW_SIZE_CHARS);
    return {
      ...result,
      content: `<persisted-output path="${archivePath}">\n${preview}\n</persisted-output>`,
    };
  }

  buildAfterToolCall(
    ctx: ToolCallOrchestratorContext,
    toolsByName?: ReadonlyMap<string, Tool>,
  ): AfterToolCallHook {
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
          sessionId: this.resolveSessionId(),
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
        sessionId: this.resolveSessionId(),
        turnId: ctx.turnId,
        stepNumber: ctx.stepNumber,
        agentId: this.deps.agentId,
        toolCall: atcCtx.toolCall,
        args: atcCtx.args,
        result: atcCtx.result,
      };
      await this.deps.hookEngine.executeHooks('PostToolUse', hookInput, signal);

      // Slice 5 / 决策 #96 L1 — budget enforcement seam. Persist content
      // exceeding `tool.maxResultSizeChars` (or builtin default) to disk
      // and return a preview marker via `resultOverride`. Skipped when
      // `pathConfig` is absent (test fixtures) or the tool can't be
      // resolved (toolsByName not threaded yet).
      const tool = toolsByName?.get(atcCtx.toolCall.name);
      if (tool !== undefined && this.deps.pathConfig !== undefined) {
        const persisted = await this.enforceResultBudget(tool, toolCallId, atcCtx.result);
        if (persisted !== atcCtx.result) {
          return { resultOverride: persisted };
        }
      }
      return undefined;
    };
  }
}
