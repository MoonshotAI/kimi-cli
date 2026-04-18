/**
 * KimiCoreClient — the WireClient implementation backed by real kimi-core.
 *
 * Slice 4.2 rewrite of the Slice 4.1 bridge. Major changes:
 *
 *   1. `SessionEventBus` listener → `SoulEvent` → `WireMessage` via
 *      `adaptSoulEventToWireMessage`. `tool.result` is now part of the
 *      `SoulEvent` union so every `appendToolResult` call site (normal
 *      + synthetic) surfaces through the adapter — the Slice 4.1
 *      per-tool `wrapToolWithResultEmitter` is deleted entirely.
 *   2. `prompt()` used to synthesise `turn.begin` / `turn.end` via a
 *      40 ms `setInterval` poll on `TurnManager.getCurrentTurnId()`.
 *      Slice 4.2 replaces the poll with
 *      `TurnManager.addTurnLifecycleListener`, a synchronous observer
 *      that fires `begin` right after `transitionTo('active')` and
 *      `end` inside `onTurnEnd`'s `finally` after the 3-hop drain.
 *      This closes the back-to-back race where two prompts <40 ms
 *      apart could share a single poll tick.
 *   3. Approval runtime is a real `TUIApprovalRuntime` per session;
 *      `respondToRequest` routes user responses into
 *      `runtime.resolveFromClient`. Question runtime is still the
 *      `AlwaysSkipQuestionRuntime` stub — Slice 4.3 introduces the
 *      `QuestionDialog` TUI component and the matching bridge.
 *   4. The client constructs a per-session `ToolCallOrchestrator`
 *      (with a HookEngine, the TUIApprovalRuntime, and the session
 *      agent id) and passes it through `createSession` /
 *      `resumeSession` so `TurnManager.buildBeforeToolCall` runs the
 *      real Hook → Permission → Approval pipeline.
 */

import {
  CommandHookExecutor,
  HookEngine,
  SessionEventBus,
  SkillNotFoundError,
  ToolCallOrchestrator,
  parseHookConfigs,
  type AgentTypeRegistry,
  type HookExecutor,
  type ManagedSession,
  type NotificationData,
  type PermissionMode,
  type QuestionRuntime,
  type Runtime,
  type SessionControlHandler,
  type SessionManager,
  type ShellDeliverCallback,
  type SkillManager,
  type SoulEvent,
  type BusEvent,
  type Tool,
  type TurnLifecycleListener,
  type TurnManager,
} from '@moonshot-ai/core';

import type { SlashCommandResult, WireClient } from './client.js';
import { adaptSoulEventToWireMessage } from './event-adapter.js';
import type {
  InitializeParams,
  InitializeResult,
  SessionInfo,
  SessionStatusResult,
  SessionUsageResult,
} from './methods.js';
import { TUIApprovalRuntime } from './tui-approval-runtime.js';
import { TUIQuestionRuntime } from './tui-question-runtime.js';
import { createEvent, type WireMessage } from './wire-message.js';

// ── Client session record ──────────────────────────────────────────

interface CumulativeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface ClientSession {
  readonly sessionId: string;
  readonly managed: ManagedSession;
  readonly queue: WireEventQueue;
  readonly eventBus: SessionEventBus;
  readonly approvalRuntime: TUIApprovalRuntime;
  readonly questionRuntime: TUIQuestionRuntime;
  readonly unsubscribeLifecycle: () => void;
  seqCounter: number;
  currentTurnId: string | undefined;
  cumulativeUsage: CumulativeUsage;
}

/**
 * Context passed to {@link KimiCoreClientDeps.buildTools}. Callers use
 * this to wire per-session dependencies into tools that cannot be
 * constructed statically — AskUserQuestionTool needs a QuestionRuntime
 * bound to this session, and ExitPlanModeTool needs the session's
 * SessionControl. Closures are late-bound because the ManagedSession
 * (and thus its SessionControl) only exists after kimi-core returns,
 * while the tools must be supplied ahead of that call.
 */
export interface PerSessionToolContext {
  readonly questionRuntime: QuestionRuntime;
  readonly getPermissionMode: () => PermissionMode;
  readonly isPlanModeActive: () => boolean;
  readonly setPlanMode: (enabled: boolean) => Promise<void>;
}

/**
 * Parse trailing toggle arguments for `/plan` / `/yolo`. An empty arg
 * list resolves to `defaultValue` (so `/plan` alone enables plan mode).
 * Recognised tokens: `on` / `true` / `yes` → true; `off` / `false` /
 * `no` → false. Anything else throws so the slash handler can report
 * `ok: false` with a clear message instead of silently enabling.
 */
/**
 * Slice 5.1 (Codex M6) — normalize a timestamp value to unix seconds.
 *
 * Internal SessionManager mixes `Date.now()` (milliseconds) for
 * created_at/updated_at and file mtime (already seconds via the
 * Math.floor(mtimeMs / 1000) computed in listSessions) for
 * last_activity. The wire layer always reports seconds. Anything > 1e12
 * is assumed to be ms (post-2001 epoch in ms is ~1e12+); anything else
 * is treated as already-seconds.
 */
function toUnixSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1e12 ? Math.floor(value / 1000) : value;
}

function parseToggle(args: readonly string[], defaultValue: boolean): boolean {
  if (args.length === 0) return defaultValue;
  const first = args[0]!.toLowerCase();
  if (first === 'off' || first === 'false' || first === 'no') return false;
  if (first === 'on' || first === 'true' || first === 'yes') return true;
  throw new Error(
    `Unknown toggle value: "${args[0]!}" (expected on / off / true / false / yes / no)`,
  );
}

// ── Deps ────────────────────────────────────────────────────────────

export interface KimiCoreClientDeps {
  /** Real session manager from @moonshot-ai/core. */
  readonly sessionManager: SessionManager;
  /** Runtime factory — caller supplies ready kosong + stubs. */
  readonly runtime: Runtime;
  /**
   * Phase 2 — compaction provider used by `TurnManager.executeCompaction`.
   * Must be forwarded separately now that `Runtime` collapsed to
   * `{kosong}`. Optional so tests that don't exercise compaction keep
   * compiling; the CLI production path supplies a real Kosong-backed
   * provider.
   */
  readonly compactionProvider?: import('@moonshot-ai/core').CompactionProvider | undefined;
  /**
   * Phase 2 — journal capability used by `TurnManager.executeCompaction`.
   * Same optional semantics as `compactionProvider`.
   */
  readonly journalCapability?: import('@moonshot-ai/core').JournalCapability | undefined;
  /** Model name recorded on the session (transcript / state.json). */
  readonly model: string;
  /** Assembled system prompt from the agent layer. */
  readonly systemPrompt: string;
  /** Kaos instance for CommandHookExecutor subprocess execution. */
  readonly kaos: import('@moonshot-ai/kaos').Kaos;
  /** Loaded KimiConfig (for hook definitions). */
  readonly config: import('@moonshot-ai/core').KimiConfig;
  /**
   * Factory invoked once per session with the per-session tool
   * context. Tools that require session-local state (AskUserQuestion,
   * ExitPlanMode, ...) close over the context; purely static tools
   * (Read, Write, Bash, ...) ignore it. The factory is called BEFORE
   * `SessionManager.createSession` / `.resumeSession` so the returned
   * tools are available on the very first Soul turn.
   */
  readonly buildTools: (ctx: PerSessionToolContext) => readonly Tool[];
  /**
   * Slice 4.4 — Skill subsystem. When set, `/skill <name>` activates
   * a registered skill by appending its SKILL.md body onto the
   * session's ContextState. `getKimiSkillsDescription()` is injected
   * into the system prompt by `bootstrapCoreShell` upstream so the
   * LLM can see the available skills.
   */
  readonly skillManager?: SkillManager | undefined;
  /** Model's context window size in tokens. Used for compaction + status display. */
  readonly maxContextSize?: number | undefined;
  /**
   * Host-supplied factory for rebuilding the Runtime when the user
   * switches models. When omitted, `switchModel` throws "not supported".
   */
  readonly rebuildRuntimeForModel?: RuntimeForModelFactory | undefined;
  /**
   * Slice 5.3 — subagent type registry loaded by the app from the
   * bundled / `--agent-file` agent.yaml (see `loadSubagentTypes`). When
   * present, SessionManager wires the `Agent` collaboration tool into
   * SoulPlus so the LLM can spawn subagents. When absent, the feature
   * is silently disabled (embedders that intentionally do not want
   * subagents simply omit the field).
   */
  readonly agentTypeRegistry?: AgentTypeRegistry | undefined;
}

// ── KimiCoreClient ─────────────────────────────────────────────────

/**
 * Factory returned by the host so `KimiCoreClient.switchModel` can
 * rebuild the per-runtime state without knowing how to assemble a
 * provider itself. Capture `kimiConfig`, OAuth resolver, version
 * headers etc. in the closure; return a fresh Runtime + companions.
 */
export interface RebuildRuntimeResult {
  runtime: Runtime;
  compactionProvider?: import('@moonshot-ai/core').CompactionProvider | undefined;
  maxContextSize?: number | undefined;
}
export type RuntimeForModelFactory = (modelAlias: string) => Promise<RebuildRuntimeResult>;

export class KimiCoreClient implements WireClient {
  private readonly deps: KimiCoreClientDeps;
  private readonly sessions = new Map<string, ClientSession>();
  // Live (mutable) copies of the runtime / model / maxContextSize
  // originally supplied via deps. `switchModel` replaces these so
  // subsequent session creation + resume picks up the new Provider.
  private runtime: Runtime;
  private model: string;
  private compactionProvider: import('@moonshot-ai/core').CompactionProvider | undefined;
  private maxContextSize: number | undefined;
  // Phase 21 §D.4 — cached initialize response so `/hooks` can read
  // `capabilities.hooks.configured[]` without a round-trip; populated on
  // the first `initialize()` call (or lazily via `getInitializeResponse`).
  private cachedInitializeResponse: InitializeResult | undefined;

