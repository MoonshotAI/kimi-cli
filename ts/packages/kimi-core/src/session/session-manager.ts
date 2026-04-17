/**
 * SessionManager — real session lifecycle manager (Slice 3.4).
 *
 * Upgraded from the Phase 1 in-memory Map stub to a full filesystem-backed
 * session lifecycle manager. Handles create / resume / list / delete / close
 * with wire.jsonl, state.json, and PathConfig integration.
 *
 * The SessionManager is responsible for the STORAGE layer:
 *   - Session directory management (mkdir / rm)
 *   - JournalWriter lifecycle (fresh or resume)
 *   - ContextState creation (fresh or hydrated from replay)
 *   - SessionJournal creation
 *   - StateCache management (flush on close)
 *   - Replay + repair on resume
 *   - Compaction rotation crash recovery on resume
 *
 * The SessionManager is NOT responsible for:
 *   - Provider creation (Config module — Slice 3.0)
 *   - Tool registration (Tool/Agent module — Slice 3.1)
 *   - System prompt assembly (Agent module — Slice 3.1)
 *   These external deps are passed per-session via create/resume options.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';

import type { AgentTypeRegistry } from '../soul-plus/agent-type-registry.js';
import { SoulLifecycleGate } from '../soul-plus/soul-lifecycle-gate.js';
import { SessionLifecycleStateMachine } from '../soul-plus/lifecycle-state-machine.js';
import type { ShellDeliverCallback } from '../soul-plus/notification-manager.js';
import type { ToolCallOrchestrator } from '../soul-plus/orchestrator.js';
import type { PermissionMode, PermissionRule } from '../soul-plus/permission/index.js';
import { DefaultSessionControl, type SessionControlHandler } from '../soul-plus/session-control.js';
import type { SessionEventBus } from '../soul-plus/session-event-bus.js';
import type { SkillManager } from '../soul-plus/skill/index.js';
import { SoulPlus, type SoulPlusDeps } from '../soul-plus/soul-plus.js';
import { cleanupStaleSubagents } from '../soul-plus/subagent-runner.js';
import { SubagentStore } from '../soul-plus/subagent-store.js';
import type { TurnManager } from '../soul-plus/turn-manager.js';
import type {
  CompactionConfig,
  CompactionProvider,
  JournalCapability,
  Runtime,
  Tool,
} from '../soul/index.js';
import type { NotificationRecord } from '../storage/wire-record.js';
import { recoverRotation } from '../storage/compaction.js';
import type { FullContextState } from '../storage/context-state.js';
import { WiredContextState } from '../storage/context-state.js';
import { WiredJournalWriter, type JournalWriter } from '../storage/journal-writer.js';
import { repairJournal } from '../storage/recovery.js';
import { replayWire, type ReplayResult } from '../storage/replay.js';
import { WiredSessionJournalImpl, type SessionJournal } from '../storage/session-journal.js';
import type { PathConfig } from './path-config.js';
import { projectReplayState } from './replay-projector.js';
import { StateCache, type SessionState } from './state-cache.js';
import {
  createCachedUsageAggregator,
  type CachedUsageAggregator,
  type SessionUsageTotals,
} from './usage-aggregator.js';

// ── Public types ──────────────────────────────────────────────────────

/**
 * Slice 5.1 — runtime status reported by `getSessionStatus()`. Mirrors
 * `SessionLifecycleState` from soul-plus plus the persisted-only `'closed'`
 * value `closeSession()` writes when a session is gracefully released
 * from memory. Callers should treat `'closed'` as "exists on disk but no
 * longer live"; live lifecycle states (`active`/`completing`/etc.) only
 * appear when the session is currently loaded.
 */
export type SessionStatus =
  | 'idle'
  | 'active'
  | 'completing'
  | 'compacting'
  | 'destroying'
  | 'closed';

export type { SessionUsageTotals } from './usage-aggregator.js';

