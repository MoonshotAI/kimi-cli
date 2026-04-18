/**
 * TurnManager — Phase 4 coordinator (v2 §6.4 / 决策 #109).
 *
 * Phase 4 extracts TurnManager's god-object responsibilities into four
 * dedicated subcomponents:
 *
 *   - CompactionOrchestrator — executeCompaction / triggerCompaction
 *     pipeline (铁律 7: Soul does not own the flow).
 *   - PermissionClosureBuilder — computeTurnRules / buildBeforeToolCall /
 *     buildAfterToolCall (pure permission logic).
 *   - TurnLifecycleTracker — turn id counter, AbortController / promise
 *     maps, currentTurnId, lifecycle observer fan-out.
 *   - WakeQueueScheduler — FIFO TurnTrigger queue (Phase 7 wires real
 *     auto-wake triggers into it; Phase 4 only owns the slot).
 *
 * TurnManager itself is now a thin coordinator that:
 *
 *   - Owns conversation-channel handlers (handlePrompt / handleCancel /
 *     handleSteer) and the abort-contract entry point (abortTurn).
 *   - Orchestrates the `runTurn` while-loop with bounded
 *     MAX_COMPACTIONS_PER_TURN retries, delegating each compaction to
 *     `deps.compaction.executeCompaction`.
 *   - Wires SoulConfig permissions via `deps.permissionBuilder`.
 *   - Fires lifecycle events through `deps.lifecycle.fireLifecycleEvent`.
 *   - Persists turn_begin / turn_end WAL records and drives the 5-state
 *     `SessionLifecycleStateMachine` through its standard transitions.
 *
 * Abort Contract (v2 §7.2 / 决策 #102):
 *
 *   abortTurn(turnId, reason):
 *     1. approvalRuntime?.cancelBySource({kind:'turn', turn_id})   — sync void
 *     2. orchestrator?.discardStreaming?.('aborted')               — Phase 4 no-op
 *     3. await lifecycle.cancelTurn(turnId)                         — drain
 */

