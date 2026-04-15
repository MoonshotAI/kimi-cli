/**
 * TurnManager — the SoulPlus conversation engine (v2 §5.2.2).
 *
 * Slice 3 responsibilities:
 *   - `handlePrompt(req)` — accept a user prompt, return immediately with
 *     `{turn_id, status:'started'}` (non-blocking), and fire-and-forget
 *     the underlying Soul turn via `runSoulTurn`.
 *   - `handleCancel(req)` — synchronously abort the targeted turn's
 *     `AbortController`.
 *   - `handleSteer(req)` — push the steer input into the context's steer
 *     buffer so the running Soul drains it at the next step boundary.
 *   - `onTurnEnd(turnId, result)` — bookkeeping after a Soul turn
 *     settles: write the `turn_end` journal record, transition lifecycle
 *     back through `completing → idle`, clear per-turn state.
 *   - `buildBeforeToolCall()` / `buildAfterToolCall()` — Slice 3 returns
 *     always-allow closures. Slice 4 will plug in the real permission /
 *     hook orchestration.
 *
 * What TurnManager does NOT do in Slice 3 (explicit non-scope):
 *   - No skill detection (Slice 9A).
 *   - No permission rule engine; no approval forwarding (Slice 4).
 *   - No hook engine invocation (Slice 4).
 *   - No compaction trigger (Slice 6).
 *   - No subagent spawn (Slice 7).
 *   - No notification queue flushing (Slice 8).
 *
 * Vocabulary note: `buildBeforeToolCall` / `buildAfterToolCall` return
 * opaque async closures. Slice 3 produces no-op closures — Soul treats
 * them as always-allow. The helpers intentionally avoid any permission
 * vocabulary so the `src/soul/` layer stays clean (铁律 2).
 */