export interface SessionInfo {
  session_id: string;
  created_at: number;
  model?: string | undefined;
  status?: string | undefined;
  /**
   * Workspace directory at session creation time (Slice 4.3 Part 5).
   * Hosts use this to filter `--continue` candidates by the current
   * working directory. Undefined for legacy sessions written before
   * Slice 4.3 or for sessions whose state.json is missing / corrupt.
   */
  workspace_dir?: string | undefined;
  /**
   * User-set session title via `/title` (Slice 5.1). Sources `state.custom_title`
   * if present; otherwise undefined. Hosts may render `session_id` as a
   * fallback display label.
   */
  title?: string | undefined;
  /**
   * Unix seconds — file mtime of state.json (Slice 5.1). Used as a proxy
   * for "last user activity" in `/sessions` listings. Undefined when
   * state.json is missing.
   */
  last_activity?: number | undefined;
}

export interface CreateSessionOptions {
  /** Override session id — default: auto-generated `ses_<uuid12>`. */
  sessionId?: string | undefined;
  /**
   * Soul-visible runtime. Phase 2 (todo/phase-2-compaction-out-of-soul.md):
   * this is now a single-field `{kosong}` bag; compaction / journal
   * capabilities have been promoted to their own top-level options
   * (`compactionProvider` / `journalCapability`).
   */
  runtime: Runtime;
  /** Available tools for this session. */
  tools: readonly Tool[];
  /** Initial model name. */
  model: string;
  /** System prompt (pre-assembled by the agent module). */
  systemPrompt?: string | undefined;
  /** Session event bus — created internally if not provided. */
  eventBus?: SessionEventBus | undefined;
  /** Optional shell delivery callback (Slice 2.4). */
  onShellDeliver?: ShellDeliverCallback | undefined;
  /** Optional skill manager (Slice 2.5). */
  skillManager?: SkillManager | undefined;
  /** Optional tool call orchestrator (Slice 2.2 / Slice 4). */
  orchestrator?: ToolCallOrchestrator | undefined;
  /** Static permission rules (project / user scope). */
  sessionRules?: readonly PermissionRule[] | undefined;
  /** Initial permission mode. */
  permissionMode?: PermissionMode | undefined;
  /** Compaction configuration (Slice 3.3). */
  compactionConfig?: CompactionConfig | undefined;
  /**
   * Phase 2 — compaction provider forwarded into SoulPlus. Optional so
   * tests that do not exercise compaction don't need to plumb anything
   * through; SoulPlus falls back to a throwing stub when absent.
   */
  compactionProvider?: CompactionProvider | undefined;
  /**
   * Phase 2 — journal capability forwarded into SoulPlus. Same optional
   * / stub-default semantics as `compactionProvider`.
   */
  journalCapability?: JournalCapability | undefined;
  /**
   * Workspace directory at session creation (Slice 4.3 Part 5).
   * Persisted to state.json and returned by listSessions so `--continue`
   * can filter candidates by the current working directory. Required so
   * every host must make an explicit decision — tests that don't care
   * about workspace filtering should pass a deterministic fixture path
   * (typically the OS temp dir).
   */
  workspaceDir: string;
  /**
   * Slice 5.3 — subagent type registry. When provided, SessionManager
   * constructs a per-session `SubagentStore` internally and forwards both
   * into SoulPlusDeps so SoulPlus can register the `AgentTool` collaboration
   * tool. When omitted, AgentTool is not registered and the session runs
   * without subagent spawning capability (embedding-scenario cutoff per
   * v2 §10.3.1).
   */
  agentTypeRegistry?: AgentTypeRegistry | undefined;
}

