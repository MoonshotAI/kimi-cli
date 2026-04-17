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

import { randomBytes } from 'node:crypto';

import type { KaosProcess } from '@moonshot-ai/kaos';

import { listTasks, removeTask, writeTask, type PersistedTask } from './persist.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Slice 5.2 — `'lost'` is a reconcile-only terminal state. Tasks loaded
 * from disk that were marked `running` at startup but have no live
 * KaosProcess (the previous CLI process died) are reclassified as lost.
 *
 * Phase 13 D-1 — `'awaiting_approval'` is a non-terminal state entered
 * when a background agent task is paused waiting for tool-call approval
 * from the root agent. The BPM state machine is the single source of
 * truth for "is this task actively running vs. gated on approval" — UI
 * reads from BPM instead of reverse-querying the ApprovalRuntime
 * (Soul 铁律 2 is preserved because `awaiting_approval` in BPM does not
 * leak permission vocabulary into Soul).
 */
export type BackgroundTaskStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'lost';

/** Phase 13 D-1 — terminal states tasks never leave once reached. */
const TERMINAL_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set<BackgroundTaskStatus>([
  'completed',
  'failed',
  'killed',
  'lost',
]);

/** Phase 13 D-6 — task kinds with distinct id prefixes. */
export type BackgroundTaskKind = 'bash' | 'agent';

export interface BackgroundTaskInfo {
  readonly taskId: string;
  readonly command: string;
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Phase 13 D-1 — populated only while `status === 'awaiting_approval'`. */
  readonly approvalReason?: string | undefined;
  /** Phase 13 D-8 — true when an agent task was aborted by its deadline. */
  readonly timedOut?: boolean | undefined;
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
  /** Phase 13 D-7 — true once `fireTerminalCallbacks` has already run. */
  terminalFired: boolean;
  /** Phase 13 D-1 — reason carried while awaiting approval. */
  approvalReason?: string | undefined;
  /** Phase 13 D-8 — set when a deadline fires before natural completion. */
  timedOut?: boolean | undefined;
}

/** Maximum bytes of combined output kept per task (ring-buffer style). */
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

const SIGTERM_GRACE_MS = 5_000;

const _ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Phase 13 D-6 — generate `{prefix}-{8 base36 chars}`.
 *
 * `randomBytes(8) % 36` has a modest modulo bias (256 % 36 = 4) but
 * over an 8-char suffix yields ~36^8 ≈ 2.8e12 distinct ids which is
 * more than enough uniqueness for per-session task ids.
 */
