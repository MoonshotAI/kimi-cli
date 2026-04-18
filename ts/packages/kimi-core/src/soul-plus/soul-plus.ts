/**
 * SoulPlus — the session facade (v2 §5.2).
 *
 * Phase 4 (决策 #92): the 25+ private fields collapse into six facade
 * groups — lifecycle / journal / services / components / infra — plus
 * `runtime` kept as an independent top-level field because Soul consumes
 * it directly (铁律 6).
 *
 * Public API (unchanged): `dispatch` / `addSystemReminder` /
 * `emitNotification` / `activateSkill` / `getTurnManager` /
 * `getNotificationManager` / `getSkillManager`. The facade reshuffle is
 * purely internal; every existing caller sees the same behaviour.
 */

import type {
  CompactionConfig,
  CompactionProvider,
  JournalCapability,
  Runtime,
  Tool,
} from '../soul/index.js';
import type { PathConfig } from '../session/path-config.js';
import type { FullContextState } from '../storage/context-state.js';
import type { SessionJournal } from '../storage/session-journal.js';
import { AgentTool } from '../tools/agent.js';
import type { Logger } from '../utils/logger.js';
import type { AgentTypeRegistry } from './agent-type-registry.js';
import type { ApprovalStateStore } from './approval-state-store.js';
import { CompactionOrchestrator } from './compaction-orchestrator.js';
import { createDefaultDynamicInjectionManager } from './dynamic-injection.js';
import type {
  ComponentsFacade,
  InfraFacade,
  JournalFacade,
  LifecycleFacade,
  ServicesFacade,
} from './facades.js';
import { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';
import {
  createStubCompactionProvider,
  createStubJournalCapability,
} from './runtime-factory.js';
import { NotificationManager, type ShellDeliverCallback } from './notification-manager.js';
import type { ToolCallOrchestrator } from './orchestrator.js';
import { PermissionClosureBuilder } from './permission-closure-builder.js';
import type { PermissionRule } from './permission/index.js';
import type { SessionEventBus } from './session-event-bus.js';
import {
  DefaultSessionControl,
  type SessionControlHandler,
} from './session-control.js';
import { SessionMetaService, type SessionMeta } from './session-meta-service.js';
import type { StateCache } from '../session/state-cache.js';
import type { SkillManager } from './skill/index.js';
import { SkillInlineWriter } from './skill/inline-writer.js';
import { SoulLifecycleGate } from './soul-lifecycle-gate.js';
import { SoulRegistry } from './soul-registry.js';
import { StreamingKosongWrapper } from './streaming-kosong-wrapper.js';
import { SkillTool } from '../tools/skill-tool.js';
import type { SubagentStore } from './subagent-store.js';
import { runSubagentTurn } from './subagent-runner.js';
import { TurnLifecycleTracker } from './turn-lifecycle-tracker.js';
import { TurnManager } from './turn-manager.js';
import type { DispatchRequest, DispatchResponse } from './types.js';
import { WakeQueueScheduler } from './wake-queue-scheduler.js';

export interface SoulPlusDeps {
  readonly sessionId: string;
  readonly contextState: FullContextState;
  readonly sessionJournal: SessionJournal;
  readonly runtime: Runtime;
  readonly eventBus: SessionEventBus;
  readonly tools: readonly Tool[];
  readonly onShellDeliver?: ShellDeliverCallback | undefined;
  readonly skillManager?: SkillManager | undefined;
  readonly lifecycleStateMachine?: SessionLifecycleStateMachine | undefined;
  readonly compactionConfig?: CompactionConfig | undefined;
  readonly compactionProvider?: CompactionProvider | undefined;
  readonly journalCapability?: JournalCapability | undefined;
  readonly orchestrator?: ToolCallOrchestrator | undefined;
  readonly subagentStore?: SubagentStore | undefined;
  readonly agentTypeRegistry?: AgentTypeRegistry | undefined;
  readonly sessionDir?: string | undefined;
  readonly workDir?: string | undefined;
  /**
   * Phase 6 — when supplied, the subagent runner derives the child wire
   * path through `pathConfig.subagentDir(sessionId, agentId)` instead of
   * hand-joining `sessionDir`. SessionManager owns the production
   * `PathConfig`; pass it through here so subagent storage follows the
   * same §9.5 path service as the parent session.
   */
  readonly pathConfig?: PathConfig | undefined;
  /**
   * Phase 16 / 决策 #113 — session state.json cache. Required to wire
   * SessionMetaService; omitting it skips the service entirely (test
   * harnesses that do not exercise sessionMeta).
   */
  readonly stateCache?: StateCache | undefined;
  /**
   * Phase 16 — initial SessionMeta view (built by SessionManager from
   * state.json + replay projection). Required in conjunction with
   * `stateCache`.
   */
  readonly initialMeta?: SessionMeta | undefined;
  /**
   * Phase 18 A.5 / L2-6 — when supplied, SoulPlus subscribes the
   * store's `onChanged` fan-out and forwards `yolo` flips to
   * `TurnManager.setPermissionMode` so a wire `session.setYolo`
   * takes effect immediately (not only next turn). Optional because
   * legacy test harnesses still wire approval without the store
   * abstraction.
   */
  readonly approvalStateStore?: ApprovalStateStore | undefined;
  /**
   * Phase 20 §C.3 / R-5 — structured logger forwarded to inner
   * components (e.g. NotificationManager). Defaults to a silent logger;
   * production hosts inject their pino adapter.
   */
  readonly logger?: Logger | undefined;
}

export class SoulPlus {
  public readonly sessionId: string;
  private readonly lifecycle: LifecycleFacade;
  private readonly journal: JournalFacade;
  private readonly services: ServicesFacade;
  private readonly components: ComponentsFacade;
  private readonly infra: InfraFacade;
  /**
   * Phase 18 A.3–A.6 — lazy `SessionControlHandler` owned by the
   * facade. External hosts (SessionManager) still construct their own
   * `DefaultSessionControl` at session-setup time; `getSessionControl`
   * materialises the same handler on demand so wire handlers can reach
   * the config-channel surface without plumbing a second reference
   * through `ManagedSession`.
   */
  private sessionControlInstance: SessionControlHandler | undefined;
  // Phase 4 review (Nit 2): the top-level `runtime` facade slot is a v2
  // design concern (铁律 6 — Runtime is Soul's only SoulPlus-visible
  // contract surface), but SoulPlus itself never reads `runtime` after
  // construction — it was already forwarded to `TurnManagerDeps.runtime`
  // during assembly. Keeping a private field here would be dead code, so
  // the physical slot is dropped. The facade aggregation still wires
  // `runtime` through the constructor as a local.

  constructor(deps: SoulPlusDeps) {
    this.sessionId = deps.sessionId;

    // ── Infra facade ────────────────────────────────────────────────
    const eventBus = deps.eventBus;
    const toolRegistry: Tool[] = [...deps.tools];
    const permissionRules: readonly PermissionRule[] = [];

    // ── Lifecycle facade ────────────────────────────────────────────
    // Reuse an externally-owned state machine when provided (production
    // path — SessionManager shares the same instance with JournalWriter);
    // otherwise build a fresh one for tests that construct SoulPlus
    // directly.
    const stateMachine = deps.lifecycleStateMachine ?? new SessionLifecycleStateMachine();
    const gate = new SoulLifecycleGate(stateMachine);

    // ── Journal facade ──────────────────────────────────────────────
    const contextState = deps.contextState;
    const sessionJournal = deps.sessionJournal;
    const journalWriter = contextState.journalWriter;
    const journalCapability = deps.journalCapability ?? createStubJournalCapability();

    // ── Services facade ─────────────────────────────────────────────
    const orchestrator = deps.orchestrator;

    // ── Runtime (independent) ──────────────────────────────────────
    // Phase 2 narrowed Runtime to `{kosong}`. Phase 15 B.4 D1 wraps
    // the adapter in a `StreamingKosongWrapper` when an orchestrator
    // is available so concurrent-safe tool_use blocks can be
    // prefetched while the LLM is still streaming. When the caller
    // omits `orchestrator` (test harnesses, in-memory embedders) we
    // skip the wrapper so nothing breaks for them.
    const rawKosong = deps.runtime.kosong;
    const runtime: Runtime = {
      kosong:
        orchestrator !== undefined
          ? new StreamingKosongWrapper(rawKosong, orchestrator)
          : rawKosong,
    };
    const approvalRuntime = undefined; // Wiring lives on the orchestrator path today
    const compactionProvider = deps.compactionProvider ?? createStubCompactionProvider();
    const compaction = new CompactionOrchestrator({
      contextState,
      compactionProvider,
      lifecycleStateMachine: stateMachine,
      journalCapability,
      sink: eventBus,
      journalWriter,
      sessionId: deps.sessionId,
      agentId: 'agent_main',
    });
    const permissionBuilder = new PermissionClosureBuilder({
      ...(orchestrator !== undefined ? { orchestrator } : {}),
    });

    // ── Components facade ───────────────────────────────────────────
    const hasSubagentInfra =
      deps.subagentStore !== undefined && deps.agentTypeRegistry !== undefined;

    const soulRegistry = new SoulRegistry({
      createHandle: (key, agentDepth) => ({
        key,
        agentId: key === 'main' ? 'agent_main' : key.replace('sub:', ''),
        abortController: new AbortController(),
        // Phase 18 §E.2 — depth is plumbed in by the registry:
        // `getOrCreate('main')` defaults to 0; `spawn()` passes
        // `parentDepth + 1` for each `sub:*` child.
        agentDepth,
      }),
      // Phase 6 — SoulRegistry owns the subagent lifecycle journal
      // channel. It writes spawned/completed/failed around the runner
      // call; we therefore intentionally OMIT `parentSessionJournal`
      // from the runner deps below to avoid double-writes.
      parentSessionJournal: sessionJournal,
      ...(hasSubagentInfra
        ? {
            runSubagentTurn: (agentId, request, signal) =>
              runSubagentTurn(
                {
                  store: deps.subagentStore!,
                  typeRegistry: deps.agentTypeRegistry!,
                  parentTools: deps.tools,
                  parentRuntime: runtime,
                  // Phase 6 — preferred forwarding channel. The runner
                  // builds a `createSubagentSinkWrapper` that fans events
                  // out with a `source` envelope.
                  parentEventBus: eventBus,
                  // parentSessionJournal 故意不传：SoulRegistry 已经写
                  // lifecycle record（见 SoulRegistryDeps 上的
                  // parentSessionJournal 注入），同时让 runner 也写会双写。
                  sessionDir: deps.sessionDir ?? '',
                  parentModel: contextState.model,
                  workDir: deps.workDir ?? process.cwd(),
                  // Phase 6 — pass pathConfig + sessionId through so the
                  // child wire path follows the §9.5 path service.
                  ...(deps.pathConfig !== undefined
                    ? { pathConfig: deps.pathConfig }
                    : {}),
                  sessionId: deps.sessionId,
                },
                agentId,
                request,
                signal,
              ),
          }
        : {}),
    });

    if (hasSubagentInfra) {
      toolRegistry.push(new AgentTool(soulRegistry, 'agent_main'));
    }

    // ── Slice 7.1 (决策 #99) — SkillTool wiring ─────────────────────
    // Register the autonomous-invocation `Skill` tool only when a
    // SkillManager was supplied AND it has at least one skill the model
    // is allowed to invoke. The tool depends on `subagentHost` for
    // fork-mode skills, so AgentTool's `hasSubagentInfra` gate above
    // already guarantees `soulRegistry` is fully wired.
    if (deps.skillManager !== undefined) {
      const invocableCount = deps.skillManager.listInvocableSkills().length;
      if (invocableCount > 0) {
        const inlineWriter = new SkillInlineWriter({
          contextState,
          sessionJournal,
        });
        toolRegistry.push(
          new SkillTool({
            skillManager: deps.skillManager,
            inlineWriter,
            subagentHost: soulRegistry,
            // queryDepth defaults to 0 at the top level; nested skill
            // calls receive their depth via SpawnRequest.skillContext.
          }),
        );
      }
    }

    const dynamicInjectionManager = createDefaultDynamicInjectionManager();
    const wakeScheduler = new WakeQueueScheduler();
    const turnLifecycle = new TurnLifecycleTracker();

    const turnManager = new TurnManager({
      contextState,
      sessionJournal,
      runtime,
      sink: eventBus,
      lifecycleStateMachine: stateMachine,
      soulRegistry,
      tools: toolRegistry,
      compaction,
      permissionBuilder,
      lifecycle: turnLifecycle,
      wakeScheduler,
      dynamicInjectionManager,
      sessionId: deps.sessionId,
      ...(deps.compactionConfig !== undefined ? { compactionConfig: deps.compactionConfig } : {}),
      ...(orchestrator !== undefined ? { orchestrator } : {}),
    });

    // NotificationManager — Slice 2.4 three-sink fan-out. Phase 1
    // (Decision #89): notifications land in durable contextState history
    // rather than an ephemeral stash.
    const notificationManager = new NotificationManager({
      sessionJournal,
      sessionEventBus: eventBus,
      contextState,
      ...(deps.onShellDeliver !== undefined ? { onShellDeliver: deps.onShellDeliver } : {}),
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    });

    // ── Phase 16 — SessionMetaService (services facade slot) ───────
    // Wired only when the host supplies both `stateCache` and
    // `initialMeta` (production path: SessionManager). Test harnesses
    // that construct SoulPlus directly without state.json plumbing
    // leave the slot undefined — Soul never sees sessionMeta either
    // way (铁律 6).
    const sessionMeta =
      deps.stateCache !== undefined && deps.initialMeta !== undefined
        ? new SessionMetaService({
            sessionId: deps.sessionId,
            sessionJournal,
            eventBus,
            stateCache: deps.stateCache,
            initialMeta: deps.initialMeta,
          })
        : undefined;

    // ── Assemble facades ────────────────────────────────────────────
    this.lifecycle = { stateMachine, gate };
    this.journal = {
      writer: journalWriter,
      contextState,
      sessionJournal,
      capability: journalCapability,
    };
    this.services = {
      orchestrator,
      approvalRuntime,
      compaction,
      permissionBuilder,
      sessionMeta,
    };
    this.components = {
      turnManager,
      soulRegistry,
      skillManager: deps.skillManager,
      notificationManager,
      wakeScheduler,
      turnLifecycle,
    };
    this.infra = {
      eventBus,
      toolRegistry,
      permissionRules,
      hookEngine: undefined,
    };

    // Phase 18 L2-6 — bridge `ApprovalStateStore.setYolo` → live
    // TurnManager permission mode flip. Without this listener, a
    // wire `session.setYolo` would only persist the flag; tools
    // launched in the SAME turn would still see the old
    // permission mode. The listener is first-wins per onChanged
    // dispatch; listener errors are isolated at the store layer
    // (see `approval-state-store.ts::ChangeListenerRegistry`).
    if (deps.approvalStateStore !== undefined) {
      deps.approvalStateStore.onChanged((snapshot) => {
        turnManager.setPermissionMode(
          snapshot.yolo ? 'bypassPermissions' : 'default',
        );
      });
    }
  }

  /**
   * Slice 7.1 (决策 #99) — async initialisation hook called by
   * SessionManager (`createSession` / `resumeSession`) after construction
   * but before the session goes hot.
   *
   * Current responsibilities:
   *   - Inject the durable `<system-reminder>` skill listing into
   *     ContextState so the next `buildMessages()` surfaces every
   *     invocable skill to the model. No-op when no SkillManager was
   *     supplied or no skill is invocable.
   *
   * Safe to call more than once; later calls re-inject a fresh listing
   * (the `DISREGARD any earlier skill listings` preamble is what makes
   * the model ignore stale entries).
   */
  async init(): Promise<void> {
    const skillManager = this.components.skillManager;
    if (skillManager !== undefined) {
      await skillManager.injectSkillListing(this.journal.contextState);
    }
  }

  // ── Slice 7.1 test/inspection helper ─────────────────────────────────

  /** Read-only view of the assembled tool list (post SkillTool wiring). */
  getTools(): readonly Tool[] {
    return this.infra.toolRegistry;
  }

  /**
   * Phase 18 A.8 — dynamic tool management hooks. The tool registry is
   * a mutable array owned by SoulPlus; new tools added here show up on
   * the next `launchTurn` because TurnManager reads through the same
   * reference at turn-start time.
   *
   * Journals a `tools_changed` record so wire.jsonl reflects the
   * mutation.
   */
  async registerDynamicTool(tool: Tool): Promise<void> {
    const registry = this.infra.toolRegistry as Tool[];
    const existing = registry.findIndex((t) => t.name === tool.name);
    if (existing !== -1) {
      registry.splice(existing, 1, tool);
    } else {
      registry.push(tool);
    }
    await this.journal.contextState.applyConfigChange({
      type: 'tools_changed',
      operation: 'register',
      tools: [tool.name],
    });
  }

  /** Phase 18 A.8 — remove a previously registered tool. */
  async removeDynamicTool(name: string): Promise<void> {
    const registry = this.infra.toolRegistry as Tool[];
    const idx = registry.findIndex((t) => t.name === name);
    if (idx === -1) return;
    registry.splice(idx, 1);
    await this.journal.contextState.applyConfigChange({
      type: 'tools_changed',
      operation: 'remove',
      tools: [name],
    });
  }

  /**
   * Phase 18 A.8 — narrow the active tool set to the supplied names.
   * Writes the canonical `tools_changed{operation:'set_active'}`
   * record; ContextState's projection updates `_activeTools` so
   * downstream code sees only the narrowed set.
   */
  async setActiveTools(names: readonly string[]): Promise<void> {
    await this.journal.contextState.applyConfigChange({
      type: 'tools_changed',
      operation: 'set_active',
      tools: [...names],
    });
  }

  // ── Slice 2.4 public API ─────────────────────────────────────────────

  /**
   * Inject a system reminder into the next Soul turn (§3.5 wire method
   * `session.addSystemReminder`). Delegates to the journal facade's
   * contextState so the record is durable before the next buildMessages
   * call (Phase 1 / 决策 #89).
   */
  async addSystemReminder(text: string): Promise<void> {
    await this.journal.contextState.appendSystemReminder({ content: text });
  }

  /**
   * Emit a full NotificationData through the three-sink fan-out
   * (Slice 2.4). Thin pass-through to NotificationManager so callers can
   * use the SoulPlus facade as the single entry point.
   */
  emitNotification(
    input: Parameters<NotificationManager['emit']>[0],
  ): ReturnType<NotificationManager['emit']> {
    return this.components.notificationManager.emit(input);
  }

  /** Test / inspection helper — exposes the manager for fine-grained assertions. */
  getNotificationManager(): NotificationManager {
    return this.components.notificationManager;
  }

  /** Test / inspection helper — exposes the TurnManager. */
  getTurnManager(): TurnManager {
    return this.components.turnManager;
  }

  /**
   * Phase 16 / 决策 #113 — access the SessionMetaService. Throws when
   * the service was not wired (see `SoulPlusDeps.stateCache` /
   * `initialMeta` requirements). SessionManager always wires it on
   * create / resume paths; tests that need it must plumb through as
   * well.
   */
  getSessionMeta(): SessionMetaService {
    const svc = this.services.sessionMeta;
    if (svc === undefined) {
      throw new Error(
        'SoulPlus.getSessionMeta: SessionMetaService was not wired (missing stateCache / initialMeta in SoulPlusDeps)',
      );
    }
    return svc;
  }

  /**
   * Phase 16 — returns the service if wired, `undefined` otherwise.
   * Used by SessionManager.closeSession on the shutdown path where the
   * absence of a service must not throw (legacy tests without state
   * plumbing).
   */
  tryGetSessionMeta(): SessionMetaService | undefined {
    return this.services.sessionMeta;
  }

  // ── Slice 2.5 Skill public API ──────────────────────────────────────

  /**
   * Activate a skill by name (Slice 2.5 inline mode). Reads the
   * SKILL.md body from the registered `SkillDefinition`, interpolates
   * `args`, and appends the result as a user message on the session
   * ContextState so the next turn picks it up.
   */
  async activateSkill(name: string, args: string): Promise<void> {
    const skillManager = this.components.skillManager;
    if (skillManager === undefined) {
      throw new Error('SoulPlus.activateSkill: no SkillManager was provided in SoulPlusDeps');
    }
    // Slice 7.1 (决策 #99) — forward sessionJournal so `user-slash`
    // invocations land in wire.jsonl as `skill_invoked` records.
    await skillManager.activate(name, args, {
      contextState: this.journal.contextState,
      sessionJournal: this.journal.sessionJournal,
    });
  }

  /**
   * Returns the SkillManager bound to this session, or `undefined` when
   * the host did not supply one.
   */
  getSkillManager(): SkillManager | undefined {
    return this.components.skillManager;
  }

  /**
   * Phase 18 A.3–A.6 — access (or lazily create) the canonical session
   * config-channel handler. Returns the same handler instance on every
   * call for the lifetime of this SoulPlus.
   */
  getSessionControl(): SessionControlHandler {
    if (this.sessionControlInstance !== undefined) return this.sessionControlInstance;
    this.sessionControlInstance = new DefaultSessionControl({
      turnManager: this.components.turnManager,
      contextState: this.journal.contextState,
      sessionJournal: this.journal.sessionJournal,
    });
    return this.sessionControlInstance;
  }

  /**
   * Phase 18 A.3 — programmatic model change. Applies the config
   * change event to ContextState (WAL `model_changed`) and emits a
   * fresh `status.update` so downstream observers pick up the new
   * model without waiting for the next turn boundary.
   */
  async setModel(model: string): Promise<void> {
    const oldModel = this.journal.contextState.model;
    if (oldModel === model) return;
    await this.journal.contextState.applyConfigChange({
      type: 'model_changed',
      old_model: oldModel,
      new_model: model,
    });
    // Emit a status.update snapshot so wire consumers / TUI updates
    // immediately reflect the new model. Zero token_usage here — we
    // do not yet know the next-turn usage at setter time.
    this.components.turnManager.emitStatusUpdate({ input: 0, output: 0 });
  }

  /**
   * Phase 18 A.6 — programmatic thinking-level change. Journals a
   * `thinking_changed` WAL record (via ContextState.applyConfigChange)
   * and emits a `thinking.changed` SoulEvent; wire consumers translate
   * this into the `thinking.changed` wire event.
   */
  async setThinking(level: string): Promise<void> {
    await this.journal.contextState.applyConfigChange({
      type: 'thinking_changed',
      level,
    });
    // Emit a status.update snapshot so the thinking change is visible
    // on the same channel as the other setters.
    this.components.turnManager.emitStatusUpdate({ input: 0, output: 0 });
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResponse> {
    switch (request.method) {
      case 'session.prompt':
        return this.components.turnManager.handlePrompt({ data: request.data });
      case 'session.cancel':
        return this.components.turnManager.handleCancel({ data: request.data });
      case 'session.steer':
        return this.components.turnManager.handleSteer({ data: request.data });
      default: {
        const _exhaustive: never = request;
        void _exhaustive;
        return { error: 'method_not_found' };
      }
    }
  }
}
