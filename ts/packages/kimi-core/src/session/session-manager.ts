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
import { mkdir, readdir, rm } from 'node:fs/promises';

import { LifecycleGateFacade } from '../soul-plus/lifecycle-gate.js';
import { SessionLifecycleStateMachine } from '../soul-plus/lifecycle-state-machine.js';
import type { ShellDeliverCallback } from '../soul-plus/notification-manager.js';
import type { ToolCallOrchestrator } from '../soul-plus/orchestrator.js';
import type { PermissionMode, PermissionRule } from '../soul-plus/permission/index.js';
import { DefaultSessionControl, type SessionControlHandler } from '../soul-plus/session-control.js';
import type { SessionEventBus } from '../soul-plus/session-event-bus.js';
import type { SkillManager } from '../soul-plus/skill/index.js';
import { SoulPlus, type SoulPlusDeps } from '../soul-plus/soul-plus.js';
import type { TurnManager } from '../soul-plus/turn-manager.js';
import type { CompactionConfig, Runtime, Tool } from '../soul/index.js';
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

// ── Public types ──────────────────────────────────────────────────────

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
}

export interface CreateSessionOptions {
  /** Override session id — default: auto-generated `ses_<uuid12>`. */
  sessionId?: string | undefined;
  /** LLM runtime (kosong + compaction provider + journal capability). */
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
   * Workspace directory at session creation (Slice 4.3 Part 5).
   * Persisted to state.json and returned by listSessions so `--continue`
   * can filter candidates by the current working directory. Required so
   * every host must make an explicit decision — tests that don't care
   * about workspace filtering should pass a deterministic fixture path
   * (typically the OS temp dir).
   */
  workspaceDir: string;
}

export interface ResumeSessionOptions {
  /** LLM runtime. */
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
}

// ── Supported protocol major version ────────────────────────────────

const SUPPORTED_MAJOR = 2;

// ── SessionManager ──────────────────────────────────────────────────

export class SessionManager {
  private readonly paths: PathConfig;
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(paths: PathConfig) {
    this.paths = paths;
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
    // machine. The LifecycleGateFacade is shared between JournalWriter
    // and SoulPlus (via Runtime.lifecycle + TurnManager) so the
    // compacting/completing gate actually takes effect in production.
    const lifecycleStateMachine = new SessionLifecycleStateMachine();
    const lifecycleGate = new LifecycleGateFacade(lifecycleStateMachine);

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
      // Slice 4.2 — forward the optional orchestrator into SoulPlus so
      // TurnManager's beforeToolCall closure runs the full hook +
      // permission + approval pipeline. Absent the option, TurnManager
      // continues to use its always-allow default.
      ...(options.orchestrator !== undefined ? { orchestrator: options.orchestrator } : {}),
    };
    const soulPlus = new SoulPlus(soulPlusDeps);

    // Wire the deferred TurnManager ref — from this point on, the
    // ContextState callback returns the real turn_id during Soul turns.
    turnManagerRef = soulPlus.getTurnManager();

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
    };

    this.sessions.set(sessionId, managed);
    return managed;
  }

  // ── Resume ────────────────────────────────────────────────────────

  async resumeSession(sessionId: string, options: ResumeSessionOptions): Promise<ManagedSession> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session already active: ${sessionId}`);
    }

    const sessionDir = this.paths.sessionDir(sessionId);
    const wirePath = this.paths.wirePath(sessionId);

    // 0. Recover from a half-done compaction rotation (Codex Round 2 M1).
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
    const lifecycleGate = new LifecycleGateFacade(lifecycleStateMachine);

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
      // Slice 4.2 — forward the optional orchestrator on the resume
      // path too so resumed sessions run the same tool pipeline.
      ...(options.orchestrator !== undefined ? { orchestrator: options.orchestrator } : {}),
    };
    const soulPlus = new SoulPlus(soulPlusDeps);

    // Wire the deferred TurnManager ref.
    turnManagerRef = soulPlus.getTurnManager();

    // Restore permission mode from replay if it was changed.
    if (effectivePermissionMode !== undefined) {
      turnManagerRef.setPermissionMode(effectivePermissionMode);
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

    const results: SessionInfo[] = [];
    for (const entry of entries) {
      const statePath = this.paths.statePath(entry);
      const cache = new StateCache(statePath);
      const state = await cache.read();
      if (state !== null) {
        results.push({
          session_id: state.session_id,
          created_at: state.created_at,
          model: state.model,
          status: state.status,
          workspace_dir: state.workspace_dir,
        });
      } else {
        // state.json missing or corrupt — include with minimal info.
        results.push({
          session_id: entry,
          created_at: 0,
        });
      }
    }

    return results;
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

    // Flush state.json with latest metadata.
    const existing = await managed.stateCache.read();
    const now = Date.now();
    const stateToFlush: SessionState = existing
      ? { ...existing, status: 'closed', updated_at: now }
      : {
          session_id: sessionId,
          status: 'closed',
          created_at: now,
          updated_at: now,
        };
    await managed.stateCache.write(stateToFlush);

    // Remove from active sessions map.
    this.sessions.delete(sessionId);
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