export function generateTaskId(kind: BackgroundTaskKind): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += _ALPHABET[bytes[i]! % 36];
  }
  return `${kind}-${suffix}`;
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
   * Slice 6.1 — registered terminal-state callbacks. Fired once per task
   * when the task reaches a terminal state (completed / failed / killed).
   */
  private readonly terminalCallbacks: Array<(info: BackgroundTaskInfo) => void | Promise<void>> = [];

  /**
   * Slice 6.1 — register a callback that fires when any task reaches a
   * terminal state. The callback receives the task's `BackgroundTaskInfo`
   * snapshot. Multiple callbacks may be registered; they are invoked in
   * registration order. Errors thrown by callbacks are silently swallowed.
   */
  onTerminal(callback: (info: BackgroundTaskInfo) => void | Promise<void>): void {
    this.terminalCallbacks.push(callback);
  }

  /**
   * Slice 6.1 + Phase 13 D-7 — fire all registered terminal callbacks
   * for a task. Idempotent: the second invocation for the same task is
   * a no-op so `reconcile()` / a lagging `wait()` resolver / a race
   * between `stop()` and natural exit cannot yield duplicate
   * notifications. This is the manager-side half of the dedupe pact
   * with `NotificationManager.dedupe_key`.
   */
  private fireTerminalCallbacks(entry: ManagedProcess): void {
    if (entry.terminalFired) return;
    entry.terminalFired = true;
    const info = this.toInfo(entry);
    for (const cb of this.terminalCallbacks) {
      try {
        const result = cb(info);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {});
        }
      } catch {
        /* swallow callback errors */
      }
    }
  }

  /**
   * Register a KaosProcess as a background task.
   * Starts capturing stdout/stderr and monitors lifecycle via `wait()`.
   * Returns the assigned task ID.
   *
   * Phase 13 D-6 — `opts.kind` picks the id prefix. Defaults to `'bash'`
   * because bash subprocess registration is the only caller on the
   * process path today; agent tasks go through `registerAgentTask`
   * which forces `'agent'`.
   */
  register(
    proc: KaosProcess,
    command: string,
    description: string,
    opts:
      | {
          kind?: BackgroundTaskKind;
          /**
           * Phase 14 §1.4 — optional shell metadata. Carried so the
           * `/task` UI and background persist snapshot can surface which
           * dialect a task was launched under. Legacy callers omitting
           * this field keep the implicit 'bash' default.
           */
          shellInfo?: {
            shellName: string;
            shellPath: string;
            cwd: string;
          };
        }
      | undefined = undefined,
  ): string {
    const kind = opts?.kind;
    const taskId = generateTaskId(kind ?? 'bash');
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
      terminalFired: false,
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
        // §1.1 #4 — when `proc.wait()` rejects (launch failed / stream
        // error) mark the task `failed` so a rejected-launch Kaos never
        // leaks as a zombie "running" task.
        if (!TERMINAL_STATUSES.has(entry.status)) {
          entry.status = 'failed';
          entry.endedAt = Date.now();
        }
      })
      .finally(() => {
        // Slice 5.2 — persist terminal state.
        this.persistLive(entry);
        // Slice 6.1 — notify terminal callbacks.
        this.fireTerminalCallbacks(entry);
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
      // Phase 13 D-1 — an awaiting_approval task is non-terminal and
      // therefore counts as active in listings (UI needs to show it
      // alongside plain running tasks).
      if (activeOnly && TERMINAL_STATUSES.has(entry.status)) continue;
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
    // Terminal tasks short-circuit. awaiting_approval tasks can still
    // be stopped (the approval gate is lifted when we transition to
    // 'killed').
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);

    entry.status = 'killed';
    entry.approvalReason = undefined;

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

    // Agent tasks whose completion promise never settles (no timeoutMs,
    // or a truly hung coroutine) need an explicit terminal fire here —
    // otherwise `onTerminal` subscribers and `waitForTerminal` /
    // `wait` waiters never resolve. `fireTerminalCallbacks` is guarded
    // by `terminalFired`, so the register()-side `.finally` is a no-op
    // if it ever does run later. For bash tasks this is redundant but
    // harmless (proc.wait() already resolved above, the register() path
    // may have already fired — idempotent).
    entry.endedAt ??= Date.now();
    this.persistLive(entry);
    this.fireTerminalCallbacks(entry);
    for (const resolve of entry.waiters) resolve();
    entry.waiters.length = 0;

    return this.toInfo(entry);
  }

  /**
   * Wait for a task to reach a terminal state.
   * Returns immediately if already terminal. Times out after `timeoutMs`.
   */
  async wait(taskId: string, timeoutMs = 30_000): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.processes.get(taskId);
    if (!entry) return undefined;
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      entry.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    return this.toInfo(entry);
  }

  /**
   * Slice 5.3 — register a Promise-based agent task (no KaosProcess).
   * Used by AgentTool for background subagent dispatch. Agent tasks
   * appear in `list()` / `getTask()` but have pid=0 and empty output.
   *
   * Phase 13 D-8 — `opts.timeoutMs` wraps the completion in an external
   * deadline. On deadline fire, the task is marked `failed` with
   * `timedOut=true` (distinct from a caller-driven `stop()` which uses
   * `killed`, and distinct from an internal `TimeoutError` rejection
   * which is a generic `failed` with `timedOut` left unset — matching
   * `BackgroundAgentRunner` semantics in Python).
   */
  registerAgentTask(
    completion: Promise<{ result: string }>,
    description: string,
    opts: { timeoutMs?: number } = {},
  ): string {
    const taskId = generateTaskId('agent');
    const entry: ManagedProcess = {
      taskId,
      command: `[agent] ${description}`,
      description,
      // Dummy KaosProcess — agent tasks are Promise-based, not process-based
      proc: {
        stdin: { write: () => false, end: () => {} } as never,
        stdout: { setEncoding: () => {}, on: () => {} } as never,
        stderr: { setEncoding: () => {}, on: () => {} } as never,
        pid: 0,
        exitCode: null,
        wait: () => completion.then(() => 0),
        kill: async () => {},
      } as unknown as KaosProcess,
      outputChunks: [],
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      waiters: [],
      terminalFired: false,
    };
    this.processes.set(taskId, entry);
    this.persistLive(entry);

    // Phase 13 D-8 — deadline symbol distinguishes "external timeout
    // fired" from "the agent promise itself rejected with TimeoutError"
    // (which must remain a generic failure, not a deadline timeout).
    const deadlineTimeout = Symbol('deadline-timeout');
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const raceInputs: Array<Promise<unknown>> = [completion];
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      raceInputs.push(
        new Promise((resolve) => {
          deadlineTimer = setTimeout(() => {
            resolve(deadlineTimeout);
          }, opts.timeoutMs);
        }),
      );
    }

    void Promise.race(raceInputs)
      .then((outcome) => {
        if (outcome === deadlineTimeout) {
          // External deadline fired before the agent resolved.
          if (TERMINAL_STATUSES.has(entry.status)) return;
          entry.status = 'failed';
          entry.timedOut = true;
          entry.exitCode = 1;
          entry.endedAt = Date.now();
          return;
        }
        // `completion` resolved before deadline.
        const r = outcome as { result: string };
        if (entry.status === 'killed') {
          entry.endedAt ??= Date.now();
          return;
        }
        entry.status = 'completed';
        entry.exitCode = 0;
        entry.endedAt = Date.now();
        entry.outputChunks.push(r.result);
      })
      .catch(() => {
        if (entry.status === 'killed') {
          entry.endedAt ??= Date.now();
          return;
        }
        // Internal rejection (including TimeoutError): generic failure.
        // `timedOut` stays unset so consumers can distinguish this from
        // a true external deadline.
        entry.status = 'failed';
        entry.exitCode = 1;
        entry.endedAt = Date.now();
      })
      .finally(() => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        this.persistLive(entry);
        this.fireTerminalCallbacks(entry);
        for (const resolve of entry.waiters) resolve();
        entry.waiters.length = 0;
      });

    return taskId;
  }

  // ── Phase 13 D-1 — awaiting_approval state transitions ─────────────

  /**
   * Phase 13 D-1 — mark a running task as paused pending approval. The
   * approval reason (tool call description) is retained until the task
   * either returns to `'running'` via `clearAwaitingApproval()` or
   * reaches a terminal state. Calls on terminal or unknown tasks are
   * silently ignored so the ApprovalRuntime callback path is race-safe.
   */
  markAwaitingApproval(taskId: string, reason: string): void {
    const entry = this.processes.get(taskId);
    if (!entry) return;
    if (TERMINAL_STATUSES.has(entry.status)) return;
    entry.status = 'awaiting_approval';
    entry.approvalReason = reason;
    this.persistLive(entry);
  }

  /**
   * Phase 13 D-1 — drop the approval gate and return to `'running'`.
   * Clears the stored reason so stale text cannot leak into a future
   * `awaiting_approval` cycle. No-op unless the task is currently in
   * the awaiting_approval state.
   */
  clearAwaitingApproval(taskId: string): void {
    const entry = this.processes.get(taskId);
    if (!entry) return;
    if (entry.status !== 'awaiting_approval') return;
    entry.status = 'running';
    entry.approvalReason = undefined;
    this.persistLive(entry);
  }

  // ── Phase 13 D-7 — completion event (await lifecycle end) ──────────

  /**
   * Phase 13 D-7 — resolve when the task reaches a terminal state. If
   * the task is already terminal, resolves synchronously on the next
   * microtask. Intended for integration code that wants to `await` a
   * specific task's exit without installing a full `onTerminal`
   * subscriber. Returns `undefined` for unknown ids (matching
   * `getTask`). Ghost (reconciled-lost) entries are considered
   * terminal from the manager's perspective.
   */
  async waitForTerminal(taskId: string): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.processes.get(taskId);
    if (entry === undefined) return this.ghosts.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);
    await new Promise<void>((resolve) => {
      entry.waiters.push(resolve);
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
      // Phase 13 §1.1 #20/#22 — any non-terminal ghost is lost.
      // Includes `awaiting_approval` (the approval context died with
      // the previous process so it cannot be resumed).
      if (TERMINAL_STATUSES.has(info.status)) continue;
      const updated: BackgroundTaskInfo = {
        ...info,
        status: 'lost',
        endedAt: info.endedAt ?? Date.now(),
        approvalReason: undefined,
      };
      this.ghosts.set(id, updated);
      if (this.sessionDir !== undefined) {
        await writeTask(this.sessionDir, infoToPersisted(updated));
      }
      lost.push(id);
      lostInfo.push(updated);
    }
    // Phase 13 D-7 §1.1 #20 — fire onTerminal for newly-lost ghosts so
    // NotificationManager receives a `task.lost` notification. Dedupe
    // on the consumer side is by `dedupe_key`, which already includes
    // the terminal status in its shape; a second reconcile() on the
    // same ghost is a no-op because the status flips to `lost` above
    // and we guard on TERMINAL_STATUSES on the next pass (§1.1 #22).
    for (const info of lostInfo) {
      for (const cb of this.terminalCallbacks) {
        try {
          const result = cb(info);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch(() => {});
          }
        } catch {
          /* swallow */
        }
      }
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
      approval_reason: entry.approvalReason,
      timed_out: entry.timedOut,
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
      approvalReason: entry.approvalReason,
      timedOut: entry.timedOut,
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
    approvalReason: t.approval_reason,
    timedOut: t.timed_out,
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
    approval_reason: info.approvalReason,
    timed_out: info.timedOut,
  };
}
