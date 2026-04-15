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
    // Slice 3 audit C1: busy-check must cover BOTH the lifecycle state and
    // the synchronously-held `currentTurnId` slot. Using only `isIdle()`
    // would leave a re-entrancy window between the first `await` in this
    // function and the `transitionTo('active')` call further down, during
    // which a second concurrent `handlePrompt` would also pass the guard
    // and write a ghost `turn_begin` / `user_message` pair.
    if (!this.deps.lifecycleStateMachine.isIdle() || this.currentTurnId !== undefined) {
      return { error: 'agent_busy' };
    }

    const input = req.data.input;
    const turnId = this.allocateTurnId();

    // Slice 3 audit C1 — atomic synchronous reservation. We set
    // `currentTurnId` BEFORE any `await` so the busy-check above rejects a
    // concurrent second prompt immediately. This is the TS equivalent of
    // Python `run_soul`'s single-flight task slot (v2 §5.2.2 L2001+).
    this.currentTurnId = turnId;

    try {
      // Order (v2 §5.2.2 L2001+): persist turn_begin and user_message
      // while the lifecycle is still `idle` (gate allows), then transition
      // to `active`, then fire-and-forget the Soul turn. Writing while
      // idle keeps crash recovery sane — a crash between the two appends
      // and the transition leaves state_machine=idle with a partial
      // journal, which replay can close out cleanly. All awaits here are
      // WAL fsync level, so handlePrompt still returns in milliseconds
      // against a slow LLM.
      await this.deps.sessionJournal.appendTurnBegin({
        type: 'turn_begin',
        turn_id: turnId,
        agent_type: this.agentType,
        user_input: input.text,
        input_kind: 'user',
      });

      // Slice 3 audit C1: thread the freshly allocated `turnId` explicitly
      // instead of relying on the `currentTurnId()` callback inside
      // `WiredContextState`. Even though we already set `this.currentTurnId`
      // synchronously above, the Slice 1 `currentTurnId` callback was
      // designed for Soul's mid-turn writes (steer drain, assistant
      // message, tool result), not for the very-first `user_message` of a
      // new turn — the explicit parameter is the defensive contract.
      await this.deps.contextState.appendUserMessage(input, turnId);

      this.deps.lifecycleStateMachine.transitionTo('active');

      const trigger: TurnTrigger = { kind: 'user_prompt', input };
      const allocatedId = this.launchTurn(turnId, trigger);

      return { turn_id: allocatedId, status: 'started' };
    } catch (error) {
      // Slice 3 audit C1 — rollback: any await in this reservation block
      // that rejects must release the `currentTurnId` slot so the next
      // `handlePrompt` can proceed. We only touch `currentTurnId` here —
      // we do NOT attempt to walk back the WAL records (journal appends
      // are durable; replay is responsible for closing half-written
      // turns).
      if (this.currentTurnId === turnId) {
        this.currentTurnId = undefined;
      }
      throw error;
    }
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

    // Slice 3 audit M1 — cancel contract: wait for the in-flight turn to
    // fully drain (WAL `turn_end` written, lifecycle transitioned back to
    // `idle`, soul registry `destroy`d, `currentTurnId` cleared) before
    // returning. This matches v2 §5.9.2 L2006-2014 + D17 L2752-2764 and
    // Python `soul/__init__.py:205-211` (`cancel(); await soul_task`). A
    // caller that observes `handleCancel` returning is now guaranteed it
    // can start a fresh `handlePrompt` immediately.
    //
    // We swallow any rejection from the turn promise because `launchTurn`
    // already attached a terminal `.catch` (M2), and the cancel semantics
    // do not care about the underlying reason — the caller only wants to
    // know the turn is done.
    const turnPromise = this.turnPromises.get(requestedId);
    if (turnPromise !== undefined) {
      try {
        await turnPromise;
      } catch {
        // swallow — cancel does not surface turn errors
      }
    }

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

    // Slice 4 M5 — orchestrator wraps tools to track execute throws vs.
    // normal isError returns, so OnToolFailure fires only on real throws.
    const wrappedTools =
      this.deps.orchestrator !== undefined
        ? this.deps.orchestrator.wrapTools(this.deps.tools)
        : [...this.deps.tools];

    const soulConfig: SoulConfig = {
      tools: wrappedTools,
      beforeToolCall: this.buildBeforeToolCall(),
      afterToolCall: this.buildAfterToolCall(),
    };

    const input = trigger.input;
    // Slice 3 audit M2 — the `runTurn` call is fire-and-forget: nobody
    // upstream awaits this promise synchronously (handlePrompt returns
    // `{turn_id, status:'started'}` immediately). If `onTurnEnd`'s
    // `appendTurnEnd` rejects and the promise escapes unhandled, Node
    // strict-unhandled-rejection mode would crash the process.
    //
    // We attach a terminal `.catch` that swallows the rejection for the
    // fire-and-forget path. Callers that actively observe the promise
    // (tests via `awaitTurn`, M1's `handleCancel`) still see the raw
    // promise from `runTurn` — we keep that reference alive in the map
    // so `await turnPromises.get(turnId)` resolves with the same outcome
    // the original `runTurn` had, while the `.catch`ed branch contains
    // the rejection locally.
    const runPromise = this.runTurn(turnId, input, soulConfig, controller.signal);
    runPromise.catch(() => {
      // Terminal rejection containment — §5.9 / D17 fire-and-forget
      // safety net. `onTurnEnd` is responsible for state cleanup (see
      // its try/finally); this catch only exists so unhandled rejection
      // doesn't reach Node's process level.
    });
    this.turnStates.set(turnId, { turnId, controller, promise: runPromise });
    this.turnPromises.set(turnId, runPromise);
    // C1 note: `currentTurnId` is already set synchronously by
    // `handlePrompt` BEFORE any await; we intentionally do NOT overwrite
    // it here (the old code did `this.currentTurnId = turnId` at this
    // point, which was a no-op once C1's atomic reservation landed).
    return turnId;
  }

  private async runTurn(
    turnId: string,
    input: UserInput,
    soulConfig: SoulConfig,
    signal: AbortSignal,
  ): Promise<TurnResult | undefined> {
    let result: TurnResult | undefined;
    let reason: 'done' | 'cancelled' | 'error';
    try {
      result = await runSoulTurn(
        input,
        soulConfig,
        this.deps.contextState,
        this.deps.runtime,
        this.deps.sink,
        signal,
      );
      reason = result.stopReason === 'aborted' ? 'cancelled' : 'done';
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
      result = undefined;
      reason = 'error';
    }

    // Slice 3 audit M2 — `onTurnEnd` is called exactly once per turn
    // regardless of how the Soul branch settled. Routing the success and
    // error paths through a single `onTurnEnd` call prevents the
    // double-write failure mode that the prior structure (separate
    // `onTurnEnd` inside try and catch) would trip when the first
    // `onTurnEnd` itself rejected.
    await this.onTurnEnd(turnId, result, reason);
    return result;
  }

  private async onTurnEnd(
    turnId: string,
    result: TurnResult | undefined,
    reason: 'done' | 'cancelled' | 'error',
  ): Promise<void> {
    const machine = this.deps.lifecycleStateMachine;

    // Slice 3 audit M2 — cleanup must run regardless of whether the
    // `appendTurnEnd` WAL write (or any lifecycle transition below)
    // rejects. Before the fix, an IO failure here left
    // `currentTurnId` / `turnStates` / the SoulHandle registry stuck in
    // their in-turn state and the session could not accept a new prompt.
    // The try/finally keeps the "session can move forward" guarantee
    // independent of WAL durability outcomes.
    try {
      // If Soul left the machine in `compacting` (Slice 6 path), fan
      // back to `active` first so the turn_end append is gated as a
      // normal active-state write rather than a compacting-state write.
      // Slice 3 never enters this branch; it exists so Slice 6
      // compaction can rely on the same onTurnEnd path.
      if (machine.isCompacting()) {
        machine.transitionTo('active');
      }

      // Write turn_end while the machine is still `active`.
      // WiredJournalWriter gates on `completing` / `compacting`, so the
      // 3-hop drain below must happen AFTER the WAL append. (Round 2 M1
      // fix.)
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
    } finally {
      // 3-hop drain: active → completing → idle. The `completing`
      // marker is transient — writing ends before entering it, and the
      // next turn's handlePrompt checks `isIdle()` only after `idle` is
      // reached. Slice 3 audit M2: run the drain in `finally` so that
      // even if `appendTurnEnd` rejected, the lifecycle still returns
      // to `idle` instead of getting stuck in `active`. These
      // transitions are synchronous and will not throw (they only
      // validate the transition matrix).
      if (machine.isActive()) {
        machine.transitionTo('completing');
      }
      if (machine.isCompleting()) {
        machine.transitionTo('idle');
      }

      // Release the per-turn SoulHandle so the next `launchTurn` gets a
      // fresh AbortController from the registry. Moving the destroy
      // here (rather than defensively at the top of `launchTurn`)
      // removes the risk of aborting a handle that a Slice 7 subagent
      // still holds for delayed cleanup.
      this.deps.soulRegistry.destroy('main');

      if (this.currentTurnId === turnId) {
        this.currentTurnId = undefined;
      }
      this.turnStates.delete(turnId);
      // Keep the turn promise in the map so `awaitTurn(turnId)` called
      // after settlement still returns the settled promise.
    }
  }
}
