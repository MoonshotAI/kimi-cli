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
 *   - Slice 2.4 adds `pendingNotifications` ingress +
 *     `drainPendingNotificationsIntoContext` called at `launchTurn`
 *     to flush NotificationManager-fed injections into ContextState.
 *
 * Vocabulary note: `buildBeforeToolCall` / `buildAfterToolCall` return
 * opaque async closures. Slice 3 produces no-op closures — Soul treats
 * them as always-allow. The helpers intentionally avoid any permission
 * vocabulary so the `src/soul/` layer stays clean (铁律 2).
 */

import type { HookEngine } from '../hooks/engine.js';
import type { StopInput, UserPromptSubmitInput } from '../hooks/types.js';
import { runCompaction, runSoulTurn } from '../soul/index.js';
import type {
  AfterToolCallHook,
  BeforeToolCallHook,
  CompactionConfig,
  EventSink,
  Runtime,
  SoulConfig,
  Tool,
  TurnResult,
} from '../soul/index.js';
import type { FullContextState, UserInput } from '../storage/context-state.js';
import type { SessionJournal } from '../storage/session-journal.js';
import type { ApprovalSource } from '../storage/wire-record.js';
import type { DynamicInjectionManager, InjectionContext } from './dynamic-injection.js';
import type { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';
import type { NotificationData } from './notification-manager.js';
import type { ToolCallOrchestrator } from './orchestrator.js';
import type { PermissionMode, PermissionRule } from './permission/index.js';
import type { SoulRegistry } from './soul-registry.js';
import type { DispatchResponse, TurnTrigger } from './types.js';

/**
 * Per-turn permission overrides (v2 §9-E.6 — "FullTurnOverrides").
 * Expressed in tool-name terms and converted to `turn-override` scope
 * PermissionRule entries at `launchTurn` time. Drained after each
 * `launchTurn` so the next turn starts from a clean slate (Q6
 * regression guarantee).
 */
export interface TurnPermissionOverrides {
  /** Tools that are explicitly allowed this turn (implicit allow rules). */
  readonly activeTools?: readonly string[] | undefined;
  /** Tools that are explicitly denied this turn (implicit deny rules). */
  readonly disallowedTools?: readonly string[] | undefined;
}

export interface TurnManagerDeps {
  readonly contextState: FullContextState;
  readonly sessionJournal: SessionJournal;
  readonly runtime: Runtime;
  readonly sink: EventSink;
  readonly lifecycleStateMachine: SessionLifecycleStateMachine;
  readonly soulRegistry: SoulRegistry;
  readonly tools: readonly Tool[];
  readonly agentType?: 'main' | 'sub' | 'independent' | undefined;
  /**
   * Canonical agent id for this TurnManager. Used as `approvalSource.agent_id`
   * for every outbound ApprovalRequest so `cancelBySource({kind:'soul' |
   * 'subagent', agent_id})` can precisely match pending approvals.
   * Slice 2.3 drops the hardcoded `'agent_main'` placeholder
   * (Slice 2.2 reviewer N1). Defaults to `'agent_main'` for the main
   * Soul and the raw subagent handle id for subagents.
   */
  readonly agentId?: string | undefined;
  readonly orchestrator?: ToolCallOrchestrator | undefined;
  /**
   * Static (session-long) permission rules. Project / user scope rules
   * loaded at SoulPlus startup land here. Default: empty array.
   */
  readonly sessionRules?: readonly PermissionRule[] | undefined;
  /** Default permission mode. Default: `'default'`. */
  readonly permissionMode?: PermissionMode | undefined;
  /**
   * Compaction configuration (Slice 3.3 / M05). When set, the Soul
   * while-loop checks `shouldCompact()` at every step boundary and
   * auto-triggers compaction when token pressure crosses the threshold.
   * When `undefined`, auto-compaction is disabled (safe default for
   * embedded / test scenarios that don't configure a model's context
   * window size).
   */
  readonly compactionConfig?: CompactionConfig | undefined;
  /**
   * Slice 3.6 — Dynamic injection manager. When set, `launchTurn`
   * computes active injections (plan mode reminder / yolo mode
   * reminder / host-supplied providers) and stashes them into
   * ContextState so the next `buildMessages()` call surfaces them as
   * `<system-reminder>` blocks. When `undefined`, no dynamic
   * injections fire (embed / test default).
   */
  readonly dynamicInjectionManager?: DynamicInjectionManager | undefined;
  /**
   * Slice 3.6 — Optional hook engine reference. When set, TurnManager
   * dispatches lifecycle hook events (`UserPromptSubmit` / `Stop`) at
   * their trigger sites. Tool-scoped hook events
   * (`PreToolUse` / `PostToolUse` / `OnToolFailure`) are still owned
   * by the ToolCallOrchestrator; this reference only covers events
   * that the orchestrator does not see.
   */
  readonly hookEngine?: HookEngine | undefined;
  /**
   * Slice 3.6 — Session id forwarded into every lifecycle hook input
   * payload. Defaults to `'unknown'` if absent (test scenarios).
   */
  readonly sessionId?: string | undefined;
  /**
   * Slice 3.6 — Initial plan-mode flag. `setPlanMode` updates this at
   * runtime; DynamicInjectionManager reads it when building the
   * per-turn injection context. Default: `false`.
   */
  readonly planMode?: boolean | undefined;
}

export interface TurnState {
  readonly turnId: string;
  readonly controller: AbortController;
  readonly promise: Promise<TurnResult | undefined>;
}

export class TurnManager {
  private readonly deps: TurnManagerDeps;
  private readonly agentType: 'main' | 'sub' | 'independent';
  private readonly agentId: string;
  private readonly turnPromises = new Map<string, Promise<TurnResult | undefined>>();
  private readonly turnStates = new Map<string, TurnState>();
  private currentTurnId: string | undefined;
  private turnIdCounter = 0;
  /**
   * Session-wide static rules. Slice 2.3 made this mutable so a
   * `WiredApprovalRuntime` rule injector can append `session-runtime`
   * scope rules learned via approve_for_session. `setPermissionMode`
   * still drives the top-level posture.
   */
  private readonly sessionRules: PermissionRule[];
  private permissionMode: PermissionMode;
  /**
   * Pending overrides for the *next* turn. Drained in `launchTurn`
   * immediately after closure construction so the subsequent turn
   * cannot observe a stale override (Q6 regression guarantee).
   */
  private pendingTurnOverrides: TurnPermissionOverrides | undefined;

  /**
   * Slice 2.4 — per-turn pending notification queue (v2 §5.2.2 L1985).
   * `NotificationManager.emit()` pushes into this via
   * `addPendingNotification`. The queue is drained as
   * `EphemeralInjection[]` by `drainPendingNotifications` and handed to
   * `ContextState.stashEphemeralInjection` BEFORE the next LLM step's
   * `buildMessages` call. Ownership lives on TurnManager rather than
   * ContextState because notifications are a SoulPlus concept
   * (NotificationManager is §5.2.4) and Soul / ContextState should not
   * know about notification lifecycle.
   */
  private pendingNotifications: NotificationData[] = [];

  /**
   * Slice 3.6 — live plan-mode flag. `SessionControl.setPlanMode` drives
   * this via `setPlanMode` below; `DynamicInjectionManager` reads it at
   * every `launchTurn` so plan-mode reminders appear on the very next
   * LLM step.
   */
  private planMode: boolean;

  /**
   * Slice 3.6 — monotonic turn counter. `allocateTurnId` generates
   * `turn_${n}` ids from the same counter; we also use it as the
   * `turnNumber` field on the DynamicInjectionManager context so
   * providers that throttle by turn count have a stable input.
   */
  private readonly sessionId: string;

  constructor(deps: TurnManagerDeps) {
    this.deps = deps;
    this.agentType = deps.agentType ?? 'main';
    this.agentId = deps.agentId ?? 'agent_main';
    this.sessionRules = [...(deps.sessionRules ?? [])];
    this.permissionMode = deps.permissionMode ?? 'default';
    this.planMode = deps.planMode ?? false;
    this.sessionId = deps.sessionId ?? 'unknown';
  }

  // ── Permission control surface (Slice 2.2) ──────────────────────────

  /**
   * Apply a new permission mode starting with the next tool call. The
   * mode is re-read every `launchTurn`, so callers can flip the mode
   * between turns without touching the in-flight closure.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  /**
   * Slice 3.6 — toggle plan mode. SessionControl.setPlanMode fan-outs to
   * this setter so the DynamicInjectionManager reads the same state the
   * journal records. The new flag takes effect on the next `launchTurn`
   * (mid-turn toggles do not retroactively mutate the current turn's
   * injection context — this matches Python parity).
   */
  setPlanMode(enabled: boolean): void {
    this.planMode = enabled;
  }

  getPlanMode(): boolean {
    return this.planMode;
  }

  /** Return this TurnManager's canonical agent id. */
  getAgentId(): string {
    return this.agentId;
  }

  /**
   * Return the active turn id, or `undefined` when no turn is in progress.
   * Used by SessionManager (Slice 3.4) to wire the `currentTurnId` callback
   * on WiredContextState — the callback must reflect TurnManager's live
   * turn state so that mid-turn WAL writes (assistant_message, tool_result)
   * carry the correct `turn_id`.
   */
  getCurrentTurnId(): string | undefined {
    return this.currentTurnId;
  }

  /**
   * Append a new session-scope permission rule (Slice 2.3 approve_for_session
   * rule injector). Rules appended here become part of the merged
   * snapshot consumed by the *next* `launchTurn`; the closure of any
   * in-flight turn is left untouched so mid-turn injection cannot
   * surprise Soul with a changed decision table.
   *
   * Safe to call from any thread: a single append is atomic in the
   * JavaScript single-threaded model, and downstream consumers only
   * read the list inside `launchTurn` which runs on the main event loop.
   */
  addSessionRule(rule: PermissionRule): void {
    this.sessionRules.push(rule);
  }

  /** Test / recovery helper — read-only view of session rules. */
  getSessionRules(): readonly PermissionRule[] {
    return this.sessionRules;
  }

  /**
   * Set pending FullTurnOverrides for the next `launchTurn`. Passing
   * `undefined` clears any previously-set override. The orchestrator
   * consumes and clears this slot at turn start, so it is physically
   * impossible for a subsequent turn to inherit stale overrides
   * without the caller setting them again.
   */
  setPendingTurnOverrides(overrides: TurnPermissionOverrides | undefined): void {
    this.pendingTurnOverrides = overrides;
  }

  getPendingTurnOverrides(): TurnPermissionOverrides | undefined {
    return this.pendingTurnOverrides;
  }

  // ── Notification queue (Slice 2.4) ──────────────────────────────────

  /**
   * Slice 2.4 — NotificationManager.emit() calls this synchronously as
   * part of the LLM-sink fan-out. The notification is buffered until
   * either:
   *   - the next LLM step within the current turn (if a turn is active)
   *     calls `stashPendingNotificationsForBuildMessages`, or
   *   - a brand-new turn launches (same drain path).
   *
   * No journal I/O happens here — the WAL append already occurred
   * inside `NotificationManager.emit()` before this method was called
   * (WAL-then-mirror, §4.5.6).
   */
  addPendingNotification(notif: NotificationData): void {
    this.pendingNotifications.push(notif);
  }

  /**
   * Drain the pending notification queue and stash each entry into
   * ContextState as a `pending_notification` ephemeral injection. Called
   * by `launchTurn` right before kicking off the Soul turn and can also
   * be called inline between steps if TurnManager later grows a
   * "mid-turn drain" hook.
   *
   * Idempotent-ish: after draining, the queue is empty, so a second
   * call with no new emits is a no-op. Order is preserved (FIFO).
   */
  drainPendingNotificationsIntoContext(): void {
    if (this.pendingNotifications.length === 0) return;
    const drained = this.pendingNotifications;
    this.pendingNotifications = [];
    for (const notif of drained) {
      // `stashEphemeralInjection` is a synchronous push — it is safe
      // to call from anywhere on the main event loop.
      this.deps.contextState.stashEphemeralInjection({
        kind: 'pending_notification',
        content: notif as unknown as Record<string, unknown>,
      });
    }
  }

  /**
   * Test / inspection helper — read-only view of the pending queue.
   * Production code must use `addPendingNotification` /
   * `drainPendingNotificationsIntoContext`.
   */
  getPendingNotifications(): readonly NotificationData[] {
    return this.pendingNotifications;
  }

  // ── Dynamic injection (Slice 3.6) ──────────────────────────────────

  /**
   * Compute the active set of DynamicInjection entries for the current
   * turn and stash each one into ContextState as a `system_reminder`
   * ephemeral. No-op if no DynamicInjectionManager was configured.
   *
   * Called by `launchTurn` immediately before the notification drain,
   * so the resulting `<system-reminder>` blocks land at the top of the
   * synthetic message pile surfaced to the next LLM step.
   */
  private drainDynamicInjectionsIntoContext(turnId: string): void {
    const manager = this.deps.dynamicInjectionManager;
    if (manager === undefined) return;
    const ctx: InjectionContext = {
      planMode: this.planMode,
      permissionMode: this.permissionMode,
      turnNumber: this.extractTurnNumber(turnId),
    };
    const injections = manager.computeInjections(ctx);
    for (const injection of injections) {
      this.deps.contextState.stashEphemeralInjection(injection);
    }
  }

  /**
   * Parse the `turn_N` id format produced by `allocateTurnId` back into
   * its integer counter, clamping to 1 on any unexpected shape. We
   * parse instead of storing a separate counter so crash-resume /
   * alternative turn-id allocators continue to work.
   */
  private extractTurnNumber(turnId: string): number {
    const match = /^turn_(\d+)$/.exec(turnId);
    if (match === null) return 1;
    const parsed = Number.parseInt(match[1] ?? '1', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  // ── Lifecycle hook dispatch (Slice 3.6) ────────────────────────────

  /**
   * Fire-and-forget dispatch of a lifecycle hook event. Tool-scoped
   * events (`PreToolUse` etc.) go through the ToolCallOrchestrator; this
   * helper only handles the three lifecycle events TurnManager owns
   * (`UserPromptSubmit` / `Stop`). NotificationManager owns
   * `Notification` dispatch directly.
   *
   * Errors are swallowed because lifecycle hooks are observational —
   * there is no `blockAction` semantics in Slice 3.6 for these events
   * (the Python port treats `Stop` / `UserPromptSubmit` as block-capable
   * but the TS port intentionally simplifies to fire-and-forget for now
   * so a slow hook cannot stall turn lifecycle).
   */
  private dispatchLifecycleHook(input: UserPromptSubmitInput | StopInput): void {
    const engine = this.deps.hookEngine;
    if (engine === undefined) return;
    const controller = new AbortController();
    engine.executeHooks(input.event, input, controller.signal).catch(() => {
      // swallow — lifecycle hooks are fire-and-forget
    });
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

      // Slice 3.6 — UserPromptSubmit lifecycle hook. Fires after the
      // WAL `user_message` is durable so a hook subscriber reading the
      // journal can safely see the same prompt. Fire-and-forget: slow
      // hooks must not delay `handlePrompt`'s return.
      this.dispatchLifecycleHook({
        event: 'UserPromptSubmit',
        sessionId: this.sessionId,
        turnId,
        agentId: this.agentId,
        prompt: input.text,
      });

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

  // ── Manual compaction (Slice 3.3 — /compact) ───────────────────────

  /**
   * Trigger a manual compaction outside of a Soul turn (the `/compact`
   * slash command path). Lifecycle dance:
   *
   *   idle → active → (runCompaction: active → compacting → active) →
   *   completing → idle
   *
   * Throws if the session is not idle (a turn is in progress).
   */
  async triggerCompaction(): Promise<void> {
    if (!this.deps.lifecycleStateMachine.isIdle() || this.currentTurnId !== undefined) {
      throw new Error('Cannot compact while a turn is active');
    }

    const controller = new AbortController();
    this.deps.lifecycleStateMachine.transitionTo('active');
    try {
      await runCompaction(
        this.deps.contextState,
        this.deps.runtime,
        this.deps.sink,
        controller.signal,
      );
    } finally {
      // runCompaction's finally block transitions compacting → active.
      // We need to drain through active → completing → idle to return
      // the session to a quiescent state.
      if (this.deps.lifecycleStateMachine.isActive()) {
        this.deps.lifecycleStateMachine.transitionTo('completing');
      }
      if (this.deps.lifecycleStateMachine.isCompleting()) {
        this.deps.lifecycleStateMachine.transitionTo('idle');
      }
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────

  async awaitTurn(turnId: string): Promise<TurnResult | undefined> {
    const existing = this.turnPromises.get(turnId);
    if (existing === undefined) return undefined;
    return existing;
  }

  private buildBeforeToolCall(rules: readonly PermissionRule[]): BeforeToolCallHook {
    if (this.deps.orchestrator !== undefined) {
      // Slice 2.3 (N1): use the real agentId instead of the hardcoded
      // `'agent_main'` placeholder. Subagent TurnManagers get their id
      // from `deps.agentId` at construction (piped in from
      // `SubagentHandle.agentId`).
      const approvalSource: ApprovalSource =
        this.agentType === 'sub'
          ? { kind: 'subagent', agent_id: this.agentId }
          : { kind: 'soul', agent_id: this.agentId };
      return this.deps.orchestrator.buildBeforeToolCall({
        turnId: this.currentTurnId ?? 'unknown',
        permissionRules: rules,
        permissionMode: this.permissionMode,
        approvalSource,
      });
    }
    // oxlint-disable-next-line unicorn/no-useless-undefined
    return async () => undefined;
  }

  /**
   * Compute the effective PermissionRule list for the *current* turn.
   * This is called exactly once per `launchTurn` and the result is
   * baked into a fresh `beforeToolCall` closure. The pending overrides
   * slot is drained inside `launchTurn` (not here) so this helper
   * remains side-effect free.
   */
  private computeTurnRules(): readonly PermissionRule[] {
    const overrides = this.pendingTurnOverrides;
    if (overrides === undefined) {
      return this.sessionRules;
    }
    const turnRules: PermissionRule[] = [];
    if (overrides.activeTools !== undefined) {
      for (const toolName of overrides.activeTools) {
        turnRules.push({
          decision: 'allow',
          scope: 'turn-override',
          pattern: toolName,
          reason: 'activeTools turn override',
        });
      }
    }
    if (overrides.disallowedTools !== undefined) {
      for (const toolName of overrides.disallowedTools) {
        turnRules.push({
          decision: 'deny',
          scope: 'turn-override',
          pattern: toolName,
          reason: 'disallowedTools turn override',
        });
      }
    }
    return [...this.sessionRules, ...turnRules];
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

    // Slice 2.2: compute the effective rule set and immediately drain
    // the pending turn-override slot. The order matters — the closure
    // below captures `effectiveRules` by reference but the drained slot
    // guarantees that if `launchTurn` is called again before the
    // current turn completes, the *next* turn starts from a clean
    // pending-overrides state (Q6 regression).
    const effectiveRules = this.computeTurnRules();
    this.pendingTurnOverrides = undefined;

    // Slice 3.6 — compute dynamic injections (plan mode / yolo mode /
    // host-supplied providers) and stash them as `system_reminder`
    // ephemerals BEFORE the notification drain. Ordering is
    // deliberate: dynamic injections are a more general "system
    // context" channel and should sit at the top of the synthetic
    // message block, with any pending notifications coming right
    // after. Both are consumed by the same `buildMessages()` drain on
    // the next LLM step.
    this.drainDynamicInjectionsIntoContext(turnId);

    // Slice 2.4 — drain the pending notification queue into
    // ContextState right before Soul starts its LLM loop. The Soul
    // loop calls `context.buildMessages()` once per step; the stash
    // we prime here is consumed by the first `buildMessages` call and
    // renders as `<notification ...>` / `<system-reminder>` user
    // messages prepended to history. Doing the drain here (rather
    // than inside Soul or ContextState) keeps Soul ignorant of
    // SoulPlus-level notification lifecycle — runSoulTurn sees a
    // plain ContextState whose buildMessages just happens to include
    // the injections.
    this.drainPendingNotificationsIntoContext();

    const soulConfig: SoulConfig = {
      tools: wrappedTools,
      beforeToolCall: this.buildBeforeToolCall(effectiveRules),
      afterToolCall: this.buildAfterToolCall(),
      // Slice 3.3 / M05: wire compactionConfig into SoulConfig so the
      // Soul while-loop's shouldCompact() gate is armed.
      ...(this.deps.compactionConfig !== undefined
        ? { compactionConfig: this.deps.compactionConfig }
        : {}),
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

      // Slice 3.6 — Stop lifecycle hook fires immediately after the
      // WAL `turn_end` append is durable. Fire-and-forget: the 3-hop
      // lifecycle drain in the `finally` block below must still run
      // even if a hook subscriber is slow. Hook errors are isolated
      // inside `dispatchLifecycleHook`.
      this.dispatchLifecycleHook({
        event: 'Stop',
        sessionId: this.sessionId,
        turnId,
        agentId: this.agentId,
        reason,
      });
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
