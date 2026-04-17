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
import type { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';

export interface CompactionOrchestratorDeps {
  readonly contextState: FullContextState;
  readonly compactionProvider: CompactionProvider;
  readonly lifecycleStateMachine: SessionLifecycleStateMachine;
  readonly journalCapability: JournalCapability;
  readonly sink: EventSink;
  readonly journalWriter: JournalWriter;
  readonly hookEngine?: HookEngine | undefined;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
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

      // Phase 3 铁律: drain the async-batch buffer BEFORE rotate so no
      // in-memory record lands in the post-rotation wire.jsonl after the
      // rename.
      await this.deps.journalWriter.flush();

      const rotateResult = await this.deps.journalCapability.rotate({
        type: 'compaction_boundary',
        summary,
        parent_file: '',
      });

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
      // response. Re-append the tail user_message verbatim so Soul can act on it.
      const tailUserText = extractUnpairedTailUserText(messages);
      if (tailUserText !== undefined) {
        await this.deps.contextState.appendUserMessage({ text: tailUserText });
      }

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