  constructor(deps: KimiCoreClientDeps) {
    this.deps = deps;
    this.runtime = deps.runtime;
    this.model = deps.model;
    this.compactionProvider = deps.compactionProvider;
    this.maxContextSize = deps.maxContextSize;
  }

  // ── Handshake ───────────────────────────────────────────────────

  async initialize(_params: InitializeParams): Promise<InitializeResult> {
    const response = this.buildInitializeResponse();
    this.cachedInitializeResponse = response;
    return response;
  }

  getInitializeResponse(): InitializeResult | undefined {
    if (this.cachedInitializeResponse === undefined) {
      // Lazy: `/hooks` asks for hooks capability before the CLI calls
      // `initialize()`. Build + cache on demand so the slash handler
      // does not have to wait for an explicit handshake.
      this.cachedInitializeResponse = this.buildInitializeResponse();
    }
    return this.cachedInitializeResponse;
  }

  private buildInitializeResponse(): InitializeResult {
    const parsed = parseHookConfigs(this.deps.config.hooks);
    const configured = parsed.map((h) => ({
      event: h.event,
      command: h.command,
      ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
    }));
    return {
      protocol_version: '2.1',
      capabilities: {
        hooks: {
          configured,
        },
      },
    };
  }

  // ── Session management ──────────────────────────────────────────

  async createSession(workDir: string): Promise<{ session_id: string }> {
    return this.registerManagedSession({ kind: 'create', workDir });
  }

  async resumeSession(sessionId: string): Promise<{ session_id: string }> {
    return this.registerManagedSession({ kind: 'resume', sessionId });
  }

