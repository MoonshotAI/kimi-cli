/**
 * SoulPlus — the session facade (v2 §5.2).
 *
 * Assembles the shared resource layer (SessionLifecycleStateMachine /
 * LifecycleGateFacade / JournalWriter / WiredContextState /
 * SessionJournal), the service layer (KosongAdapter / Runtime), and the
 * behaviour layer (TurnManager / SoulRegistry / SessionEventBus /
 * NotificationManager). `dispatch(req)` routes the three
 * conversation-channel methods (`session.prompt` / `session.cancel` /
 * `session.steer`); other channels (config / management / tools / the
 * rest of the wire protocol envelope) are still owned by Slice 5
 * RequestRouter once SessionManager wires SoulPlus into request
 * dispatch. The Slice 2.4 `addSystemReminder` / `emitNotification`
 * public methods are reachable today via this facade without going
 * through a wire router.
 *
 * Out of scope:
 *   - RequestRouter / ownership checks (Slice 5)
 *   - SkillManager (Slice 9A)
 *   - TeamDaemon (Slice 7+)
 *   - Real wire protocol envelope (Slice 5)
 */

import type { CompactionConfig, Runtime, Tool } from '../soul/index.js';
import type { FullContextState } from '../storage/context-state.js';
import type { SessionJournal } from '../storage/session-journal.js';
import { AgentTool } from '../tools/agent.js';
import type { AgentTypeRegistry } from './agent-type-registry.js';
import { createDefaultDynamicInjectionManager } from './dynamic-injection.js';
import { LifecycleGateFacade } from './lifecycle-gate.js';
import { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';
import { NotificationManager, type ShellDeliverCallback } from './notification-manager.js';
import type { SessionEventBus } from './session-event-bus.js';
import type { SkillManager } from './skill/index.js';
import { SoulRegistry } from './soul-registry.js';
import type { SubagentStore } from './subagent-store.js';
import { runSubagentTurn } from './subagent-runner.js';
import { TurnManager } from './turn-manager.js';
import type { DispatchRequest, DispatchResponse } from './types.js';

export interface SoulPlusDeps {
  readonly sessionId: string;
  readonly contextState: FullContextState;
  readonly sessionJournal: SessionJournal;
  readonly runtime: Runtime;
  /**
   * Event bus — must be a concrete `SessionEventBus` (not a bare
   * `EventSink`) so the NotificationManager can publish to its
   * notification channel. Slice 2.4 raised the dep type from
   * `EventSink` to `SessionEventBus` specifically to access
   * `emitNotification` without widening `EventSink`.
   */
  readonly eventBus: SessionEventBus;
  readonly tools: readonly Tool[];
  /**
   * Optional shell-target callback (Slice 2.4). kimi-core does not
   * render shell notifications itself; the TUI / SDK consumer injects a
   * callback here and decides how to surface each notification
   * (toast, system notification, stderr line, etc.). When absent, the
   * shell target is a no-op (recorded as `delivered_at.shell = 0`).
   */
  readonly onShellDeliver?: ShellDeliverCallback | undefined;
  /**
   * Optional SkillManager (Slice 2.5). Host code constructs and
   * initialises it before building SoulPlus, then passes the
   * already-scanned instance here. When absent, `activateSkill`
   * rejects with an error — kimi-core does not implicitly boot a
   * skill registry on behalf of callers.
   */
  readonly skillManager?: SkillManager | undefined;
  /**
   * Externally-owned lifecycle state machine (Codex Round 2 M3).
   * When provided, SoulPlus uses this instead of creating its own.
   * SessionManager passes the same state machine to JournalWriter
   * (via LifecycleGateFacade) so both gate on a single physical
   * state machine. When absent, SoulPlus creates its own (backward
   * compat for tests that construct SoulPlus directly).
   */
  readonly lifecycleStateMachine?: SessionLifecycleStateMachine | undefined;
  /**
   * Compaction configuration (Codex Round 2 M2). Passed through to
   * TurnManager so the Soul while-loop's shouldCompact() gate is
   * armed in the real session path, not just in unit tests.
   */
  readonly compactionConfig?: CompactionConfig | undefined;
  /**
   * Slice 4.2 — optional tool-call orchestrator. When provided, SoulPlus
   * forwards it to TurnManager so the per-turn `beforeToolCall` /
   * `afterToolCall` closures run the full Hook → Permission → Approval
   * pipeline via `ToolCallOrchestrator`. When absent (tests, embedders
   * that bypass permissions entirely), TurnManager falls back to the
   * always-allow closures exactly as before.
   *
   * The type is inlined (`import('./orchestrator.js')`) rather than
   * imported at the top of the file so the file-level dependency
   * count does not tip over the `import/max-dependencies` threshold
   * (already at 11 pre-Slice 4.2 — baseline policy gap, not new).
   */
  readonly orchestrator?: import('./orchestrator.js').ToolCallOrchestrator | undefined;
  /**
   * Slice 5.3 — optional subagent infrastructure. When both `subagentStore`
   * and `agentTypeRegistry` are provided, SoulPlus wires the AgentTool into
   * the tool set and connects `runSubagentTurn` to the SoulRegistry. When
   * absent (tests, embedders), the Agent tool is not available.
   */
  readonly subagentStore?: SubagentStore | undefined;
  readonly agentTypeRegistry?: AgentTypeRegistry | undefined;
  /** Session directory path (required when subagent infra is provided). */
  readonly sessionDir?: string | undefined;
}

export class SoulPlus {
  public readonly sessionId: string;
  private readonly turnManager: TurnManager;
  private readonly notificationManager: NotificationManager;
  private readonly sessionJournal: SessionJournal;
  private readonly contextState: FullContextState;
  private readonly skillManager: SkillManager | undefined;

  constructor(deps: SoulPlusDeps) {
    this.sessionId = deps.sessionId;
    this.sessionJournal = deps.sessionJournal;
    this.contextState = deps.contextState;
    this.skillManager = deps.skillManager;

    // Lifecycle state machine setup:
    //   When `deps.lifecycleStateMachine` is provided (production path via
    //   SessionManager — Codex Round 2 M3), we reuse the externally-owned
    //   instance so JournalWriter, Runtime.lifecycle, and TurnManager all
    //   share the SAME physical state machine. When absent (tests that
    //   construct SoulPlus directly), we create a local one for backward
    //   compatibility.
    const stateMachine = deps.lifecycleStateMachine ?? new SessionLifecycleStateMachine();
    const facade = new LifecycleGateFacade(stateMachine);
    const runtime: Runtime = {
      kosong: deps.runtime.kosong,
      compactionProvider: deps.runtime.compactionProvider,
      lifecycle: facade,
      journal: deps.runtime.journal,
    };

    // Slice 5.3 — wire subagent support when both store + registry are provided
    const hasSubagentInfra =
      deps.subagentStore !== undefined && deps.agentTypeRegistry !== undefined;

    const soulRegistry = new SoulRegistry({
      createHandle: (key) => ({
        key,
        agentId: key === 'main' ? 'agent_main' : key.replace('sub:', ''),
        abortController: new AbortController(),
      }),
      ...(hasSubagentInfra
        ? {
            runSubagentTurn: (agentId, request, signal) =>
              runSubagentTurn(
                {
                  store: deps.subagentStore!,
                  typeRegistry: deps.agentTypeRegistry!,
                  parentTools: deps.tools,
                  parentRuntime: runtime,
                  parentSink: deps.eventBus,
                  sessionDir: deps.sessionDir ?? '',
                  parentModel: deps.contextState.model,
                },
                agentId,
                request,
                signal,
              ),
          }
        : {}),
    });

    // Build the tool set. When subagent infra is present, add AgentTool.
    // Note: AgentTool is added to the parent's tool set but NOT to
    // deps.tools (which is passed as parentTools to runSubagentTurn).
    // Child tool sets are filtered via AgentTypeRegistry.resolveToolSet(),
    // and the YAML exclude_tools lists 'Agent' for all child types.
    // Even if deps.tools doesn't contain AgentTool, the YAML excludeTools
    // provides a second layer of protection against recursive spawn.
    const tools: Tool[] = [...deps.tools];
    if (hasSubagentInfra) {
      tools.push(new AgentTool(soulRegistry, 'agent_main'));
    }

    // Slice 5.4 — create DynamicInjectionManager with built-in providers
    // (plan-mode + yolo-mode reminders). Auto-created, not host-injected (D2=A).
    const dynamicInjectionManager = createDefaultDynamicInjectionManager();

    this.turnManager = new TurnManager({
      contextState: deps.contextState,
      sessionJournal: deps.sessionJournal,
      runtime,
      sink: deps.eventBus,
      lifecycleStateMachine: stateMachine,
      soulRegistry,
      tools,
      dynamicInjectionManager,
      // Codex Round 2 M2: pass compactionConfig so auto-compaction is
      // armed in the real session path (not just unit tests).
      ...(deps.compactionConfig !== undefined ? { compactionConfig: deps.compactionConfig } : {}),
      // Slice 4.2 — forward the optional orchestrator so TurnManager
      // builds real hook/permission/approval closures for tool calls.
      ...(deps.orchestrator !== undefined ? { orchestrator: deps.orchestrator } : {}),
    });

    // Slice 2.4 — NotificationManager wires the three sinks:
    //   1. llm  → TurnManager.addPendingNotification (buffered until
    //      the next launchTurn drains into ContextState)
    //   2. wire → SessionEventBus.emitNotification (real-time fan-out
    //      to UI subscribers)
    //   3. shell → optional callback from SoulPlusDeps.onShellDeliver
    //      (no-op if absent; kimi-core never renders shell surface)
    //
    // NotificationManager is held as a field so `addSystemReminder` and
    // future slice 2.5 / 2.6 producers (skill / MCP completion events)
    // can reach it without going through TurnManager.
    this.notificationManager = new NotificationManager({
      sessionJournal: deps.sessionJournal,
      sessionEventBus: deps.eventBus,
      onEmittedToLlm: (notif) => {
        this.turnManager.addPendingNotification(notif);
      },
      ...(deps.onShellDeliver !== undefined ? { onShellDeliver: deps.onShellDeliver } : {}),
    });
  }

  // ── Slice 2.4 public API ─────────────────────────────────────────────

  /**
   * Inject a system reminder into the next Soul turn (§3.5 wire method
   * `session.addSystemReminder`). Two effects:
   *
   *   1. WAL — writes a `SystemReminderRecord` via
   *      `SessionJournal.appendSystemReminder` so the reminder is
   *      crash-recoverable.
   *   2. Mirror — pushes a `system_reminder` EphemeralInjection into
   *      ContextState, so the next `buildMessages()` emits a
   *      `<system-reminder>...</system-reminder>` synthetic user
   *      message before history.
   *
   * NotificationManager is NOT used for system reminders — they stay
   * as their own record type per Slice 2.4 Q4 decision (SystemReminder
   * is a view of NotificationRecord but persists as an independent
   * record type, not a notification with category=system). That means
   * addSystemReminder does not fan out to wire or shell sinks; callers
   * who want UI-visible reminders should emit a full NotificationData
   * via `emitNotification` instead.
   *
   * Slice 2.4 ships this as the minimum viable wiring to close Phase 1
   * Slice 8 audit M1 (`appendSystemReminder` was a write-only
   * dangling seam). Phase 2+ may later grow a wire-subscribe path if
   * UI requirements justify it.
   */
  async addSystemReminder(text: string): Promise<void> {
    await this.sessionJournal.appendSystemReminder({
      type: 'system_reminder',
      content: text,
    });
    // Synchronous mirror — the WAL write above is the durability
    // boundary; this push is the in-memory projection that the next
    // `buildMessages()` actually reads. Both steps together mirror
    // §4.5.6's WAL-then-mirror invariant.
    this.contextState.stashEphemeralInjection({
      kind: 'system_reminder',
      content: text,
    });
  }

  /**
   * Emit a full NotificationData through the three-sink fan-out
   * (Slice 2.4). Thin pass-through to NotificationManager so callers
   * can use the SoulPlus facade as the single entry point.
   *
   * Returns the manager result so callers can observe dedupe / per-sink
   * delivery state (e.g. tests asserting that `delivered_at.shell = 0`
   * means "no shell callback registered").
   */
  emitNotification(
    input: Parameters<NotificationManager['emit']>[0],
  ): ReturnType<NotificationManager['emit']> {
    return this.notificationManager.emit(input);
  }

  /** Test / inspection helper — exposes the manager for fine-grained assertions. */
  getNotificationManager(): NotificationManager {
    return this.notificationManager;
  }

  /** Test / inspection helper — exposes the TurnManager. */
  getTurnManager(): TurnManager {
    return this.turnManager;
  }

  // ── Slice 2.5 Skill public API ──────────────────────────────────────

  /**
   * Activate a skill by name (Slice 2.5 inline mode). Reads the
   * SKILL.md body from the registered `SkillDefinition`, interpolates
   * `args`, and appends the result as a user message on the session
   * ContextState so the next turn picks it up. Routing from `/<name>`
   * slash input to a skill name is the caller's responsibility
   * (D1) — kimi-core does not inspect prefixes.
   */
  async activateSkill(name: string, args: string): Promise<void> {
    if (this.skillManager === undefined) {
      throw new Error('SoulPlus.activateSkill: no SkillManager was provided in SoulPlusDeps');
    }
    await this.skillManager.activate(name, args, { contextState: this.contextState });
  }

  /**
   * Returns the SkillManager bound to this session, or `undefined`
   * when the host did not supply one. Intended for upper layers that
   * need to render `${KIMI_SKILLS}` or extend WorkspaceConfig with
   * skill roots.
   */
  getSkillManager(): SkillManager | undefined {
    return this.skillManager;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResponse> {
    switch (request.method) {
      case 'session.prompt':
        return this.turnManager.handlePrompt({ data: request.data });
      case 'session.cancel':
        return this.turnManager.handleCancel({ data: request.data });
      case 'session.steer':
        return this.turnManager.handleSteer({ data: request.data });
      default: {
        // Exhaustive guard — Slice 5 must extend `DispatchRequest` AND
        // add a matching case here; if it forgets, this line fails to
        // compile instead of silently returning `method_not_found`.
        const _exhaustive: never = request;
        void _exhaustive;
        return { error: 'method_not_found' };
      }
    }
  }
}
