/**
 * CompactionOrchestrator — dedicated compaction pipeline (v2 §6.4 /
 * 决策 #109 / phase-4 todo Part A.1).
 *
 * Phase 4 extracts `executeCompaction` / `triggerCompaction` out of
 * `TurnManager` so the coordinator stops owning business orchestration
 * (铁律 7). Soul never sees this class — it only signals
 * `stopReason='needs_compaction'`; TurnManager wakes the orchestrator
 * for both Soul-signalled auto-compaction and the `/compact` slash
 * command path.
 *
 * Dependency surface is intentionally narrow (6 required, 3 optional):
 *
 *   - contextState           FullContextState to build messages / reset summary
 *   - compactionProvider     Produces the SummaryMessage from a message list
 *   - lifecycleStateMachine  5-state machine; transitions active ↔ compacting
 *   - journalCapability      Rotates wire.jsonl at the compaction boundary
 *   - sink                   Emits compaction.begin / compaction.end
 *   - journalWriter          Flushed BEFORE rotate() (Phase 3 铁律)
 *
 *   - hookEngine?            PreCompact / PostCompact fire-and-forget
 *   - sessionId?             Hook payload stamp
 *   - agentId?               Hook payload stamp
 */

import type { Message } from '@moonshot-ai/kosong';

import { estimateTokens } from '../soul/compaction.js';
import type {
  CompactionProvider,
  EventSink,
  JournalCapability,
  SummaryMessage as RuntimeSummaryMessage,
} from '../soul/index.js';
import type {
  FullContextState,
  SummaryMessage as StorageSummaryMessage,
} from '../storage/context-state.js';
import type { JournalWriter } from '../storage/journal-writer.js';
import type { HookEngine } from '../hooks/engine.js';
import type { PermissionMode } from './permission/index.js';
import type { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';
import type { SessionInitializedRecord } from '../storage/wire-record.js';

/**
 * Phase 23 fix — runtime-mutable state captured at compaction time so the
 * post-rotate `session_initialized` reflects the current state, not the
 * original startup baseline. ContextState already exposes `model` /
 * `systemPrompt` / `activeTools`; this provider supplies the bits that
 * live on TurnManager (`permissionMode` / `planMode`) which the
 * orchestrator does not have a direct reference to (cyclic-construction
 * order: orchestrator is built before TurnManager in `SoulPlus`).
 *
 * Without this, runtime changes via `setModel` / `applyConfigChange` /
 * `setPermissionMode` / `setPlanMode` get archived together with the
 * pre-compact records, and resume off the post-rotate wire silently
 * reverts to the original startup config — a violation of the L3.1
 * truth-source-uniqueness rule that Phase 23 was introduced to enforce.
 */
export interface RuntimeStateProvider {
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
}

/**
 * Phase 23 fix — opt-out helper for test fixtures that do not exercise
 * permission_mode / plan_mode runtime mutations. Production code MUST NOT
 * use this — pass a closure that reads the live TurnManager state instead.
 */
export const STATIC_DEFAULT_RUNTIME_STATE: () => RuntimeStateProvider = () => ({
  permissionMode: 'default',
  planMode: false,
});

export interface CompactionOrchestratorDeps {
  readonly contextState: FullContextState;
  readonly compactionProvider: CompactionProvider;
  readonly lifecycleStateMachine: SessionLifecycleStateMachine;
  readonly journalCapability: JournalCapability;
  readonly sink: EventSink;
  readonly journalWriter: JournalWriter;
  /**
   * Phase 23 fix — late-bound snapshot of runtime-mutable state that lives
   * on TurnManager. Called inside `executeCompaction` right before
   * `appendBoundary` so the copied `session_initialized` mirrors the
   * current `permissionMode` / `planMode` instead of reverting to the
   * original startup baseline.
   *
   * Required (not optional) so the contract is enforced at the type level.
   * Allowing this to be omitted would create a silent half-fix: ContextState
   * fields (model / systemPrompt / activeTools) would still reflect the
   * current state from `cs.*`, but `permissionMode` / `planMode` would
   * silently revert to the baseline from the on-disk record — an
   * inconsistent post-rotate baseline.
   *
   * Test fixtures that do not exercise permission_mode / plan_mode
   * mutations may pass `STATIC_DEFAULT_RUNTIME_STATE` to declare
   * "I don't care about these fields" explicitly.
   */
  readonly runtimeStateProvider: () => RuntimeStateProvider;
  readonly hookEngine?: HookEngine | undefined;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
  /**
   * Phase 20 Codex round-5 — predicate returning the in-flight turn id
   * when `TurnManager.handlePrompt` has synchronously reserved a turn
   * slot (`pendingLaunchTurnId`) but has not yet transitioned the
   * lifecycle machine to `'active'`. Without this hook `triggerCompaction`'s
   * `isIdle()` gate returns true in that await window, letting `/compact`
   * race against a concurrent `/prompt` launch. TurnManager wires this;
   * tests that do not exercise the concurrent slash+prompt path may
   * omit it (defaults to "no pending turn").
   */
  readonly getPendingTurnId?: (() => string | undefined) | undefined;
}

export class CompactionOrchestrator {
  constructor(private readonly deps: CompactionOrchestratorDeps) {}

  /**
   * Core compaction pipeline — assumes the lifecycle machine has already
   * landed in `active`. Drives `active → compacting → active`:
   *
   *   1. transitionTo('compacting')
   *   2. emit compaction.begin
   *   3. provider.run(messages, signal, {userInstructions?})
   *   4. journalWriter.flush()           (Phase 3 铁律 — before rotate)
   *   5. journalCapability.rotate(...)
   *   6. contextState.resetToSummary(storageSummary)
   *   7. emit compaction.end
   *   8. finally: transitionTo('active')
   *
   * `signal.throwIfAborted()` is checked at two points: immediately after
   * begin (so a pre-aborted signal never invokes the provider) and
   * immediately after provider.run (so a slow provider doesn't produce a
   * summary that races with concurrent cancel). There is no abort check
   * between rotate and resetToSummary — once rotate has renamed the old
   * wire.jsonl, aborting would leave the fresh wire.jsonl without its
   * CompactionRecord.
   */
  async executeCompaction(
    signal: AbortSignal,
    customInstruction?: string,
    trigger: 'auto' | 'manual' = 'auto',
  ): Promise<void> {
    const machine = this.deps.lifecycleStateMachine;
    machine.transitionTo('compacting');
    let tailUserText: string | undefined;
    try {
      this.deps.sink.emit({ type: 'compaction.begin' });
      signal.throwIfAborted();

      const messages: Message[] = this.deps.contextState.buildMessages();
      const preCompactTokens = this.deps.contextState.tokenCountWithPending;

      const summary = await this.deps.compactionProvider.run(
        messages,
        signal,
        customInstruction !== undefined ? { userInstructions: customInstruction } : undefined,
      );
      signal.throwIfAborted();

      // Phase 23 — capture the current `session_initialized` baseline
      // BEFORE rotate so we can copy it into line 2 of the post-rotate
      // wire (v2 §4.1.2 + C6).
      const baselineInit = await this.deps.journalCapability.readSessionInitialized();

      // Phase 23 fix — overlay the runtime-mutable subset of the baseline
      // with the current ContextState + TurnManager state. Any state
      // change that happened via *_changed records since session start is
      // about to be archived together with the pre-compact wire; without
      // this overlay the post-rotate wire's line-2 baseline would revert
      // to the original startup config and resume would silently undo
      // every `setModel` / `applyConfigChange` / `setPermissionMode` /
      // `setPlanMode` that ran before this compaction. Identity-class
      // fields (`agent_type` / `session_id` / parent lineage / workspace)
      // are preserved verbatim because they cannot legally mutate at
      // runtime — see the discriminated-union shape in `wire-record.ts`.
      const runtime = this.deps.runtimeStateProvider();
      const cs = this.deps.contextState;
      const sessionInitialized = applyRuntimeOverlay(baselineInit, {
        system_prompt: cs.systemPrompt,
        model: cs.model,
        active_tools: [...cs.activeTools],
        permission_mode: runtime.permissionMode,
        plan_mode: runtime.planMode,
      });

      // Phase 3 铁律: drain the async-batch buffer BEFORE rotate so no
      // in-memory record lands in the post-rotation wire.jsonl after the
      // rename.
      await this.deps.journalWriter.flush();

      const rotateResult = await this.deps.journalCapability.rotate({
        type: 'compaction_boundary',
        summary,
        parent_file: '',
      });

      // Phase 23 — copy the (overlaid) baseline as line 2 of the new wire
      // BEFORE resetToSummary writes the compaction record at line 3.
      await this.deps.journalCapability.appendBoundary(sessionInitialized);

      const storageSummary = bridgeSummaryMessage(
        summary,
        messages.length,
        preCompactTokens,
        trigger,
        rotateResult.archiveFile,
      );
      await this.deps.contextState.resetToSummary(storageSummary);

      // 决策 #101 — tail user_message guard. If the original conversation ended
      // on an unpaired user message (no assistant response followed), the summary
      // above just absorbed that user text and the LLM would see no standalone
      // "pending user message" to reply to — the next turn would produce no
      // response. Capture the tail text here, but defer the re-append until
      // AFTER the lifecycle machine leaves 'compacting' (the user_message
      // record type is not in COMPACTION_OWN_WRITE_TYPES, so writing it
      // while gated throws JournalGatedError).
      tailUserText = extractUnpairedTailUserText(messages);

      this.deps.sink.emit({
        type: 'compaction.end',
        tokensBefore: preCompactTokens,
        tokensAfter: storageSummary.postCompactTokens,
      });
    } finally {
      // Drain back to `active` even on abort so the TurnManager while-loop
      // can observe a consistent state on the next iteration.
      machine.transitionTo('active');
    }

    // Tail re-append runs after `transitionTo('active')` so the
    // user_message write passes the lifecycle gate (决策 #101 +
    // Phase 23 §Step 8).
    if (tailUserText !== undefined) {
      await this.deps.contextState.appendUserMessage({ text: tailUserText });
    }
  }

  /**
   * Manual `/compact` slash-command entry point. Drives the full lifecycle
   * dance from `idle`:
   *
   *   idle → active → (executeCompaction: active → compacting → active) →
   *   completing → idle
   *
   * Throws if the machine is not `idle` at entry — `Cannot compact while
   * a turn is active`. PreCompact / PostCompact hooks fire here (not in
   * `executeCompaction`) because the hook scope covers the *entire*
   * compaction request, including the idle-drain bracketing.
   */
  async triggerCompaction(customInstruction?: string): Promise<void> {
    if (!this.deps.lifecycleStateMachine.isIdle()) {
      throw new Error('Cannot compact while a turn is active');
    }
    // Phase 20 Codex round-5 — mirror the `getCurrentTurnId()` half of
    // `TurnManager.tryReserveForMaintenance`. `handlePrompt` sets
    // `pendingLaunchTurnId` synchronously BEFORE its await chain
    // transitions the lifecycle to 'active'; during that window a
    // plain `isIdle()` gate is false-positive. Closing this gap here
    // keeps `/compact` on parity with `/clear`'s atomic reservation.
    if (this.deps.getPendingTurnId?.() !== undefined) {
      throw new Error('Cannot compact while a prompt launch is in flight');
    }

    const controller = new AbortController();
    this.deps.lifecycleStateMachine.transitionTo('active');

    const sessionId = this.deps.sessionId ?? 'unknown';
    const agentId = this.deps.agentId ?? 'agent_main';

    // PreCompact hook (fire-and-forget, fail-open)
    if (this.deps.hookEngine !== undefined) {
      void this.deps.hookEngine
        .executeHooks(
          'PreCompact',
          {
            event: 'PreCompact',
            sessionId,
            turnId: 'compact',
            agentId,
          },
          controller.signal,
        )
        .catch(() => {
          // swallow — PreCompact must never brick a compaction
        });
    }

    const tokensBefore = this.deps.contextState.tokenCountWithPending;
    try {
      await this.executeCompaction(controller.signal, customInstruction, 'manual');
    } finally {
      const tokensAfter = this.deps.contextState.tokenCountWithPending;
      if (this.deps.hookEngine !== undefined) {
        void this.deps.hookEngine
          .executeHooks(
            'PostCompact',
            {
              event: 'PostCompact',
              sessionId,
              turnId: 'compact',
              agentId,
              tokensBefore,
              tokensAfter,
            },
            controller.signal,
          )
          .catch(() => {
            // swallow — PostCompact is observational
          });
      }

      // 3-hop drain: executeCompaction's finally block already moved the
      // machine compacting → active. Now continue active → completing →
      // idle so the session returns to a quiescent state.
      if (this.deps.lifecycleStateMachine.isActive()) {
        this.deps.lifecycleStateMachine.transitionTo('completing');
      }
      if (this.deps.lifecycleStateMachine.isCompleting()) {
        this.deps.lifecycleStateMachine.transitionTo('idle');
      }
    }
  }
}

/**
 * Phase 23 fix — overlay the runtime-mutable subset of a baseline
 * `session_initialized` with the live ContextState + TurnManager state.
 *
 * Identity-class fields (`type`, `seq`, `time`, `agent_type`, `session_id`,
 * `agent_id`, parent lineage, `workspace_dir`, `thinking_level`) are
 * preserved verbatim because they cannot legally mutate at runtime — see
 * the discriminated-union shape in `wire-record.ts`. The mutable fields
 * (`system_prompt`, `model`, `active_tools`, `permission_mode`,
 * `plan_mode`) are overwritten so the post-rotate baseline reflects the
 * compaction-time snapshot rather than the original startup config.
 *
 * The generic preserves the discriminated-union narrowing so each branch
 * (main / sub / independent) returns its own concrete type.
 */
function applyRuntimeOverlay<T extends SessionInitializedRecord>(
  baseline: T,
  overlay: {
    readonly system_prompt: string;
    readonly model: string;
    readonly active_tools: readonly string[];
    readonly permission_mode: PermissionMode;
    readonly plan_mode: boolean;
  },
): T {
  return {
    ...baseline,
    system_prompt: overlay.system_prompt,
    model: overlay.model,
    active_tools: [...overlay.active_tools],
    permission_mode: overlay.permission_mode,
    plan_mode: overlay.plan_mode,
  };
}

/**
 * Translate the provider's Soul-facing `RuntimeSummaryMessage` into the
 * storage layer's `StorageSummaryMessage`. Ported verbatim from the old
 * `turn-manager.ts:bridgeSummaryMessage`.
 */
/**
 * If the input message array ends on an unpaired user message (no following
 * assistant response), return that user's text so the caller can re-append it
 * to the post-compaction conversation state (决策 #101).
 *
 * Returns `undefined` when the tail is not an unpaired user message.
 */
function extractUnpairedTailUserText(messages: readonly Message[]): string | undefined {
  if (messages.length === 0) return undefined;
  const tail = messages[messages.length - 1];
  if (tail === undefined) return undefined;
  if (tail.role !== 'user') return undefined;
  const content = tail.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'object' && part !== null && 'type' in part) {
        const typed = part as { type: string; text?: unknown };
        if (typed.type === 'text' && typeof typed.text === 'string') {
          parts.push(typed.text);
        }
      }
    }
    return parts.length > 0 ? parts.join('') : undefined;
  }
  return undefined;
}

function bridgeSummaryMessage(
  providerSummary: RuntimeSummaryMessage,
  messagesCount: number,
  preCompactTokens: number,
  trigger: 'auto' | 'manual',
  archiveFile?: string,
): StorageSummaryMessage {
  return {
    summary: providerSummary.content,
    compactedRange: {
      fromTurn: 1,
      toTurn: providerSummary.original_turn_count ?? messagesCount,
      messageCount: messagesCount,
    },
    preCompactTokens,
    postCompactTokens: estimateTokens(providerSummary.content),
    trigger,
    ...(archiveFile !== undefined ? { archiveFile } : {}),
  };
}