  private async registerManagedSession(
    mode: { kind: 'create'; workDir: string } | { kind: 'resume'; sessionId: string },
  ): Promise<{ session_id: string }> {
    const queue = new WireEventQueue();
    const eventBus = new SessionEventBus();

    // The session id is only known AFTER `createSession` / `resumeSession`
    // resolves (for `create` the id is allocated inside kimi-core; for
    // `resume` the caller passes it in). Allocation of the approval
    // runtime + orchestrator needs that id so `TUIApprovalRuntime.emit`
    // can stamp the envelope correctly. We capture a late-bound ref
    // and thread it into the runtime's `sessionId` accessor, then the
    // orchestrator, and finally wire the ref once the ManagedSession
    // is constructed.
    const sessionRef: { current: ClientSession | null } = { current: null };

    const approvalRuntime = new TUIApprovalRuntime({
      // Late-bound session id: the real id is allocated inside
      // `sessionManager.createSession` which is awaited below, so
      // the runtime reads it lazily via a closure over `sessionRef`.
      sessionId: () => sessionRef.current?.sessionId ?? '',
      emit: (msg) => {
        const session = sessionRef.current;
        if (session !== null) {
          session.queue.push(msg);
        }
      },
      currentTurnId: () => sessionRef.current?.currentTurnId,
      // On `approve_for_session`, append a session-runtime rule so the
      // next same-action tool call short-circuits through the permission
      // walk instead of prompting the user again. The turn manager only
      // exists after `sessionManager.createSession` resolves; approvals
      // are always emitted mid-turn (i.e. after that), so sessionRef is
      // guaranteed to be populated by the time this closure fires.
      ruleInjector: (rule) => {
        const session = sessionRef.current;
        if (session === null) return;
        session.managed.soulPlus.getTurnManager().addSessionRule(rule);
      },
    });

    // Slice 4.3 Part 2 — per-session question runtime, same late-bound
    // emit + session id pattern as the approval runtime.
    const questionRuntime = new TUIQuestionRuntime({
      sessionId: () => sessionRef.current?.sessionId ?? '',
      emit: (msg) => {
        const session = sessionRef.current;
        if (session !== null) {
          session.queue.push(msg);
        }
      },
      currentTurnId: () => sessionRef.current?.currentTurnId,
    });

    // Slice 4.3 Part 4 — build the session-scoped tool set via the
    // host-supplied factory. Closures read through `sessionRef` so they
    // see the real ManagedSession after it is constructed below; the
    // tool constructors run now (factory) but `execute()` only fires
    // mid-turn, by which point sessionRef is populated.
    const getTurnManagerOrThrow = (): TurnManager => {
      const session = sessionRef.current;
      if (session === null) {
        throw new Error(
          'KimiCoreClient: session not yet constructed — tool invoked before bootstrap completed',
        );
      }
      return session.managed.soulPlus.getTurnManager();
    };
    const getSessionControlOrThrow = (): SessionControlHandler => {
      const session = sessionRef.current;
      if (session === null) {
        throw new Error(
          'KimiCoreClient: session not yet constructed — tool invoked before bootstrap completed',
        );
      }
      return session.managed.sessionControl;
    };
    const perSessionCtx: PerSessionToolContext = {
      questionRuntime,
      getPermissionMode: () => getTurnManagerOrThrow().getPermissionMode(),
      isPlanModeActive: () => getTurnManagerOrThrow().getPlanMode(),
      setPlanMode: async (enabled: boolean) => {
        await getSessionControlOrThrow().setPlanMode(enabled);
      },
    };
    const sessionTools = this.deps.buildTools(perSessionCtx);

    // Slice 4.4 Part 2 — shell-target notifications fire through this
    // callback, which converts each NotificationData into a wire
    // `notification` event and pushes it onto the session queue. The
    // TUI's `useWire` hook renders the event as a toast.
    const onShellDeliver: ShellDeliverCallback = (notif: NotificationData) => {
      const session = sessionRef.current;
      if (session === null) return;
      const wireNotif = {
        id: notif.id,
        category: notif.category,
        type: notif.type,
        title: notif.title,
        body: notif.body,
        severity: notif.severity,
        targets: [...notif.targets],
        ...(notif.dedupe_key !== undefined ? { dedupe_key: notif.dedupe_key } : {}),
      };
      session.queue.push(
        createEvent('notification', wireNotif, {
          session_id: session.sessionId,
          ...(session.currentTurnId !== undefined ? { turn_id: session.currentTurnId } : {}),
          seq: (session.seqCounter += 1),
        }),
      );
    };

    // Slice 5.5 — load hook configs from settings and register CommandHookExecutor.
    // Hooks are defined as [[hooks]] entries in config.toml (Python parity).
    const commandExecutor = new CommandHookExecutor(this.deps.kaos);
    const hookEngine = new HookEngine({
      executors: new Map<string, HookExecutor>([['command', commandExecutor]]),
      // Phase 17 §B.7 — forward hook lifecycle to the event-bridge so
      // clients see `hook.triggered` / `hook.resolved` wire events.
      sink: eventBus,
    });
    const parsedHooks = parseHookConfigs(this.deps.config.hooks);
    for (const hook of parsedHooks) {
      hookEngine.register(hook);
    }

    const orchestrator = new ToolCallOrchestrator({
      hookEngine,
      // Late-bound session id: the orchestrator evaluates the closure
      // fresh on each hook input payload, so the real id populated by
      // `SessionManager.createSession` (or passed in by `resumeSession`)
      // still lands on every PreToolUse / PostToolUse / OnToolFailure
      // hook input without us mutating any orchestrator internals.
      // Fallback to `mode.sessionId` on resume (which is known up
      // front) or `'session_pending'` on the very short window between
      // orchestrator construction and SessionManager returning.
      sessionId: () =>
        sessionRef.current?.sessionId ??
        (mode.kind === 'resume' ? mode.sessionId : 'session_pending'),
      agentId: 'agent_main',
      approvalRuntime,
    });

    const commonOptions = {
      runtime: this.runtime,
      tools: [...sessionTools],
      model: this.model,
      systemPrompt: this.deps.systemPrompt,
      eventBus,
      orchestrator,
      onShellDeliver,
      ...(this.deps.skillManager !== undefined ? { skillManager: this.deps.skillManager } : {}),
      ...(this.maxContextSize !== undefined
        ? { compactionConfig: { maxContextSize: this.maxContextSize } }
        : {}),
      // Phase 2 — compaction capabilities promoted off of Runtime.
      ...(this.compactionProvider !== undefined
        ? { compactionProvider: this.compactionProvider }
        : {}),
      ...(this.deps.journalCapability !== undefined
        ? { journalCapability: this.deps.journalCapability }
        : {}),
      // Slice 5.3 — forward the subagent type registry so SessionManager
      // can wire the `Agent` collaboration tool.
      ...(this.deps.agentTypeRegistry !== undefined
        ? { agentTypeRegistry: this.deps.agentTypeRegistry }
        : {}),
    };

    const managed =
      mode.kind === 'create'
        ? await this.deps.sessionManager.createSession({
            ...commonOptions,
            workspaceDir: mode.workDir,
          })
        : await this.deps.sessionManager.resumeSession(mode.sessionId, commonOptions);
    const managedId = managed.sessionId;

    // Subscribe to TurnManager lifecycle BEFORE fanning SoulEvents so
    // the first `begin` cannot race with a SoulEvent that depends on
    // `currentTurnId` being set.
    const turnManager = managed.soulPlus.getTurnManager();
    const unsubscribeLifecycle = subscribeLifecycle(
      turnManager,
      (msg) => {
        queue.push(msg);
      },
      () => sessionRef.current,
      (session, usage) => {
        if (usage !== undefined) {
          session.cumulativeUsage.inputTokens += usage.input;
          session.cumulativeUsage.outputTokens += usage.output;
          session.cumulativeUsage.cacheReadTokens += usage.cache_read ?? 0;
          session.cumulativeUsage.cacheWriteTokens += usage.cache_write ?? 0;
        }
        this.emitStatusUpdate(session);
      },
    );

    const record: ClientSession = {
      sessionId: managedId,
      managed,
      queue,
      eventBus,
      approvalRuntime,
      questionRuntime,
      unsubscribeLifecycle,
      seqCounter: 0,
      currentTurnId: undefined,
      cumulativeUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    sessionRef.current = record;
    this.sessions.set(managedId, record);

    // Fan SoulEvents → WireMessage → queue.
    //
    // Subagent events (source.kind === 'subagent') are wrapped in a
    // `subagent.event` envelope that carries the parent tool call id,
    // so the TUI can graft them onto the spawning tool call's block.
    // Main-agent events (source === undefined) flow through unchanged.
    eventBus.on((event: BusEvent) => {
      const ctx = {
        sessionId: record.sessionId,
        turnId: record.currentTurnId,
        nextSeq: () => (record.seqCounter += 1),
      };

      if (event.source !== undefined && event.source.kind === 'subagent') {
        const parentId = event.source.parent_tool_call_id;
        if (parentId === undefined) return;
        const inner = adaptSoulEventToWireMessage(event, ctx);
        if (inner === null || inner.type !== 'event') return;
        const envelope = createEvent(
          'subagent.event',
          {
            parent_tool_call_id: parentId,
            agent_id: event.source.id,
            ...(event.source.name !== undefined ? { agent_name: event.source.name } : {}),
            sub_event: { method: inner.method, data: inner.data },
          },
          {
            session_id: record.sessionId,
            ...(record.currentTurnId !== undefined ? { turn_id: record.currentTurnId } : {}),
            seq: (record.seqCounter += 1),
          },
        );
        queue.push(envelope);
        return;
      }

      const msg = adaptSoulEventToWireMessage(event, ctx);
      if (msg !== null) {
        queue.push(msg);
      }
      if (event.type === 'step.end') {
        this.emitStatusUpdate(record);
      }
    });

    return { session_id: managedId };
  }

  async listSessions(): Promise<{ sessions: SessionInfo[] }> {
    const records = await this.deps.sessionManager.listSessions();
    const sessions: SessionInfo[] = records.map((info) => ({
      id: info.session_id,
      work_dir: info.workspace_dir ?? '',
      // Slice 5.1: SessionManager populates `title` from state.custom_title;
      // forward as null when absent (wire schema requires nullable, not
      // optional).
      title: info.title ?? null,
      // Slice 5.1 (Codex M6): wire timestamps are unix seconds. Internal
      // state.json keeps ms (Date.now()) for backward compat with
      // existing on-disk sessions; we normalize to seconds here so
      // `created_at` and `updated_at` share units across all responses.
      // Heuristic: numbers > 1e12 are ms (post-2001 in ms), <= 1e12 are
      // seconds — covers both old (ms) and new (sec from mtime) formats.
      created_at: toUnixSeconds(info.created_at),
      // Prefer state.json mtime as last-activity proxy; fall back to
      // created_at for sessions whose state.json never landed.
      updated_at: toUnixSeconds(info.last_activity ?? info.created_at),
      archived: false,
    }));
    return { sessions };
  }

  async destroySession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record !== undefined) {
      record.unsubscribeLifecycle();
      record.approvalRuntime.disposeAll('session destroyed');
      record.questionRuntime.disposeAll();
      record.queue.close();
      this.sessions.delete(sessionId);
    }
    await this.deps.sessionManager.closeSession(sessionId);
  }

  // ── Conversation ────────────────────────────────────────────────

  async prompt(sessionId: string, input: string): Promise<{ turn_id: string }> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`KimiCoreClient: unknown session ${sessionId}`);
    }

    const response = await record.managed.soulPlus.dispatch({
      method: 'session.prompt',
      data: { input: { text: input } },
    });

    if ('error' in response) {
      throw new Error(`kimi-core rejected prompt: ${response.error}`);
    }
    if (!('turn_id' in response)) {
      throw new Error('kimi-core prompt response missing turn_id');
    }

    // The lifecycle observer already emitted `turn.begin` synchronously
    // during `handlePrompt`, so no synthetic fabrication is needed here.
    // We still track `currentTurnId` on the record so mid-turn SoulEvents
    // pick up the right envelope `turn_id`.
    const turnId = response.turn_id;
    return { turn_id: turnId };
  }

  async steer(sessionId: string, input: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    await record.managed.soulPlus.dispatch({
      method: 'session.steer',
      data: { input: { text: input } },
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    await record.managed.soulPlus.dispatch({
      method: 'session.cancel',
      data: {},
    });
  }

  async resume(_sessionId: string): Promise<void> {
    // No-op in Slice 4.1 — resume flow is Slice 4.3.
  }

  // ── Management ──────────────────────────────────────────────────

  async fork(sessionId: string, _atTurn?: number): Promise<{ session_id: string }> {
    // Slice 4.3 — fork not implemented yet. Return the same id so the
    // TUI does not crash when the user types /fork.
    return { session_id: sessionId };
  }

  async rename(sessionId: string, title: string): Promise<void> {
    // Slice 5.1 — persists user-set title via SessionManager.
    await this.deps.sessionManager.renameSession(sessionId, title);
  }

  async getStatus(sessionId: string): Promise<SessionStatusResult> {
    // Slice 5.1 — read from SessionLifecycleStateMachine (live) or
    // state.json (persisted), no longer hardcoded.
    const state = await this.deps.sessionManager.getSessionStatus(sessionId);
    return { state };
  }

  async getUsage(sessionId: string): Promise<SessionUsageResult> {
    // Slice 5.1 — replay wire.jsonl turn_end records (5s cached).
    return this.deps.sessionManager.getSessionUsage(sessionId);
  }

  async compact(sessionId: string, customInstruction?: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    await record.managed.sessionControl.compact(customInstruction);
  }

  async clear(sessionId: string): Promise<void> {
    // Phase 20 §A — delegate to SessionControl.clear(), which awaits the
    // WAL `context_cleared` append before zeroing the in-memory history.
    // Silently no-op for unknown sessions so a stale `/clear` after a
    // session change does not surface a generic error to the TUI.
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    await record.managed.sessionControl.clear();
  }

  // ── Phase 21 §D.1 — /undo ───────────────────────────────────────

  /**
   * Wire bridge for `session.rollback`. The core handler rewrites
   * wire.jsonl and returns the new turn count; callers re-open the
   * session (via `resumeSession`) afterwards so the in-memory state
   * reflects the truncated history.
   */
  async rollback(
    sessionId: string,
    nTurnsBack: number,
  ): Promise<{ new_turn_count: number }> {
    return this.deps.sessionManager.rollbackSession(sessionId, nTurnsBack);
  }

  // ── Phase 21 §D.2 — skill dispatch ──────────────────────────────

  async listSkills(
    sessionId: string,
  ): Promise<{ skills: ReadonlyArray<{ name: string; description: string }> }> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return { skills: [] };
    const skillManager = record.managed.soulPlus.getSkillManager();
    if (skillManager === undefined) return { skills: [] };
    const skills = skillManager
      .listInvocableSkills()
      .map((s) => ({ name: s.name, description: s.description }));
    return { skills };
  }

  async activateSkill(sessionId: string, name: string, args: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    await record.managed.soulPlus.activateSkill(name, args);
  }

  // ── Slice 5.2 — resume-time plan mode conflict (D4) ─────────────

  /**
   * Check whether the CLI `--plan` flag conflicts with the session's
   * persisted plan mode and, if so, schedule a system reminder for the
   * LLM's next turn so the user is informed of the override.
   *
   * Call from `bootstrapCoreShell` after resume; no-op for new sessions.
   */
  async schedulePlanModeReminder(
    sessionId: string,
    cliPlanFlag: boolean,
  ): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    const turnManager = record.managed.soulPlus.getTurnManager();
    const persisted = turnManager.getPlanMode();
    if (cliPlanFlag && !persisted) {
      // N1: activate plan mode BEFORE writing the reminder so a WAL
      // failure in setPlanMode doesn't leave an orphaned reminder.
      await record.managed.sessionControl.setPlanMode(true);
      await record.managed.soulPlus.addSystemReminder(
        'The user started this session with --plan, but the session was ' +
        'not previously in plan mode. Plan mode is now activated.',
      );
    } else if (!cliPlanFlag && persisted) {
      await record.managed.soulPlus.addSystemReminder(
        'This session was previously in plan mode. Plan mode remains ' +
        'active from the prior session. Use /plan off to deactivate.',
      );
    }
  }

  // ── Configuration ───────────────────────────────────────────────

  async setModel(_sessionId: string, _model: string): Promise<void> {
    // Superseded by `switchModel`; the legacy WireClient.setModel is
    // kept for interface compatibility but delegates callers to the
    // higher-level helper because setting model alone without rebuilding
    // the Provider / Kosong adapter has no effect on the running LLM.
    throw new Error(
      'setModel is deprecated — use `switchModel(sessionId, modelAlias)` instead.',
    );
  }

  /**
   * Live model switch. Rebuilds the Provider/Kosong adapter via the
   * host-supplied `rebuildRuntimeForModel` factory, tears the old
   * ManagedSession down, and re-creates it with the new runtime under
   * the same `sessionId` so wire.jsonl / context state / workspace etc.
   * carry over untouched.
   *
   * Returns the (same) session id so callers can update UI state.
   */
  async switchModel(sessionId: string, modelAlias: string): Promise<{ session_id: string }> {
    if (this.deps.rebuildRuntimeForModel === undefined) {
      throw new Error('switchModel is not configured on this client (no rebuild factory).');
    }
    const { runtime, compactionProvider, maxContextSize } =
      await this.deps.rebuildRuntimeForModel(modelAlias);
    // Tear down current session first so resumeSession below hits a
    // clean slate inside SessionManager.
    await this.destroySession(sessionId);
    this.runtime = runtime;
    this.model = modelAlias;
    this.compactionProvider = compactionProvider;
    this.maxContextSize = maxContextSize;
    return this.resumeSession(sessionId);
  }
  async setThinking(_sessionId: string, _level: string): Promise<void> {}
  async setPlanMode(sessionId: string, enabled: boolean): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    await record.managed.sessionControl.setPlanMode(enabled);
  }
  async setYolo(sessionId: string, enabled: boolean): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;
    await record.managed.sessionControl.setYolo(enabled);
  }

  // ── Slash command dispatch (Slice 4.3 Part 1) ──────────────────

  /**
   * Dispatch a parsed slash command to the underlying kimi-core
   * session. Returns a user-facing result that the TUI can surface in
   * the transcript. Unknown commands return an error result instead of
   * throwing so the TUI loop stays responsive.
   *
   * Supported commands (Slice 4.3):
   *   /compact                     — trigger context compaction
   *   /clear                       — clear history (throws "not implemented")
   *   /plan [on|off]               — toggle plan mode (default: on)
   *   /yolo [on|off]               — toggle bypass-permissions (default: on)
   *   /agent <name>                — stub (returns "not implemented")
   *   /model <alias>               — stub (returns "not implemented")
   */
  async handleSlashCommand(
    sessionId: string,
    name: string,
    args: readonly string[],
  ): Promise<SlashCommandResult> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      return { ok: false, message: `Unknown session: ${sessionId}` };
    }
    const control = record.managed.sessionControl;
    const turnManager = record.managed.soulPlus.getTurnManager();

    try {
      switch (name) {
        case 'compact':
          await control.compact(args.length > 0 ? args.join(' ') : undefined);
          return { ok: true, message: 'Compacting context...' };
        case 'clear':
          await control.clear();
          return { ok: true, message: 'Context cleared.' };
        case 'plan': {
          const current = turnManager.getPlanMode();
          const enabled = args.length > 0 ? parseToggle(args, !current) : !current;
          await control.setPlanMode(enabled);
          // Read the post-change state back from the TurnManager so the
          // host mirrors whatever kimi-core actually committed — not
          // what the parsed args asked for. `setPlanMode` is
          // WAL-first, so the getter is the authoritative view.
          const planMode = turnManager.getPlanMode();
          return {
            ok: true,
            message: `Plan mode ${planMode ? 'enabled' : 'disabled'}.`,
            stateUpdate: { planMode },
          };
        }
        case 'yolo': {
          const currentYolo = turnManager.getPermissionMode() === 'bypassPermissions';
          const enabled = args.length > 0 ? parseToggle(args, !currentYolo) : !currentYolo;
          await control.setYolo(enabled);
          // Post-change read: TurnManager's permission mode is the
          // authoritative flag. `bypassPermissions` ⇒ yolo=true.
          const yolo = turnManager.getPermissionMode() === 'bypassPermissions';
          return {
            ok: true,
            message: `Yolo mode ${yolo ? 'enabled' : 'disabled'}.`,
            stateUpdate: { yolo },
          };
        }
        case 'agent':
          return {
            ok: false,
            message:
              'Agent switching is not yet implemented — restart with --agent <name> to change agents.',
          };
        case 'skill': {
          // Slice 4.4 Part 3 — `/skill <name> [args...]` activates a
          // registered skill. Inline mode only: SKILL.md body is
          // appended to ContextState as a user message on the next
          // prompt. No LLM turn is kicked off here — the user should
          // follow with a normal prompt (or pass args inline).
          if (this.deps.skillManager === undefined) {
            return {
              ok: false,
              message: 'Skill subsystem is not configured in this build.',
            };
          }
          if (args.length === 0) {
            const skills = this.deps.skillManager.listSkills();
            if (skills.length === 0) {
              return {
                ok: true,
                message: 'No skills registered. Add SKILL.md files under ~/.kimi/skills/<name>/.',
              };
            }
            const lines = skills.map((s) => `  - ${s.name}: ${s.description}`);
            return {
              ok: true,
              message: `Available skills:\n${lines.join('\n')}`,
            };
          }
          const [skillName, ...skillArgs] = args;
          try {
            await this.deps.skillManager.activate(skillName!, skillArgs.join(' '), {
              contextState: record.managed.contextState,
            });
            return { ok: true, message: `Skill "${skillName!}" activated.` };
          } catch (error) {
            if (error instanceof SkillNotFoundError) {
              return { ok: false, message: `Unknown skill: ${skillName!}` };
            }
            throw error;
          }
        }
        case 'model':
          return {
            ok: false,
            message:
              'Model switching is not yet implemented — restart with --model <alias> to change models.',
          };
        default:
          return { ok: false, message: `Unknown command: /${name}` };
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ── Event subscription ──────────────────────────────────────────

  subscribe(sessionId: string): AsyncIterable<WireMessage> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      // Return an empty iterable so the hook's `for await` exits quietly.
      return emptyAsyncIterable();
    }
    return record.queue;
  }

  // ── Bidirectional RPC ───────────────────────────────────────────

  respondToRequest(requestId: string, data: unknown): void {
    // Slice 4.2/4.3 — approval + question responses share the same
    // `respondToRequest` entry point since the TUI does not know which
    // runtime allocated the id. Each runtime's `resolveFromClient`
    // ignores unknown ids, so fanning the call to both is safe.
    for (const record of this.sessions.values()) {
      record.approvalRuntime.resolveFromClient(requestId, data);
      record.questionRuntime.resolveFromClient(requestId, data);
    }
  }

  // ── Status emission ─────────────────────────────────────────────

  private emitStatusUpdate(record: ClientSession): void {
    const tokens = record.managed.contextState.tokenCountWithPending;
    const maxTokens = this.maxContextSize ?? 0;
    const ratio = maxTokens > 0 ? Math.min(tokens / maxTokens, 1) : 0;
    // Phase 18 §A.14 froze `context_usage` as `{used, total, percent}`.
    const percent = Math.round(ratio * 100);
    record.queue.push(
      createEvent(
        'status.update',
        {
          context_usage: { used: tokens, total: maxTokens, percent },
          context_tokens: tokens,
          max_context_tokens: maxTokens,
        },
        {
          session_id: record.sessionId,
          ...(record.currentTurnId !== undefined ? { turn_id: record.currentTurnId } : {}),
          seq: (record.seqCounter += 1),
        },
      ),
    );
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async dispose(): Promise<void> {
    for (const record of this.sessions.values()) {
      record.unsubscribeLifecycle();
      record.approvalRuntime.disposeAll('client disposed');
      record.questionRuntime.disposeAll();
      record.queue.close();
      try {
        await this.deps.sessionManager.closeSession(record.sessionId);
      } catch {
        // closeSession is idempotent; swallow errors on shutdown.
      }
    }
    this.sessions.clear();
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function emptyAsyncIterable(): AsyncIterable<WireMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<WireMessage> {
      return {
        next: async (): Promise<IteratorResult<WireMessage>> => ({
          value: undefined as unknown as WireMessage,
          done: true,
        }),
      };
    },
  };
}

