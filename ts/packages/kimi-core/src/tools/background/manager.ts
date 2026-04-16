/**
 * BackgroundProcessManager — manages background shell processes (Slice 3.5).
 *
 * Ports Python `kimi_cli/background/manager.py`. Tracks background bash
 * tasks spawned by `BashTool` when `run_in_background=true`.
 *
 * Each task gets a unique ID, captures stdout+stderr to a ring buffer,
 * and supports status query / output retrieval / stop operations.
 *
 * Accepts `KaosProcess` (not `ChildProcess`) so there is no unsafe cast
 * at the BashTool call site. Lifecycle detection uses `wait()` instead
 * of EventEmitter `on('exit')`.
 */

import type { KaosProcess } from '@moonshot-ai/kaos';

import { listTasks, removeTask, writeTask, type PersistedTask } from './persist.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Slice 5.2 — `'lost'` is a reconcile-only terminal state. Tasks loaded
 * from disk that were marked `running` at startup but have no live
 * KaosProcess (the previous CLI process died) are reclassified as lost.
 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'lost';

export interface BackgroundTaskInfo {
  readonly taskId: string;
  readonly command: string;
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

interface ManagedProcess {
  readonly taskId: string;
  readonly command: string;
  readonly description: string;
  readonly proc: KaosProcess;
  readonly outputChunks: string[];
  status: BackgroundTaskStatus;
  exitCode: number | null;
  readonly startedAt: number;
  endedAt: number | null;
  /** Listeners awaiting task completion. */
  readonly waiters: Array<() => void>;
}

/** Maximum bytes of combined output kept per task (ring-buffer style). */
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

const SIGTERM_GRACE_MS = 5_000;

// Slice 5.2 (Codex M5) — random suffix prevents id collision with
// ghost tasks loaded from disk after a resume. Sequential counter
// would re-use bg_1/bg_2 and overwrite existing task files.
import { randomBytes } from 'node:crypto';

function generateTaskId(): string {
  return `bg_${randomBytes(4).toString('hex')}`;
}

/**
 * Slice 5.2 — terminal-state info for tasks reconciled as lost on resume.
 * They have no live KaosProcess and no captured output (the buffer died
 * with the previous process), so list/get returns this minimal record.
 */
export interface ReconcileResult {
  /** Task IDs that were marked `lost` because their process is gone. */
  readonly lost: readonly string[];
  /** Snapshot of each lost task's persisted info for terminal notifications. */
  readonly lostInfo: readonly BackgroundTaskInfo[];
}

// ── Manager ──────────────────────────────────────────────────────────

export class BackgroundProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  /**
   * Slice 5.2 — ghosts: tasks loaded from disk during reconcile that
   * have no live KaosProcess. They appear in `list()` / `getTask()`
   * with status `lost` so users see what was running before the
   * crash/restart.
   */
  private readonly ghosts = new Map<string, BackgroundTaskInfo>();
  /** Slice 5.2 — when set, register/lifecycle changes persist to disk. */
  private sessionDir: string | undefined;

  /**
   * Register a KaosProcess as a background task.
   * Starts capturing stdout/stderr and monitors lifecycle via `wait()`.
   * Returns the assigned task ID.
   */
  register(proc: KaosProcess, command: string, description: string): string {
    const taskId = generateTaskId();
    const entry: ManagedProcess = {
      taskId,
      command,
      description,
      proc,
      outputChunks: [],
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      waiters: [],
    };
    this.processes.set(taskId, entry);

    // Capture stdout + stderr into the ring buffer.
    for (const stream of [proc.stdout, proc.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        entry.outputChunks.push(chunk);
        // Enforce output cap: drop oldest chunks when over budget.
        let total = entry.outputChunks.reduce((s, c) => s + c.length, 0);
        while (total > MAX_OUTPUT_BYTES && entry.outputChunks.length > 1) {
          const removed = entry.outputChunks.shift();
          if (removed === undefined) break;
          total -= removed.length;
        }
      });
    }

    // Slice 5.2 — initial persistence (snapshot at start).
    this.persistLive(entry);

    // Monitor lifecycle via wait() — no EventEmitter dependency.
    void proc
      .wait()
      .then((exitCode) => {
        if (entry.status !== 'killed') {
          entry.status = exitCode === 0 ? 'completed' : 'failed';
        }
        entry.exitCode = exitCode;
        entry.endedAt = Date.now();
      })
      .catch((_err: unknown) => {
        if (entry.status === 'running') {
          entry.status = 'failed';
          entry.endedAt = Date.now();
        }
      })
      .finally(() => {
        // Slice 5.2 — persist terminal state.
        this.persistLive(entry);
        for (const resolve of entry.waiters) resolve();
        entry.waiters.length = 0;
      });