export interface ResumeSessionOptions {
  /**
   * Soul-visible runtime. Phase 2: see note on
   * `CreateSessionOptions.runtime`.
   */
  runtime: Runtime;
  /** Available tools for this session. */
  tools: readonly Tool[];
  /** Fallback model name (used if no model_changed record exists). */
  model: string;
  /** Fallback system prompt (used if no system_prompt_changed record). */
  systemPrompt?: string | undefined;
  /** Session event bus. */
  eventBus?: SessionEventBus | undefined;
  /** Optional shell delivery callback. */
  onShellDeliver?: ShellDeliverCallback | undefined;
  /** Optional skill manager. */
  skillManager?: SkillManager | undefined;
  /** Optional tool call orchestrator. */
  orchestrator?: ToolCallOrchestrator | undefined;
  /** Static permission rules. */
  sessionRules?: readonly PermissionRule[] | undefined;
  /** Fallback permission mode (used if no permission_mode_changed record). */
  permissionMode?: PermissionMode | undefined;
  /** Compaction configuration. */
  compactionConfig?: CompactionConfig | undefined;
  /** Phase 2 — compaction provider forwarded into SoulPlus. */
  compactionProvider?: CompactionProvider | undefined;
  /** Phase 2 — journal capability forwarded into SoulPlus. */
  journalCapability?: JournalCapability | undefined;
  /** Slice 5.3 — see CreateSessionOptions.agentTypeRegistry. */
  agentTypeRegistry?: AgentTypeRegistry | undefined;
}

/** A fully-assembled, running session. */
export interface ManagedSession {
  readonly sessionId: string;
  readonly soulPlus: SoulPlus;
  readonly sessionControl: SessionControlHandler;
  readonly contextState: FullContextState;
  readonly stateCache: StateCache;
  readonly sessionJournal: SessionJournal;
  readonly journalWriter: JournalWriter;
  /**
   * Slice 5.1 — exposed so `getSessionStatus()` can read the live lifecycle
   * state for active sessions. Same instance owned by SoulPlus.
   */
  readonly lifecycleStateMachine: SessionLifecycleStateMachine;
}

// ── Supported protocol major version ────────────────────────────────

const SUPPORTED_MAJOR = 2;

// ── SessionManager ──────────────────────────────────────────────────

export class SessionManager {
  private readonly paths: PathConfig;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly usageAggregator: CachedUsageAggregator;
  /**
   * Slice 5.1 (Codex M2): per-session write serialization. Read-merge-write
   * flows (rename, close, etc.) chain onto the same Promise so concurrent
   * mutations don't drop each other's fields.
   */
  private readonly stateWriteMutex = new Map<string, Promise<void>>();

  constructor(paths: PathConfig) {
    this.paths = paths;
    this.usageAggregator = createCachedUsageAggregator();
  }