/**
 * Subscribe to `TurnManager.addTurnLifecycleListener` and translate each
 * event into a `turn.begin` / `turn.end` wire message. Replaces the
 * Slice 4.1 40 ms setInterval poll. The outer record may not yet be
 * populated when this helper is called (construction order), so the
 * listener reads the live ref via the passed getter.
 */
function subscribeLifecycle(
  turnManager: TurnManager,
  push: (msg: WireMessage) => void,
  getSession: () => ClientSession | null,
  onTurnEnd?: (session: ClientSession, usage?: { input: number; output: number; cache_read?: number | undefined; cache_write?: number | undefined }) => void,
): () => void {
  const listener: TurnLifecycleListener = (event) => {
    const session = getSession();
    if (session === null) return;
    if (event.kind === 'begin') {
      session.currentTurnId = event.turnId;
      push(
        createEvent(
          'turn.begin',
          {
            turn_id: event.turnId,
            user_input: event.userInputParts ?? event.userInput,
            input_kind: event.inputKind,
          },
          {
            session_id: session.sessionId,
            turn_id: event.turnId,
            seq: (session.seqCounter += 1),
          },
        ),
      );
    } else {
      const endedTurnId = event.turnId;
      push(
        createEvent(
          'turn.end',
          {
            turn_id: endedTurnId,
            reason: event.reason,
            success: event.success,
            ...(event.usage !== undefined
              ? {
                  usage: {
                    input_tokens: event.usage.input,
                    output_tokens: event.usage.output,
                    ...(event.usage.cache_read !== undefined
                      ? { cache_read_tokens: event.usage.cache_read }
                      : {}),
                    ...(event.usage.cache_write !== undefined
                      ? { cache_write_tokens: event.usage.cache_write }
                      : {}),
                  },
                }
              : {}),
          },
          {
            session_id: session.sessionId,
            turn_id: endedTurnId,
            seq: (session.seqCounter += 1),
          },
        ),
      );
      onTurnEnd?.(session, event.usage);
      if (session.currentTurnId === endedTurnId) {
        session.currentTurnId = undefined;
      }
    }
  };
  return turnManager.addTurnLifecycleListener(listener);
}