    return taskId;
  }

  /** Get info about a specific task. Falls back to ghosts (Slice 5.2). */
  getTask(taskId: string): BackgroundTaskInfo | undefined {
    const entry = this.processes.get(taskId);
    if (entry !== undefined) return this.toInfo(entry);
    return this.ghosts.get(taskId);
  }

  /**
   * List tasks, optionally filtering to active-only.
   *
   * Slice 5.2 — when `activeOnly=false`, includes reconcile ghosts (lost
   * tasks from a prior CLI process) so the user sees what survived the
   * restart. Active-only mode never shows ghosts (they're terminal).
   */
  list(activeOnly = true, limit = 20): BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = [];
    for (const entry of this.processes.values()) {
      if (activeOnly && entry.status !== 'running') continue;
      result.push(this.toInfo(entry));
      if (result.length >= limit) return result;
    }
    if (!activeOnly) {
      for (const ghost of this.ghosts.values()) {
        result.push(ghost);
        if (result.length >= limit) return result;
      }
    }
    return result;
  }

  /** Get the combined output of a task (tail of the ring buffer). */
  getOutput(taskId: string, tail?: number): string {
    const entry = this.processes.get(taskId);
    if (!entry) return '';
    const full = entry.outputChunks.join('');
    if (tail !== undefined && tail < full.length) {
      return full.slice(-tail);
    }
    return full;
  }

  /** Stop a running task. SIGTERM → 5s grace → SIGKILL. */
  async stop(taskId: string): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.processes.get(taskId);
    if (!entry) return undefined;
    if (entry.status !== 'running') return this.toInfo(entry);

    entry.status = 'killed';

    try {
      await entry.proc.kill('SIGTERM');
    } catch {
      /* process already gone */
    }

    // Wait up to 5s for graceful exit, then SIGKILL.
    const graceful = await Promise.race([
      entry.proc
        .wait()
        .then(() => true)
        .catch(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, SIGTERM_GRACE_MS);
      }),
    ]);

    if (!graceful && entry.proc.exitCode === null) {
      try {
        await entry.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }

    return this.toInfo(entry);
  }

  /**
   * Wait for a task to reach a terminal state.
   * Returns immediately if already terminal. Times out after `timeoutMs`.
   */
  async wait(taskId: string, timeoutMs = 30_000): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.processes.get(taskId);
    if (!entry) return undefined;
    if (entry.status !== 'running') return this.toInfo(entry);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      entry.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    return this.toInfo(entry);
  }

  /** Reset internal state (for testing). */
  _reset(): void {
    this.processes.clear();
    this.ghosts.clear();
    this.sessionDir = undefined;
  }

  // ── Slice 5.2 — persistence + reconcile ────────────────────────────

  /**
   * Attach the manager to a session directory for persistence. Tasks
   * created via `register()` after this call are written to
   * `<sessionDir>/tasks/<task_id>.json` and updated on lifecycle change.
   * Tasks created before attach are NOT retroactively persisted.
   */
  attachSessionDir(sessionDir: string): void {
    this.sessionDir = sessionDir;
  }

  /**
   * Slice 5.2 — load persisted task records into the ghost map. Does NOT
   * reconcile (call `reconcile()` after `loadFromDisk()`). Idempotent;
   * subsequent calls overwrite the ghost map.
   *
   * Requires `attachSessionDir()` first; no-op otherwise.
   */
  async loadFromDisk(): Promise<void> {
    if (this.sessionDir === undefined) return;
    this.ghosts.clear();
    const persisted = await listTasks(this.sessionDir);
    for (const t of persisted) {
      // Skip ids that already exist as live processes — live wins.
      if (this.processes.has(t.task_id)) continue;
      this.ghosts.set(t.task_id, persistedToInfo(t));
    }
  }

  /**
   * Slice 5.2 — reconcile loaded ghost tasks. Any ghost with status
   * `running` is reclassified as `lost` (its previous CLI process died
   * without writing a terminal state). Updates the on-disk record and
   * returns the lost task ids so the caller can emit user-facing
   * notifications.
   */
  async reconcile(): Promise<ReconcileResult> {
    const lost: string[] = [];
    const lostInfo: BackgroundTaskInfo[] = [];
    for (const [id, info] of this.ghosts) {
      if (info.status !== 'running') continue;
      const updated: BackgroundTaskInfo = {
        ...info,
        status: 'lost',
        endedAt: info.endedAt ?? Date.now(),
      };
      this.ghosts.set(id, updated);
      if (this.sessionDir !== undefined) {
        await writeTask(this.sessionDir, infoToPersisted(updated));
      }
      lost.push(id);
      lostInfo.push(updated);
    }
    return { lost, lostInfo };
  }

  /** Slice 5.2 — drop a persisted task from disk and ghost map. */
  async forgetTask(taskId: string): Promise<void> {
    this.ghosts.delete(taskId);
    if (this.sessionDir !== undefined) {
      await removeTask(this.sessionDir, taskId);
    }
  }

  /**
   * Persist the current state of a live ManagedProcess. Called from
   * `register()` and the lifecycle finally block. No-op unless attached.
   */
  private persistLive(entry: ManagedProcess): void {
    if (this.sessionDir === undefined) return;
    void writeTask(this.sessionDir, {
      task_id: entry.taskId,
      command: entry.command,
      description: entry.description,
      pid: entry.proc.pid,
      started_at: entry.startedAt,
      ended_at: entry.endedAt,
      exit_code: entry.exitCode,
      status: entry.status,
    });
  }

  private toInfo(entry: ManagedProcess): BackgroundTaskInfo {
    return {
      taskId: entry.taskId,
      command: entry.command,
      description: entry.description,
      status: entry.status,
      pid: entry.proc.pid,
      exitCode: entry.exitCode,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
    };
  }
}

// ── Slice 5.2 — persistence shape <-> in-memory shape ──────────────────

function persistedToInfo(t: PersistedTask): BackgroundTaskInfo {
  return {
    taskId: t.task_id,
    command: t.command,
    description: t.description,
    status: t.status,
    pid: t.pid,
    exitCode: t.exit_code,
    startedAt: t.started_at,
    endedAt: t.ended_at,
  };
}

function infoToPersisted(info: BackgroundTaskInfo): PersistedTask {
  return {
    task_id: info.taskId,
    command: info.command,
    description: info.description,
    pid: info.pid,
    started_at: info.startedAt,
    ended_at: info.endedAt,
    exit_code: info.exitCode,
    status: info.status,
  };
}