import type { HookEngine } from '../hooks/engine.js';
import type { StopInput, UserPromptSubmitInput } from '../hooks/types.js';
import { runSoulTurn } from '../soul/index.js';
import { ContextOverflowError } from '../soul/errors.js';
import type {
  CompactionConfig,
  EventSink,
  Runtime,
  SoulConfig,
  Tool,
  TurnResult,
} from '../soul/index.js';
// Phase 4 review (Nit 3): CompactionProvider / JournalCapability no longer
// appear on TurnManagerDeps — the CompactionOrchestrator owns them now.
import type { FullContextState, UserInput } from '../storage/context-state.js';
import type { SessionJournal } from '../storage/session-journal.js';
import type { ApprovalSource } from '../storage/wire-record.js';
import type { ApprovalRuntime } from './approval-runtime.js';
import type { CompactionOrchestrator } from './compaction-orchestrator.js';
import type { DynamicInjectionManager, InjectionContext } from './dynamic-injection.js';
import type { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';
import type { ToolCallOrchestrator } from './orchestrator.js';
import type {
  PermissionClosureBuilder,
  PermissionClosureContext,
  TurnPermissionOverrides,
} from './permission-closure-builder.js';
import type { PermissionMode, PermissionRule } from './permission/index.js';
import type { SoulRegistry } from './soul-registry.js';
import {
  type TurnLifecycleEvent,
  type TurnLifecycleListener,
  type TurnLifecycleTracker,
  type TurnState,
} from './turn-lifecycle-tracker.js';
import type { DispatchResponse, TurnTrigger } from './types.js';
import type { WakeQueueScheduler } from './wake-queue-scheduler.js';
import { checkLLMCapabilities } from './capability-check.js';
import { UNKNOWN_CAPABILITY } from '@moonshot-ai/kosong';

// ── Re-exports for backward-compat ────────────────────────────────────
//
// Phase 4 ownership migration: `TurnLifecycleEvent` / `TurnLifecycleListener` /
// `TurnState` now live on `TurnLifecycleTracker` (turn-handle owner), and
// `TurnPermissionOverrides` now lives on `PermissionClosureBuilder`
// (permission subsystem owner — 决策 #109 "子组件之间不互相引用"). The
// TurnManager module re-exports them so existing consumers / public API
// stay stable.

export type { TurnLifecycleEvent, TurnLifecycleListener, TurnState };
export type { TurnPermissionOverrides } from './permission-closure-builder.js';

export interface TurnManagerDeps {
  readonly contextState: FullContextState;
  readonly sessionJournal: SessionJournal;
  readonly runtime: Runtime;
  readonly sink: EventSink;
  readonly lifecycleStateMachine: SessionLifecycleStateMachine;
  readonly soulRegistry: SoulRegistry;
  readonly tools: readonly Tool[];

  // ── Phase 4 subcomponents ────────────────────────────────────────────
  /**
   * Compaction pipeline extracted from Phase 2's inline executeCompaction
   * (Phase 4 / 决策 #109). TurnManager only calls into this orchestrator;
   * the business flow (transitions, provider.run, journal rotate,
   * resetToSummary, token accounting) lives inside the orchestrator.
   */
  readonly compaction: CompactionOrchestrator;
  /**
   * Pure permission-logic helper that produced the SoulConfig
   * beforeToolCall / afterToolCall closures and merges session rules
   * with per-turn overrides. Delegates to `deps.orchestrator` when one
   * is wired; otherwise returns always-allow closures.
   */
  readonly permissionBuilder: PermissionClosureBuilder;
  /**
   * Turn handle state (id counter, promise / controller maps, listeners)
   * extracted from TurnManager's god-object fields.
   */
  readonly lifecycle: TurnLifecycleTracker;
  /**
   * Phase 4 placeholder — WakeQueueScheduler slot. Phase 7's
   * TeamDaemon / auto-wake wiring feeds triggers here; Phase 4 leaves it
   * optional so test harnesses can elide the scheduler entirely.
   */
  readonly wakeScheduler?: WakeQueueScheduler | undefined;

  // ── Optional (config / capability) ───────────────────────────────────
  readonly agentType?: 'main' | 'sub' | 'independent' | undefined;
  readonly agentId?: string | undefined;
  /**
   * Phase 17 §B.1 — subagent type label (e.g. `'researcher'`). Only
   * meaningful when `agentType === 'sub'`; attached to the
   * `ApprovalSource.subagent` record so downstream tooling can group
   * approval history by subagent role.
   */
  readonly subagentType?: string | undefined;
  readonly orchestrator?: ToolCallOrchestrator | undefined;
  /**
   * Optional approval runtime reference used by `abortTurn` to cancel
   * pending approvals synchronously before aborting the turn controller
   * (v2 §7.2 / 决策 #102). When absent, the approval step of the abort
   * contract is a no-op.
   */
  readonly approvalRuntime?: ApprovalRuntime | undefined;
  readonly sessionRules?: readonly PermissionRule[] | undefined;
  readonly permissionMode?: PermissionMode | undefined;
  readonly compactionConfig?: CompactionConfig | undefined;
  readonly dynamicInjectionManager?: DynamicInjectionManager | undefined;
  readonly hookEngine?: HookEngine | undefined;
  readonly sessionId?: string | undefined;
  readonly planMode?: boolean | undefined;
}

/**
 * Phase 2 (todo Step 7): hard cap on how many compaction round-trips a
 * single turn is allowed. After the cap is exceeded the turn is
 * terminated with a `session.error` / `stopReason='error'` so a
 * misbehaving provider cannot lock the session in an infinite
 * compaction loop.
 */
const MAX_COMPACTIONS_PER_TURN = 3;

/**
 * Default context window used for `status.update.context_usage.total`
 * when the session has no `compactionConfig.maxContextSize`. Matches
 * the fallback used by existing config schema (200k-token window of
 * typical GPT-4/Claude models).
 */
const DEFAULT_CONTEXT_WINDOW = 200_000;

function zeroUsage(): TurnResult['usage'] {
  return { input: 0, output: 0 };
}

export class TurnManager {
  private readonly deps: TurnManagerDeps;
  private readonly agentType: 'main' | 'sub' | 'independent';
  private readonly agentId: string;
  private readonly subagentType: string | undefined;
  private readonly sessionRules: PermissionRule[];
  private permissionMode: PermissionMode;
  private pendingTurnOverrides: TurnPermissionOverrides | undefined;
  private planMode: boolean;
  private readonly sessionId: string;
  /**
   * Phase 18 A.13 — terminal reason per turn id for callers that
   * observe the turn lifecycle out-of-band (after the `end` event
   * has fired). `awaitTurn(turnId)` resolves to `undefined` for the
   * error path; this map lets wire handlers distinguish `error`
   * (provider throw) from `cancelled` when surfacing the -32003 code.
   */
  private readonly terminalReasons = new Map<string, 'done' | 'cancelled' | 'error'>();
  /**
   * Synchronous reservation window — set BEFORE the first `await` in
   * `handlePrompt` so a re-entrant call fails the busy-check before the
   * tracker has registered the turn. Cleared once `launchTurn` has
   * handed ownership to the tracker (or on rollback).
   */
  private pendingLaunchTurnId: string | undefined;

  constructor(deps: TurnManagerDeps) {
    this.deps = deps;
    this.agentType = deps.agentType ?? 'main';
    this.agentId = deps.agentId ?? 'agent_main';
    this.subagentType = deps.subagentType;
    this.sessionRules = [...(deps.sessionRules ?? [])];
    this.permissionMode = deps.permissionMode ?? 'default';
    this.planMode = deps.planMode ?? false;
    this.sessionId = deps.sessionId ?? 'unknown';
  }

  // ── Permission / plan-mode control surface ──────────────────────────

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  setPlanMode(enabled: boolean): void {
    this.planMode = enabled;
    // Phase 17 §A.2 / Phase 18 A.14 — surface plan-mode flips to the wire
    // as a minimal `status.update` frame so clients refresh their mode
    // indicator without polling. Full-snapshot status.update (with
    // context_usage + token_usage) fires from the turn-end path.
    this.deps.sink.emit({
      type: 'status.update',
      data: { plan_mode: enabled },
    });
  }

  getPlanMode(): boolean {
    return this.planMode;
  }

  getAgentId(): string {
    return this.agentId;
  }

  /**
   * Phase 20 §A — lifecycle idle check for SessionControl-level guards
   * (`/clear` in particular). Mirrors the `isIdle()` check that
   * `CompactionOrchestrator.triggerCompaction` performs before taking
   * over the lifecycle, so both slash commands refuse when a turn or
   * compaction is already in flight.
   */
  isIdle(): boolean {
    return this.deps.lifecycleStateMachine.isIdle();
  }

  /** Phase 20 §A — lifecycle state accessor used for richer error messages. */
  getLifecycleState(): string {
    return this.deps.lifecycleStateMachine.state;
  }

  /**
   * Combines the synchronous pre-registration reservation (in-flight
   * launch window) with the tracker's authoritative currentTurnId.
   * Either side being set means "session is busy".
   */
  getCurrentTurnId(): string | undefined {
    return this.pendingLaunchTurnId ?? this.deps.lifecycle.getCurrentTurnId();
  }

  addSessionRule(rule: PermissionRule): void {
    this.sessionRules.push(rule);
  }

  getSessionRules(): readonly PermissionRule[] {
    return this.sessionRules;
  }

  setPendingTurnOverrides(overrides: TurnPermissionOverrides | undefined): void {
    this.pendingTurnOverrides = overrides;
  }

  getPendingTurnOverrides(): TurnPermissionOverrides | undefined {
    return this.pendingTurnOverrides;
  }

  // ── Lifecycle listener / turn handle pass-throughs ──────────────────

  addTurnLifecycleListener(listener: TurnLifecycleListener): () => void {
    return this.deps.lifecycle.addListener(listener);
  }

  async awaitTurn(turnId: string): Promise<TurnResult | undefined> {
    return this.deps.lifecycle.awaitTurn(turnId);
  }

  /**
   * Phase 18 A.13 — read the terminal reason for a turn. Available
   * after `awaitTurn` resolves; lets out-of-band observers (wire
   * handlers) distinguish error vs cancelled when the turn result
   * itself is `undefined`.
   *
   * Read-once semantics (L2-7): the entry is removed on access so
   * long-running sessions do not accumulate one Map entry per turn
   * forever. Callers that need the reason more than once should
   * cache the first read. If no entry exists (late call / unknown
   * turn), returns `undefined`.
   */
  getTerminalReason(turnId: string): 'done' | 'cancelled' | 'error' | undefined {
    const reason = this.terminalReasons.get(turnId);
    if (reason !== undefined) {
      this.terminalReasons.delete(turnId);
    }
    return reason;
  }

  // ── Manual compaction (wrapper for backward-compat) ─────────────────

  /**
   * Thin wrapper around `CompactionOrchestrator.triggerCompaction`. Kept
   * as a TurnManager method because existing callers (SessionControl,
   * tests) already drive manual compaction through the TurnManager
   * facade.
   */
  async triggerCompaction(customInstruction?: string): Promise<void> {
    return this.deps.compaction.triggerCompaction(customInstruction);
  }

  // ── Abort Contract (v2 §7.2 / 决策 #102) ────────────────────────────

  /**
   * Cancel an in-flight turn per v2 §7.2 three-step contract (决策 #102):
   *
   *   1. `approvalRuntime.cancelBySource({kind:'turn', turn_id})`
   *      — synchronous void; every pending approval_waiter for this
   *      turn is rejected + a cancel event emitted BEFORE returning.
   *   2. `orchestrator.discardStreaming?('aborted')`
   *      — Phase 15 B.4: signals the streaming wrapper to abort its
   *      sub-controller so in-flight prefetches bail; results that
   *      already resolved stay reachable through the wrapper's
   *      `completed` map.
   *   3. `await lifecycle.cancelTurn(turnId)`
   *      — AbortController.abort() + await the turn promise so
   *      `abortTurn` only resolves after the turn has fully drained.
   *
   * Phase 15 MAJ-R2-1 — after the lifecycle abort returns, we drain
   * the orchestrator's prefetch stash one last time. The stash holds
   * results that completed before the sub-controller aborted (铁律
   * L16 says they must survive the abort); since this turn is being
   * cancelled and no downstream consumer is going to claim them, we
   * drop the entries here instead of letting them accumulate
   * forever (unbounded growth in abort-heavy workloads). 铁律 L16
   * only requires that completed prefetches are not falsely
   * cancelled — discarding them AFTER the abort path returns is
   * fine; the tool results are no longer useful in this turn.
   *
   * @param turnId — the turn to cancel
   * @param reason — diagnostic tag forwarded to Phase 5 telemetry.
   *   Currently-known call sites:
   *     `'dispatch-cancel'` — from `handleCancel` (wire `session.cancel`)
   *   Phase 5+ will add: `'timeout'`, `'shutdown'`, `'parent-abort'`,
   *   `'compaction-timeout'`, etc. The parameter stays `string` rather
   *   than a closed union so downstream slices can extend the vocabulary
   *   without touching TurnManager.
   */
  async abortTurn(turnId: string, reason: string): Promise<void> {
    void reason; // reserved for Phase 5 telemetry / wire-record stamping
    const source: ApprovalSource = { kind: 'turn', turn_id: turnId };
    this.deps.approvalRuntime?.cancelBySource(source);
    this.deps.orchestrator?.discardStreaming?.('aborted');
    await this.deps.lifecycle.cancelTurn(turnId);
    // Clear the post-abort prefetch stash so repeated cancels (or
    // abort-heavy workloads) don't leak memory. No-op when the
    // orchestrator is absent or the stash is already empty.
    this.deps.orchestrator?.drainPrefetched?.();
  }

  // ── Conversation-channel handlers ───────────────────────────────────

  async handlePrompt(req: { data: { input: UserInput } }): Promise<DispatchResponse> {
    // Slice 3 audit C1: busy-check must cover BOTH the lifecycle state
    // and the synchronous reservation slot (reservation covers the await
    // window between allocateTurnId and registerTurn where the tracker
    // still reports "no current turn").
    if (
      !this.deps.lifecycleStateMachine.isIdle() ||
      this.getCurrentTurnId() !== undefined
    ) {
      return { error: 'agent_busy' };
    }

    const input = req.data.input;

    // Phase 19 Slice B — capability gate. Reject before allocating a turn
    // or writing any WAL record so a mismatched prompt leaves no residue.
    // `getCapability` is optional on KosongAdapter; `undefined` means the
    // adapter does not expose a capability table (e.g. inline test mocks)
    // and we skip the check entirely (open-world, permissive).
    // `UNKNOWN_CAPABILITY` means the provider has a table but the active
    // model isn't catalogued (e.g. moonshot-v1-auto on the Kimi provider,
    // whose catalogue only covers kimi-for-coding / kimi-k2 / *thinking*).
    // Catalogue-miss ≠ "model rejects images"; treating UNKNOWN_CAPABILITY
    // as strict-deny would make the gate fire on every mainstream Moonshot
    // model with an image input. Collapse both cases to permissive-skip.
    const capability = this.deps.runtime.kosong.getCapability?.(this.deps.contextState.model);
    if (capability !== undefined && capability !== UNKNOWN_CAPABILITY) {
      let inputContainsImage = false;
      let inputContainsVideo = false;
      for (const part of input.parts ?? []) {
        if (part.type === 'image_url') inputContainsImage = true;
        else if (part.type === 'video_url') inputContainsVideo = true;
      }
      const mismatch = checkLLMCapabilities({
        model: this.deps.contextState.model,
        inputContainsImage,
        inputContainsVideo,
        inputContainsAudio: false,
        capability,
      });
      if (mismatch !== undefined) {
        throw mismatch;
      }
    }

    const turnId = this.deps.lifecycle.allocateTurnId();
    this.pendingLaunchTurnId = turnId;

    try {
      await this.deps.sessionJournal.appendTurnBegin({
        type: 'turn_begin',
        turn_id: turnId,
        agent_type: this.agentType,
        user_input: input.text,
        input_kind: 'user',
      });
      await this.deps.contextState.appendUserMessage(input, turnId);

      this.deps.lifecycleStateMachine.transitionTo('active');

      // Fire the `begin` lifecycle event BEFORE `launchTurn` kicks off
      // the Soul promise so subscribers translate it into a wire
      // `turn.begin` synchronously at the exact arm point.
      this.deps.lifecycle.fireLifecycleEvent({
        kind: 'begin',
        turnId,
        userInput: input.text,
        ...(input.parts !== undefined ? { userInputParts: input.parts } : {}),
        inputKind: 'user',
        agentType: this.agentType,
      });

      // Slice 3.6 — UserPromptSubmit lifecycle hook. Fire-and-forget.
      this.dispatchLifecycleHook({
        event: 'UserPromptSubmit',
        sessionId: this.sessionId,
        turnId,
        agentId: this.agentId,
        prompt: input.text,
      });

      const trigger: TurnTrigger = { kind: 'user_prompt', input };
      this.launchTurn(turnId, trigger);
      // Tracker now owns currentTurnId; release the synchronous
      // reservation slot.
      this.pendingLaunchTurnId = undefined;

      return { turn_id: turnId, status: 'started' };
    } catch (error) {
      // Rollback: release the reservation so the next handlePrompt can
      // proceed. WAL records are durable; replay handles half-written
      // turns.
      this.pendingLaunchTurnId = undefined;
      throw error;
    }
  }

  async handleCancel(req: { data: { turn_id?: string | undefined } }): Promise<DispatchResponse> {
    const requestedId = req.data.turn_id ?? this.deps.lifecycle.getCurrentTurnId();
    if (requestedId === undefined) {
      return { ok: true };
    }
    await this.abortTurn(requestedId, 'dispatch-cancel');
    return { ok: true };
  }

  async handleSteer(req: { data: { input: UserInput } }): Promise<DispatchResponse> {
    this.deps.contextState.pushSteer(req.data.input);
    return { ok: true };
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private drainDynamicInjectionsIntoContext(turnId: string): void {
    const manager = this.deps.dynamicInjectionManager;
    if (manager === undefined) return;
    const ctx: InjectionContext = {
      planMode: this.planMode,
      permissionMode: this.permissionMode,
      turnNumber: this.extractTurnNumber(turnId),
      history: this.deps.contextState.getHistory(),
    };
    manager.computeInjections(ctx, this.deps.contextState);
  }

  private extractTurnNumber(turnId: string): number {
    const match = /^turn_(\d+)$/.exec(turnId);
    if (match === null) return 1;
    const parsed = Number.parseInt(match[1] ?? '1', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  /**
   * Fire-and-forget dispatch of a lifecycle hook event. Tool-scoped
   * events go through `ToolCallOrchestrator`; this helper only covers
   * the three lifecycle events TurnManager owns
   * (`UserPromptSubmit` / `Stop`).
   */
  private dispatchLifecycleHook(input: UserPromptSubmitInput | StopInput): void {
    const engine = this.deps.hookEngine;
    if (engine === undefined) return;
    const controller = new AbortController();
    engine.executeHooks(input.event, input, controller.signal).catch(() => {
      // swallow — lifecycle hooks are fire-and-forget
    });
  }

  private launchTurn(turnId: string, trigger: TurnTrigger): string {
    const handle = this.deps.soulRegistry.getOrCreate('main');
    const controller = handle.abortController;

    const wrappedTools =
      this.deps.orchestrator !== undefined
        ? this.deps.orchestrator.wrapTools(this.deps.tools)
        : [...this.deps.tools];

    // Compute the effective rule set and drain the pending override slot
    // atomically (Q6 regression) — the closure below captures
    // `effectiveRules` by value.
    const effectiveRules = this.deps.permissionBuilder.computeTurnRules(
      this.sessionRules,
      this.pendingTurnOverrides,
    );
    this.pendingTurnOverrides = undefined;

    const approvalSource: ApprovalSource =
      this.agentType === 'sub'
        ? {
            kind: 'subagent',
            agent_id: this.agentId,
            ...(this.subagentType !== undefined ? { subagent_type: this.subagentType } : {}),
          }
        : { kind: 'soul', agent_id: this.agentId };

    // Slice 5 — name → wrapped-tool lookup so the orchestrator's
    // afterToolCall budget seam can resolve `Tool.maxResultSizeChars`
    // and `Tool.display` on the fly. We index the wrapped tools (not
    // raw `this.deps.tools`) because Soul invokes the wrappers; the
    // wrapper preserves the Phase 5 optional fields verbatim.
    const toolsByName: ReadonlyMap<string, Tool> = new Map(
      wrappedTools.map((t) => [t.name, t]),
    );

    const closureContext: PermissionClosureContext = {
      turnId,
      permissionRules: effectiveRules,
      permissionMode: this.permissionMode,
      approvalSource,
      toolsByName,
    };

    const soulConfig: SoulConfig = {
      tools: wrappedTools,
      beforeToolCall: this.deps.permissionBuilder.buildBeforeToolCall(closureContext),
      afterToolCall: this.deps.permissionBuilder.buildAfterToolCall(closureContext),
      ...(this.deps.compactionConfig !== undefined
        ? {
            compactionConfig: this.deps.compactionConfig,
            // Slice 5 / 决策 #96 L3 — `maxContextSize` and the silent-
            // overflow `contextWindow` are the same physical value;
            // forward it so KosongAdapter can detect overflows the
            // shouldCompact gate didn't anticipate.
            contextWindow: this.deps.compactionConfig.maxContextSize,
          }
        : {}),
    };

    const input = trigger.input;
    const runPromise = this.runTurn(turnId, input, soulConfig, controller.signal);
    runPromise.catch(() => {
      // Terminal rejection containment — §5.9 / D17 fire-and-forget
      // safety net. `onTurnEnd` is responsible for state cleanup.
    });
    this.deps.lifecycle.registerTurn(turnId, controller, runPromise);
    return turnId;
  }

  private async runTurn(
    turnId: string,
    input: UserInput,
    soulConfig: SoulConfig,
    signal: AbortSignal,
  ): Promise<TurnResult | undefined> {
    // Phase 1 (Decision #89): compute dynamic injections (plan mode /
    // yolo mode / host-supplied providers) and write them durably via
    // ContextState.appendSystemReminder. The `await` on a void return
    // is intentional — DynamicInjectionManager.computeInjections is
    // sync, but providers internally fire-and-forget
    // `appendSystemReminder` promises; the microtask yield introduced
    // by the await lets those writes progress past their first `await`
    // (journalWriter.append) + history.push before `runSoulTurn`'s
    // first `buildMessages()` call.
    await this.drainDynamicInjectionsIntoContext(turnId);

    let result: TurnResult | undefined;
    let reason: 'done' | 'cancelled' | 'error';
    try {
      // Phase 2 (todo Step 7): needs_compaction loop. Soul reports
      // `stopReason='needs_compaction'` when the shouldCompact gate
      // fires; TurnManager drives the CompactionOrchestrator and
      // re-enters Soul on the same turn_id. Bounded by
      // MAX_COMPACTIONS_PER_TURN so a misbehaving provider cannot lock
      // the session.
      let compactionCount = 0;
      while (true) {
        signal.throwIfAborted();
        let soulResult: TurnResult;
        try {
          soulResult = await runSoulTurn(
            input,
            soulConfig,
            this.deps.contextState,
            this.deps.runtime,
            this.deps.sink,
            signal,
          );
        } catch (error) {
          // Slice 5 / 决策 #96 L3 — reactive overflow recovery shares the
          // MAX_COMPACTIONS_PER_TURN budget with the needs_compaction
          // branch. ContextOverflowError → compactionCount++ → either
          // trip the breaker or executeCompaction + retry.
          if (error instanceof ContextOverflowError) {
            compactionCount += 1;
            if (compactionCount > MAX_COMPACTIONS_PER_TURN) {
              this.deps.sink.emit({
                type: 'session.error',
                error: `Compaction limit exceeded (${MAX_COMPACTIONS_PER_TURN})`,
                error_type: 'context_overflow',
              });
              result = { stopReason: 'error', steps: 0, usage: zeroUsage() };
              break;
            }
            await this.deps.compaction.executeCompaction(signal);
            continue;
          }
          throw error;
        }
        if (soulResult.stopReason !== 'needs_compaction') {
          result = soulResult;
          break;
        }
        compactionCount += 1;
        if (compactionCount > MAX_COMPACTIONS_PER_TURN) {
          this.deps.sink.emit({
            type: 'session.error',
            error: `Compaction limit exceeded (${MAX_COMPACTIONS_PER_TURN})`,
            error_type: 'context_overflow',
          });
          result = {
            stopReason: 'error',
            steps: soulResult.steps,
            usage: soulResult.usage,
          };
          break;
        }
        await this.deps.compaction.executeCompaction(signal);
      }
      reason = result !== undefined && result.stopReason === 'aborted' ? 'cancelled' : 'done';
      if (result !== undefined && result.stopReason === 'error') {
        reason = 'error';
      }
    } catch (error) {
      void error;
      result = undefined;
      reason = 'error';
    }

    await this.onTurnEnd(turnId, result, reason);
    return result;
  }

  private async onTurnEnd(
    turnId: string,
    result: TurnResult | undefined,
    reason: 'done' | 'cancelled' | 'error',
  ): Promise<void> {
    // Phase 18 A.13 — record the terminal reason BEFORE any awaits so
    // `getTerminalReason(turnId)` is reliable even when the caller
    // only observes `awaitTurn` (which returns `undefined` for the
    // error path).
    this.terminalReasons.set(turnId, reason);
    const machine = this.deps.lifecycleStateMachine;

    try {
      if (machine.isCompacting()) {
        machine.transitionTo('active');
      }

      const turnEnd: Parameters<SessionJournal['appendTurnEnd']>[0] = {
        type: 'turn_end',
        turn_id: turnId,
        agent_type: this.agentType,
        success: reason === 'done',
        reason,
      };
      if (result !== undefined) {
        turnEnd.usage = {
          input_tokens: result.usage.input,
          output_tokens: result.usage.output,
          ...(result.usage.cache_read !== undefined
            ? { cache_read_tokens: result.usage.cache_read }
            : {}),
          ...(result.usage.cache_write !== undefined
            ? { cache_write_tokens: result.usage.cache_write }
            : {}),
        };
      }
      await this.deps.sessionJournal.appendTurnEnd(turnEnd);

      this.dispatchLifecycleHook({
        event: 'Stop',
        sessionId: this.sessionId,
        turnId,
        agentId: this.agentId,
        reason,
      });
    } finally {
      // 3-hop drain: active → completing → idle.
      if (machine.isActive()) {
        machine.transitionTo('completing');
      }
      if (machine.isCompleting()) {
        machine.transitionTo('idle');
      }

      this.deps.soulRegistry.destroy('main');

      this.deps.lifecycle.completeTurn(turnId);

      // Phase 17 §A.2 / Phase 18 A.14 — status.update full snapshot is
      // emitted AFTER the `turn.end` sink emit below (not here). The
      // emit uses `emitStatusUpdate`, which composes context_usage /
      // token_usage / plan_mode / model into one frame — strictly
      // richer than a usage-only snapshot.

      // Fire the `end` lifecycle event LAST so listeners observing this
      // edge are guaranteed the machine is back at `idle` and
      // currentTurnId is cleared — back-to-back prompts see
      // `end#N` strictly before `begin#N+1`.
      this.deps.lifecycle.fireLifecycleEvent({
        kind: 'end',
        turnId,
        reason,
        success: reason === 'done',
        agentType: this.agentType,
        usage: result?.usage,
      });

      // Phase 16 / 决策 #113 — SessionMetaService counts each turn through
      // this sink emit to derive `turn_count`. Consumers that already see
      // the lifecycle event above ignore this one; it exists because
      // derived-field listeners (like sessionMeta) are wired to the
      // SessionEventBus, not to the lifecycle tracker.
      this.deps.sink.emit({ type: 'turn.end' });

      // Phase 17 A.2 / Phase 18 A.14 — status.update snapshot. Emitted
      // AFTER the `turn.end` sink emit so derived-field listeners have
      // already applied their updates (SessionMetaService). The event
      // is transient (§3.7 不落盘), so downstream observers MUST NOT
      // persist it to wire.jsonl — enforced by the wire journal writer.
      const turnUsage = result?.usage;
      this.emitStatusUpdate(
        turnUsage !== undefined
          ? { input: turnUsage.input, output: turnUsage.output }
          : { input: 0, output: 0 },
      );
    }
  }

  // ── Phase 17 A.2 / Phase 18 A.14 — status.update emit ───────────────

  /**
   * Emit a `status.update` SoulEvent with the current context / token /
   * plan_mode / model snapshot. Called from `onTurnEnd` (periodic) and
   * from config setters (`setPlanMode` / `SoulPlus.setModel`).
   *
   * `context_usage.percent` is always 0-100 (integer). Total defaults
   * to `compactionConfig.maxContextSize` when set, or a 200k baseline
   * otherwise so callers do not receive `percent: NaN` when no config
   * is wired (test harnesses).
   */
  emitStatusUpdate(tokenUsage: { input: number; output: number }): void {
    const used = this.deps.contextState.tokenCountWithPending;
    const total = this.deps.compactionConfig?.maxContextSize ?? DEFAULT_CONTEXT_WINDOW;
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;
    this.deps.sink.emit({
      type: 'status.update',
      data: {
        context_usage: { used, total, percent },
        token_usage: tokenUsage,
        plan_mode: this.planMode,
        model: this.deps.contextState.model,
      },
    });
  }
}