import { runSoulTurn } from '../soul/index.js';
import type {
  AfterToolCallHook,
  BeforeToolCallHook,
  EventSink,
  Runtime,
  SoulConfig,
  Tool,
  TurnResult,
} from '../soul/index.js';
import type { FullContextState, UserInput } from '../storage/context-state.js';
import type { SessionJournal } from '../storage/session-journal.js';
import type { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';
import type { ToolCallOrchestrator } from './orchestrator.js';
import type { SoulRegistry } from './soul-registry.js';
import type { DispatchResponse, TurnTrigger } from './types.js';

export interface TurnManagerDeps {
  readonly contextState: FullContextState;
  readonly sessionJournal: SessionJournal;
  readonly runtime: Runtime;
  readonly sink: EventSink;
  readonly lifecycleStateMachine: SessionLifecycleStateMachine;
  readonly soulRegistry: SoulRegistry;
  readonly tools: readonly Tool[];
  readonly agentType?: 'main' | 'sub' | 'independent' | undefined;
  readonly orchestrator?: ToolCallOrchestrator | undefined;
}

export interface TurnState {
  readonly turnId: string;
  readonly controller: AbortController;
  readonly promise: Promise<TurnResult | undefined>;
}

export class TurnManager {
  private readonly deps: TurnManagerDeps;
  private readonly agentType: 'main' | 'sub' | 'independent';
  private readonly turnPromises = new Map<string, Promise<TurnResult | undefined>>();
  private readonly turnStates = new Map<string, TurnState>();
  private currentTurnId: string | undefined;
  private turnIdCounter = 0;

  constructor(deps: TurnManagerDeps) {
    this.deps = deps;
    this.agentType = deps.agentType ?? 'main';
  }

  // ── Conversation-channel handlers ────────────────────────────────────

  async handlePrompt(req: { data: { input: UserInput } }): Promise<DispatchResponse> {
    if (!this.deps.lifecycleStateMachine.isIdle()) {
      return { error: 'agent_busy' };
    }

    const input = req.data.input;
    const turnId = this.allocateTurnId();

    // Order (v2 §5.2.2 L2001+): persist turn_begin and user_message while
    // the lifecycle is still `idle` (gate allows), then transition to
    // `active`, then fire-and-forget the Soul turn. Writing while idle
    // keeps crash recovery sane — a crash between the two appends and the
    // transition leaves state_machine=idle with a partial journal, which
    // replay can close out cleanly. All awaits here are WAL fsync level,
    // so handlePrompt still returns in milliseconds against a slow LLM.
    await this.deps.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: turnId,
      agent_type: this.agentType,
      user_input: input.text,
      input_kind: 'user',
    });

    await this.deps.contextState.appendUserMessage(input);

    this.deps.lifecycleStateMachine.transitionTo('active');

    const trigger: TurnTrigger = { kind: 'user_prompt', input };
    const allocatedId = this.launchTurn(turnId, trigger);

    return { turn_id: allocatedId, status: 'started' };
  }

  async handleCancel(req: { data: { turn_id?: string | undefined } }): Promise<DispatchResponse> {
    const requestedId = req.data.turn_id ?? this.currentTurnId;
    if (requestedId === undefined) {
      return { ok: true };
    }
    const state = this.turnStates.get(requestedId);
    if (state === undefined) {
      return { ok: true };
    }
    state.controller.abort();
    return { ok: true };
  }

  async handleSteer(req: { data: { input: UserInput } }): Promise<DispatchResponse> {
    this.deps.contextState.pushSteer(req.data.input);
    return { ok: true };
  }

  // ── Internal helpers ────────────────────────────────────────────────

  async awaitTurn(turnId: string): Promise<TurnResult | undefined> {
    const existing = this.turnPromises.get(turnId);
    if (existing === undefined) return undefined;
    return existing;
  }

  private buildBeforeToolCall(): BeforeToolCallHook {
    if (this.deps.orchestrator !== undefined) {
      return this.deps.orchestrator.buildBeforeToolCall({
        turnId: this.currentTurnId ?? 'unknown',
      });
    }
    // oxlint-disable-next-line unicorn/no-useless-undefined
    return async () => undefined;
  }

  private buildAfterToolCall(): AfterToolCallHook {
    if (this.deps.orchestrator !== undefined) {
      return this.deps.orchestrator.buildAfterToolCall({
        turnId: this.currentTurnId ?? 'unknown',
      });
    }
    // oxlint-disable-next-line unicorn/no-useless-undefined
    return async () => undefined;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private allocateTurnId(): string {
    this.turnIdCounter += 1;
    return `turn_${this.turnIdCounter}`;
  }

  /**
   * Internal entry point for launching a Soul turn. Currently only
   * `handlePrompt` calls this; Slice 7 (auto-wake) and Slice 8 (system
   * triggers) will add alternative callers that also need to write
   * `turn_begin` + `user_message` before invoking `launchTurn`.
   * Intentionally `private` so external code cannot skip the write-ahead
   * log on its way into Soul — that would leave replay with dangling
   * `assistant_message` / `tool_result` records and no `turn_begin`.
   */
  private launchTurn(turnId: string, trigger: TurnTrigger): string {
    // Each turn gets a fresh SoulHandle. `onTurnEnd` destroys the prior
    // handle so by the time we land here the registry has no `main`
    // entry; `getOrCreate` returns a brand-new handle with a fresh
    // AbortController for this turn.
    const handle = this.deps.soulRegistry.getOrCreate('main');
    const controller = handle.abortController;

    const soulConfig: SoulConfig = {
      tools: [...this.deps.tools],
      beforeToolCall: this.buildBeforeToolCall(),
      afterToolCall: this.buildAfterToolCall(),
    };

    const input = trigger.input;
    const promise = this.runTurn(turnId, input, soulConfig, controller.signal);
    this.turnStates.set(turnId, { turnId, controller, promise });
    this.turnPromises.set(turnId, promise);
    this.currentTurnId = turnId;
    return turnId;
  }

  private async runTurn(
    turnId: string,
    input: UserInput,
    soulConfig: SoulConfig,
    signal: AbortSignal,
  ): Promise<TurnResult | undefined> {
    try {
      const result = await runSoulTurn(
        input,
        soulConfig,
        this.deps.contextState,
        this.deps.runtime,
        this.deps.sink,
        signal,
      );
      const reason: 'done' | 'cancelled' = result.stopReason === 'aborted' ? 'cancelled' : 'done';
      await this.onTurnEnd(turnId, result, reason);
      return result;
    } catch (error) {
      // `MaxStepsExceededError` and any non-abort error from runSoulTurn
      // both land here. Soul catches abort internally and returns a
      // `TurnResult` with `stopReason:'aborted'`, so control only reaches
      // this branch for true failure paths. Soul already emitted a
      // `step.interrupted` event for its own observability; TurnManager's
      // job is to persist a `turn_end{reason:'error'}` record so the wire
      // transcript stays balanced. The error message itself is currently
      // dropped — richer error telemetry is a Slice 4 follow-up (§8).
      void error;
      await this.onTurnEnd(turnId, undefined, 'error');
      return undefined;
    }
  }

  private async onTurnEnd(
    turnId: string,
    result: TurnResult | undefined,
    reason: 'done' | 'cancelled' | 'error',
  ): Promise<void> {
    const machine = this.deps.lifecycleStateMachine;
    // If Soul left the machine in `compacting` (Slice 6 path), fan back
    // to `active` first so the turn_end append is gated as a normal
    // active-state write rather than a compacting-state write. Slice 3
    // never enters this branch; it exists so Slice 6 compaction can rely
    // on the same onTurnEnd path.
    if (machine.isCompacting()) {
      machine.transitionTo('active');
    }

    // Write turn_end while the machine is still `active`. WiredJournalWriter
    // gates on `completing` / `compacting`, so the 3-hop drain below must
    // happen AFTER the WAL append. (Round 2 M1 fix.)
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

    // 3-hop drain: active → completing → idle. The `completing` marker
    // is transient — writing ends before entering it, and the next
    // turn's handlePrompt checks `isIdle()` only after `idle` is reached.
    if (machine.isActive()) {
      machine.transitionTo('completing');
    }
    if (machine.isCompleting()) {
      machine.transitionTo('idle');
    }

    // Release the per-turn SoulHandle so the next `launchTurn` gets a
    // fresh AbortController from the registry. Moving the destroy here
    // (rather than defensively at the top of `launchTurn`) removes the
    // risk of aborting a handle that a Slice 7 subagent still holds for
    // delayed cleanup.
    this.deps.soulRegistry.destroy('main');

    if (this.currentTurnId === turnId) {
      this.currentTurnId = undefined;
    }
    this.turnStates.delete(turnId);
    // Keep the turn promise in the map so `awaitTurn(turnId)` called
    // after settlement still returns the settled promise.
  }
}