// ── WireEventQueue ──────────────────────────────────────────────────

/**
 * A minimal async-iterable queue. `push` enqueues a message and wakes
 * the oldest waiter; `close` resolves every remaining waiter with an
 * iterator `done` signal. Multiple independent iterators are not
 * supported — the TUI's `useWire` hook subscribes exactly once.
 */
class WireEventQueue implements AsyncIterable<WireMessage> {
  private items: WireMessage[] = [];
  private waiters: Array<(value: IteratorResult<WireMessage>) => void> = [];
  private closed = false;

  push(msg: WireMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: msg, done: false });
      return;
    }
    this.items.push(msg);
  }

  close(): void {
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter({ value: undefined as unknown as WireMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<WireMessage> {
    return {
      next: async (): Promise<IteratorResult<WireMessage>> => {
        const first = this.items.shift();
        if (first !== undefined) {
          return { value: first, done: false };
        }
        if (this.closed) {
          return { value: undefined as unknown as WireMessage, done: true };
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async (): Promise<IteratorResult<WireMessage>> => {
        // Release any pending waiter so the consumer exits its
        // `for await` promptly when the TUI unmounts.
        const pending = this.waiters;
        this.waiters = [];
        for (const waiter of pending) {
          waiter({ value: undefined as unknown as WireMessage, done: true });
        }
        return { value: undefined as unknown as WireMessage, done: true };
      },
    };
  }
}