  /**
   * Run `task` while holding a per-session write lock. Subsequent calls
   * for the same `sessionId` queue behind it. The lock is released when
   * `task` settles (success or failure).
   */
  private withStateLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.stateWriteMutex.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task);
    // Track the void-typed continuation so future callers wait.
    this.stateWriteMutex.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // ── Create ────────────────────────────────────────────────────────

  async createSession(options: CreateSessionOptions): Promise<ManagedSession> {
    const sessionId = options.sessionId ?? `ses_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already exists: ${sessionId}`);
    }

    const sessionDir = this.paths.sessionDir(sessionId);
    await mkdir(sessionDir, { recursive: true });

    // Fresh JournalWriter — will write metadata header on first append.
    const { SessionEventBus: EventBusCtor } = await import('../soul-plus/session-event-bus.js');
    const eventBus = options.eventBus ?? new EventBusCtor();

    // Codex Round 2 M3: SessionManager owns the single lifecycle state
    // machine. The SoulLifecycleGate is shared between JournalWriter
    // and SoulPlus (via Runtime.lifecycle + TurnManager) so the
    // compacting/completing gate actually takes effect in production.
    const lifecycleStateMachine = new SessionLifecycleStateMachine();
    const lifecycleGate = new SoulLifecycleGate(lifecycleStateMachine);

    const journalWriter = new WiredJournalWriter({
      filePath: this.paths.wirePath(sessionId),
      lifecycle: lifecycleGate,
    });

    const sessionJournal = new WiredSessionJournalImpl(journalWriter);

    // Deferred TurnManager ref — ContextState needs a `currentTurnId`
    // callback at construction, but TurnManager is created inside SoulPlus
    // afterwards. We capture a mutable ref and wire it post-construction.
    let turnManagerRef: TurnManager | undefined;
    const contextState = new WiredContextState({
      journalWriter,
      initialModel: options.model,
      ...(options.systemPrompt !== undefined ? { initialSystemPrompt: options.systemPrompt } : {}),
      currentTurnId: () => turnManagerRef?.getCurrentTurnId() ?? 'no_turn',
    });

    // Write initial state.json
    const stateCache = new StateCache(this.paths.statePath(sessionId));
    const now = Date.now();
    await stateCache.write({
      session_id: sessionId,
      model: options.model,
      status: 'active',
      created_at: now,
      updated_at: now,
      workspace_dir: options.workspaceDir,
    });

    // Assemble SoulPlus — shares the lifecycle state machine created
    // above so JournalWriter, Runtime.lifecycle, and TurnManager all
    // gate on the same physical state (Codex Round 2 M3).
    const soulPlusDeps: SoulPlusDeps = {
      sessionId,
      contextState,
      sessionJournal,
      runtime: options.runtime,
      eventBus,
      tools: options.tools,
      lifecycleStateMachine,
      ...(options.onShellDeliver !== undefined ? { onShellDeliver: options.onShellDeliver } : {}),
      ...(options.skillManager !== undefined ? { skillManager: options.skillManager } : {}),
      ...(options.compactionConfig !== undefined
        ? { compactionConfig: options.compactionConfig }
        : {}),
      // Phase 2 — forward compaction capabilities that used to ride on
      // Runtime but now live as their own top-level options.
      ...(options.compactionProvider !== undefined
        ? { compactionProvider: options.compactionProvider }
        : {}),
      ...(options.journalCapability !== undefined
        ? { journalCapability: options.journalCapability }
        : {}),
      // Slice 4.2 — forward the optional orchestrator into SoulPlus so
      // TurnManager's beforeToolCall closure runs the full hook +
      // permission + approval pipeline. Absent the option, TurnManager
      // continues to use its always-allow default.
      ...(options.orchestrator !== undefined ? { orchestrator: options.orchestrator } : {}),
      // Slice 5.3 — subagent infra. When the host supplies an
      // agentTypeRegistry we build a per-session SubagentStore internally
      // so SoulPlus's `hasSubagentInfra` gate (soul-plus.ts) registers
      // the `Agent` collaboration tool for this session.
      ...(options.agentTypeRegistry !== undefined
        ? {
            subagentStore: new SubagentStore(sessionDir),
            agentTypeRegistry: options.agentTypeRegistry,
            sessionDir,
            workDir: options.workspaceDir,
            pathConfig: this.paths,
          }
        : {}),
    };
    const soulPlus = new SoulPlus(soulPlusDeps);

    // Wire the deferred TurnManager ref — from this point on, the
    // ContextState callback returns the real turn_id during Soul turns.
    turnManagerRef = soulPlus.getTurnManager();

    // Slice 7.1 (决策 #99) — durable skill-listing injection. Idempotent
    // and a no-op when no SkillManager was supplied.
    await soulPlus.init();

    // Apply initial permission mode if provided.
    if (options.permissionMode !== undefined) {
      turnManagerRef.setPermissionMode(options.permissionMode);
    }

    const sessionControl = new DefaultSessionControl({
      turnManager: turnManagerRef,
      contextState,
      sessionJournal,
    });

    const managed: ManagedSession = {
      sessionId,
      soulPlus,
      sessionControl,
      contextState,
      stateCache,
      sessionJournal,
      journalWriter,
      lifecycleStateMachine,
    };

    this.sessions.set(sessionId, managed);
    return managed;
  }

  // ── Resume ────────────────────────────────────────────────────────

  async resumeSession(sessionId: string, options: ResumeSessionOptions): Promise<ManagedSession> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already active: ${sessionId}`);
    }

    // ── Startup recovery sequence (Phase 0.6 — 6 canonical steps) ────
    //
    // Step 1: Compaction rollback
    // Step 2: Replay wire.jsonl → ContextState + SessionJournal
    // Step 3: ApprovalRuntime.recoverPendingOnStartup()
    // Step 4: SkillManager 无状态启动
    // Step 5: MCP 连接重建
    // Step 6: TeamDaemon 恢复 (占位)
    //
    // The steps below implement 1-2 fully; 3-6 are wired in SoulPlus
    // construction or remain placeholders for future slices.

    const sessionDir = this.paths.sessionDir(sessionId);
    const wirePath = this.paths.wirePath(sessionId);

    // Step 1: Compaction rollback (Codex Round 2 M1).
    // If the previous process crashed between rotateJournal (rename old
    // wire.jsonl → wire.N.jsonl + create new wire.jsonl) and writing the
    // CompactionRecord, the current wire.jsonl is metadata-only or missing.
    // recoverRotation detects this and rolls back to the pre-rotation state.
    // Ignore ENOENT — if the session directory doesn't exist, there's
    // nothing to recover and the subsequent replayWire will produce the
    // proper error message.
    try {
      await recoverRotation(sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    // 1. Replay wire.jsonl → records + health
    let replayResult: ReplayResult;
    try {
      replayResult = await replayWire(wirePath, { supportedMajor: SUPPORTED_MAJOR });
    } catch (error) {
      throw new Error(
        `Failed to replay session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    // 2. Project records → initial state
    const projected = projectReplayState(replayResult.records);

    // 3. Create JournalWriter in resume mode — same lifecycle sharing
    //    pattern as createSession (Codex Round 2 M3).
    const lifecycleStateMachine = new SessionLifecycleStateMachine();
    const lifecycleGate = new SoulLifecycleGate(lifecycleStateMachine);

    const journalWriter = new WiredJournalWriter({
      filePath: wirePath,
      lifecycle: lifecycleGate,
      initialSeq: projected.lastSeq,
      metadataAlreadyWritten: true,
    });

    const sessionJournal = new WiredSessionJournalImpl(journalWriter);

    // 4. Create WiredContextState hydrated from replay.
    // Deferred TurnManager ref — same pattern as createSession.
    let turnManagerRef: TurnManager | undefined;
    const effectiveModel = projected.model ?? options.model;
    const effectiveSystemPrompt = projected.systemPrompt ?? options.systemPrompt;
    const contextState = new WiredContextState({
      journalWriter,
      initialModel: effectiveModel,
      ...(effectiveSystemPrompt !== undefined
        ? { initialSystemPrompt: effectiveSystemPrompt }
        : {}),
      ...(projected.activeTools.size > 0 ? { initialActiveTools: projected.activeTools } : {}),
      currentTurnId: () => turnManagerRef?.getCurrentTurnId() ?? 'no_turn',
      initialHistory: projected.messages,
      initialTokenCount: projected.tokenCount,
    });

    // 5. Passive journal repair (§8.1) — append synthetic records for
    //    dangling tool_calls, turns, and approvals.
    await repairJournal({
      records: replayResult.records,
      contextState,
      sessionJournal,
      currentTurnId: () => turnManagerRef?.getCurrentTurnId() ?? 'recovery',
    });

    // 6. StateCache
    const stateCache = new StateCache(this.paths.statePath(sessionId));
    const stateData = await stateCache.read();
    if (stateData !== null) {
      await stateCache.write({
        ...stateData,
        status: 'active',
        updated_at: Date.now(),
      });
    }

    // 7. Assemble SoulPlus
    const { SessionEventBus: EventBusCtor } = await import('../soul-plus/session-event-bus.js');
    const eventBus = options.eventBus ?? new EventBusCtor();

    const effectivePermissionMode = projected.permissionMode ?? options.permissionMode;

    // Slice 5.3 — stale subagent cleanup (Python parity:
    // `app.py:_cleanup_stale_foreground_subagents`). Runs BEFORE SoulPlus
    // construction so the AgentTool sees a clean store. Safe no-op when
    // `subagents/` doesn't exist yet (`listInstances()` returns []).
    // v2 §8.2: residual `status='running'` records are rewritten as
    // `'lost'` (NOT `'failed'`). See `cleanupStaleSubagents`.
    let subagentStore: SubagentStore | undefined;
    if (options.agentTypeRegistry !== undefined) {
      subagentStore = new SubagentStore(sessionDir);
      await cleanupStaleSubagents(subagentStore);
    }

    const soulPlusDeps: SoulPlusDeps = {
      sessionId,
      contextState,
      sessionJournal,
      runtime: options.runtime,
      eventBus,
      tools: options.tools,
      lifecycleStateMachine,
      ...(options.onShellDeliver !== undefined ? { onShellDeliver: options.onShellDeliver } : {}),
      ...(options.skillManager !== undefined ? { skillManager: options.skillManager } : {}),
      ...(options.compactionConfig !== undefined
        ? { compactionConfig: options.compactionConfig }
        : {}),
      // Phase 2 — forward compaction capabilities on the resume path too.
      ...(options.compactionProvider !== undefined
        ? { compactionProvider: options.compactionProvider }
        : {}),
      ...(options.journalCapability !== undefined
        ? { journalCapability: options.journalCapability }
        : {}),
      // Slice 4.2 — forward the optional orchestrator on the resume
      // path too so resumed sessions run the same tool pipeline.
      ...(options.orchestrator !== undefined ? { orchestrator: options.orchestrator } : {}),
      // Slice 5.3 — subagent infra forward (same shape as createSession).
      // `subagentStore` is constructed above together with the stale-
      // cleanup pass; `workDir` prefers the persisted state.json value
      // so resumed sessions keep the workspace they were created under.
      ...(options.agentTypeRegistry !== undefined && subagentStore !== undefined
        ? {
            subagentStore,
            agentTypeRegistry: options.agentTypeRegistry,
            sessionDir,
            workDir: stateData?.workspace_dir ?? process.cwd(),
            pathConfig: this.paths,
          }
        : {}),
    };
    const soulPlus = new SoulPlus(soulPlusDeps);

    // Wire the deferred TurnManager ref.
    turnManagerRef = soulPlus.getTurnManager();

    // Slice 7.1 (决策 #99) — durable skill-listing injection. Resumed
    // sessions also get a fresh listing (skill rosters can change between
    // process boots); the `DISREGARD any earlier skill listings` preamble
    // ensures the model does not double-count.
    await soulPlus.init();

    // Restore permission mode from replay if it was changed.
    if (effectivePermissionMode !== undefined) {
      turnManagerRef.setPermissionMode(effectivePermissionMode);
    }

    // Slice 5.2 (T3.5) — restore plan_mode. Replay value wins over
    // state.json (it carries finer-grained sequencing); state.json
    // serves as a fallback for sessions whose wire was truncated.
    const persistedPlanMode = stateData?.plan_mode;
    const effectivePlanMode = projected.planMode ?? persistedPlanMode;
    if (effectivePlanMode === true) {
      turnManagerRef.setPlanMode(true);
    }

    // Slice 5.2 (T3.1+T3.6) — push-only re-inject pending llm notifications.
    // Records that target llm but whose ids never appeared as
    // `<notification id="...">` in transcript get stashed as ephemeral
    // injections for the next buildMessages().
    const notificationRecords = replayResult.records.filter(
      (r): r is NotificationRecord => r.type === 'notification',
    );
    if (notificationRecords.length > 0) {
      const notificationManager = soulPlus.getNotificationManager();
      // Prime dedupe so subsequent emit() with same dedupe_key is a no-op.
      notificationManager.primeDedupeIndex(notificationRecords);
      // Phase 1 (Decision #89): replayPendingForResume removed — notifications
      // are durable entries in history, replayed naturally from wire.jsonl via
      // the replay-projector's initialHistory. No ephemeral re-inject needed.
    }

    const sessionControl = new DefaultSessionControl({
      turnManager: turnManagerRef,
      contextState,
      sessionJournal,
    });

    const managed: ManagedSession = {
      sessionId,
      soulPlus,
      sessionControl,
      contextState,
      stateCache,
      sessionJournal,
      journalWriter,
      lifecycleStateMachine,
    };

    this.sessions.set(sessionId, managed);
    return managed;
  }

  // ── List ──────────────────────────────────────────────────────────

  async listSessions(): Promise<SessionInfo[]> {
    const sessionsRoot = this.paths.sessionsDir;
    let entries: string[];
    try {
      entries = await readdir(sessionsRoot);
    } catch {
      // sessionsDir doesn't exist yet — no sessions.
      return [];
    }

    // Slice 5.1 — read each session's state.json + mtime in parallel.
    // The host typically renders this in a picker so latency matters.
    const infos = await Promise.all(
      entries.map(async (entry): Promise<SessionInfo> => {
        const statePath = this.paths.statePath(entry);
        const cache = new StateCache(statePath);
        const [state, lastActivity] = await Promise.all([
          cache.read(),
          stat(statePath).then(
            (st) => Math.floor(st.mtimeMs / 1000) as number | undefined,
            () => undefined,
          ),
        ]);
        if (state !== null) {
          return {
            session_id: state.session_id,
            created_at: state.created_at,
            ...(state.model !== undefined ? { model: state.model } : {}),
            ...(state.status !== undefined ? { status: state.status } : {}),
            ...(state.workspace_dir !== undefined
              ? { workspace_dir: state.workspace_dir }
              : {}),
            ...(state.custom_title !== undefined
              ? { title: state.custom_title }
              : {}),
            ...(lastActivity !== undefined ? { last_activity: lastActivity } : {}),
          };
        }
        // state.json missing or corrupt — include with minimal info.
        return {
          session_id: entry,
          created_at: 0,
          ...(lastActivity !== undefined ? { last_activity: lastActivity } : {}),
        };
      }),
    );

    // Slice 5.1 (Codex M1) — sort by recency descending so /sessions
    // picker shows the most-recent first. Tie-break by session_id for
    // stable ordering. Mirrors Python session.py:list_sessions().
    //
    // Normalize timestamps to seconds before comparing: created_at is
    // currently written in ms (Date.now()) while last_activity is
    // mtime in seconds. Mixing units would break the order for sessions
    // straddling the migration. Anything > 1e12 is ms.
    const toSec = (n: number | undefined): number => {
      if (n === undefined || !Number.isFinite(n) || n <= 0) return 0;
      return n > 1e12 ? Math.floor(n / 1000) : n;
    };
    return infos.sort((a, b) => {
      const aTs = toSec(a.last_activity) || toSec(a.created_at);
      const bTs = toSec(b.last_activity) || toSec(b.created_at);
      if (aTs !== bTs) return bTs - aTs;
      return a.session_id.localeCompare(b.session_id);
    });
  }

  // ── Rename / Status / Usage (Slice 5.1) ───────────────────────────

  /**
   * Persist a user-set title to state.json. Read-merge-write semantics
   * preserve other fields written by concurrent flows (auto-approve list,
   * status, etc.). Throws if the session does not exist on disk.
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new Error('renameSession: title cannot be empty or whitespace-only');
    }
    return this.withStateLock(sessionId, async () => {
      const statePath = this.paths.statePath(sessionId);
      const cache = new StateCache(statePath);
      const existing = await cache.read();
      if (existing === null) {
        throw new Error(`renameSession: session "${sessionId}" not found`);
      }
      await cache.write({
        ...existing,
        custom_title: trimmed,
        updated_at: Date.now(),
      });
      // Drop any cached usage for this wire — rename touched state, not
      // wire.jsonl, but the cache window may have produced stale answers
      // for callers that re-read immediately after a turn boundary.
      this.usageAggregator.invalidate(this.paths.wirePath(sessionId));
    });
  }

  /**
   * Return the runtime status of a session. When the session is live,
   * returns the lifecycle state machine's current state. Otherwise reads
   * `status` from state.json, defaulting to 'idle'.
   */
  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    // Live session — query lifecycle directly.
    const live = this.sessions.get(sessionId);
    if (live !== undefined) {
      return live.lifecycleStateMachine.state as SessionStatus;
    }
    // Persisted — read state.json; throw if missing.
    const cache = new StateCache(this.paths.statePath(sessionId));
    const state = await cache.read();
    if (state === null) {
      throw new Error(`getSessionStatus: session "${sessionId}" not found`);
    }
    // Persisted `status` is free-form; treat unknown values as 'idle'.
    const validStatuses: ReadonlySet<string> = new Set([
      'idle', 'active', 'completing', 'compacting', 'destroying', 'closed',
    ]);
    if (state.status !== undefined && validStatuses.has(state.status)) {
      return state.status as SessionStatus;
    }
    return 'idle';
  }

  /**
   * Return aggregated token usage for a session.
   *
   * Streams `wire.jsonl` and sums `usage` blocks from every `turn_end`
   * record. Result is cached in-process for 5 seconds keyed by wire
   * path; back-to-back `/usage` invocations within the window return
   * the cached snapshot rather than re-reading. The cache is invalidated
   * by `renameSession()` to flush any pre-rename snapshot a host might
   * have just fetched, but is intentionally NOT invalidated by ongoing
   * turn writes — the 5s window is the upper bound on staleness for
   * actively running sessions, which is fine for status displays.
   *
   * Returns zeros when wire.jsonl is missing (a freshly-created session
   * before its first turn is normal). Throws when the session has no
   * state.json (i.e. does not exist).
   */
  async getSessionUsage(sessionId: string): Promise<SessionUsageTotals> {
    // Existence check — wire.jsonl may legitimately be missing (no turns
    // yet), so we anchor existence on state.json.
    const cache = new StateCache(this.paths.statePath(sessionId));
    const state = await cache.read();
    if (state === null) {
      throw new Error(`getSessionUsage: session "${sessionId}" not found`);
    }
    const wirePath = this.paths.wirePath(sessionId);
    return this.usageAggregator(wirePath);
  }

  // ── Delete ────────────────────────────────────────────────────────

  async deleteSession(sessionId: string): Promise<void> {
    // Close if active in memory.
    if (this.sessions.has(sessionId)) {
      await this.closeSession(sessionId);
    }

    const sessionDir = this.paths.sessionDir(sessionId);
    await rm(sessionDir, { recursive: true, force: true });
  }

  // ── Close ─────────────────────────────────────────────────────────

  async closeSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (managed === undefined) {
      return;
    }
    return this.withStateLock(sessionId, async () => {
      // Flush state.json with latest metadata. Re-read inside the lock
      // so a rename that landed during our wait is preserved.
      const existing = await managed.stateCache.read();
      const now = Date.now();
      // Slice 5.2 — persist plan_mode so a WAL-truncated resume still
      // restores the flag (replay is primary, state.json is fallback).
      const turnManager = managed.soulPlus.getTurnManager();
      const currentPlanMode = turnManager.getPlanMode();
      const stateToFlush: SessionState = existing
        ? {
            ...existing,
            status: 'closed',
            updated_at: now,
            ...(currentPlanMode ? { plan_mode: true } : { plan_mode: false }),
          }
        : {
            session_id: sessionId,
            status: 'closed',
            created_at: now,
            updated_at: now,
            plan_mode: currentPlanMode,
          };
      await managed.stateCache.write(stateToFlush);

      // Phase 3 (Slice 3) — drain the async-batch pending buffer and
      // stop the drain timer before we drop the managed reference.
      // Otherwise the setInterval keeps the writer alive and pending
      // records never land on disk at shutdown.
      await managed.journalWriter.close();

      // Remove from active sessions map.
      this.sessions.delete(sessionId);
    });
  }

  // ── Get ───────────────────────────────────────────────────────────

  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  // ── Convenience: in-memory session count ──────────────────────────

  get activeSessionCount(): number {
    return this.sessions.size;
  }
}
