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

// ── Types ────────────────────────────────────────────────────────────

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

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

let nextTaskNum = 1;

function generateTaskId(): string {
  return `bg_${String(nextTaskNum++)}`;
}

// ── Manager ──────────────────────────────────────────────────────────

export class BackgroundProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

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
        for (const resolve of entry.waiters) resolve();
        entry.waiters.length = 0;
      });

    return taskId;
  }

  /** Get info about a specific task. */
  getTask(taskId: string): BackgroundTaskInfo | undefined {
    const entry = this.processes.get(taskId);
    if (!entry) return undefined;
    return this.toInfo(entry);
  }

  /** List tasks, optionally filtering to active-only. */
  list(activeOnly = true, limit = 20): BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = [];
    for (const entry of this.processes.values()) {
      if (activeOnly && entry.status !== 'running') continue;
      result.push(this.toInfo(entry));
      if (result.length >= limit) break;
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
