/**
 * Background task persistence helpers (Slice 5.2 T3.2).
 *
 * Each task lives at `<sessionDir>/tasks/<task_id>.json` so a CLI restart
 * can list previously-running tasks (now lost) and emit terminal
 * notifications. Single-file-per-task mirrors Python's layout in
 * `~/.kimi/sessions/<...>/tasks/`.
 *
 * Writes use `atomicWrite` (write-tmp-fsync-rename, Decision #104) so a
 * crash mid-write never leaves a half-truncated file.
 */

import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite } from '../../storage/atomic-write.js';

import type { BackgroundTaskStatus } from './manager.js';

/**
 * Phase 13 D-6 — task id format.
 *
 * `{bash|agent}-{8 chars of [0-9a-z]}`. Strictly enforced by `taskFile()`
 * so neither path-traversal (`../`) nor legacy `bg_<hex>` format can
 * escape through the persistence layer. Python port:
 * `src/kimi_cli/background/store.py` `_VALID_TASK_ID`.
 */
export const VALID_TASK_ID: RegExp = /^(bash|agent)-[0-9a-z]{8}$/;

/** On-disk task representation (snake_case, Python-friendly). */
export interface PersistedTask {
  readonly task_id: string;
  readonly command: string;
  readonly description: string;
  readonly pid: number;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly exit_code: number | null;
  readonly status: BackgroundTaskStatus;
  /**
   * Phase 13 D-1 — reason supplied when the task is marked
   * `awaiting_approval`. Cleared (omitted) when the task leaves that
   * state.
   */
  readonly approval_reason?: string | undefined;
  /**
   * Phase 13 D-8 — true when an agent task was forcibly terminated by
   * its external deadline (`registerAgentTask(..., { timeoutMs })`).
   * An internal `TimeoutError` raised by the agent promise itself is a
   * generic failure and does NOT set this flag.
   */
  readonly timed_out?: boolean | undefined;
}

function tasksDirOf(sessionDir: string): string {
  return join(sessionDir, 'tasks');
}

function taskFile(sessionDir: string, taskId: string): string {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new Error(`Invalid task id: "${taskId}"`);
  }
  return join(tasksDirOf(sessionDir), `${taskId}.json`);
}

/** Atomically write a task's persisted state. Creates dirs as needed. */
export async function writeTask(sessionDir: string, task: PersistedTask): Promise<void> {
  await mkdir(tasksDirOf(sessionDir), { recursive: true, mode: 0o700 });
  const target = taskFile(sessionDir, task.task_id);
  await atomicWrite(target, JSON.stringify(task, null, 2));
}

/** Read a single task file. Returns undefined when missing/corrupt. */
export async function readTask(sessionDir: string, taskId: string): Promise<PersistedTask | undefined> {
  // Path-traversal validation runs before the try/catch so callers see
  // an explicit error instead of a misleading "missing" return.
  const path = taskFile(sessionDir, taskId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as unknown as PersistedTask;
  } catch {
    return undefined;
  }
}

/** Enumerate all persisted tasks for a session. Skips corrupt entries. */
export async function listTasks(sessionDir: string): Promise<PersistedTask[]> {
  let entries: string[];
  try {
    entries = await readdir(tasksDirOf(sessionDir));
  } catch {
    return [];
  }
  const out: PersistedTask[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const taskId = entry.slice(0, -'.json'.length);
    // Phase 13 D-6 — silently skip files whose basename is not a valid
    // task id (stray files, legacy bg_* leftovers, etc.) rather than
    // letting `readTask` throw mid-enumeration.
    if (!VALID_TASK_ID.test(taskId)) continue;
    const task = await readTask(sessionDir, taskId);
    if (task === undefined) continue;
    // Phase 13 §1.4 #7 — guard against corrupt specs: a JSON blob with
    // missing required fields is treated the same as a missing file.
    if (!isValidPersistedTask(task)) continue;
    out.push(task);
  }
  return out;
}

/**
 * Phase 13 §1.4 #7 — validate the parsed JSON actually shapes like a
 * PersistedTask. Cheap shape check (not a full zod schema) — rejects
 * the canonical "spec with missing fields" failure mode Python covers.
 */
function isValidPersistedTask(obj: unknown): obj is PersistedTask {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['task_id'] === 'string' &&
    typeof o['command'] === 'string' &&
    typeof o['description'] === 'string' &&
    typeof o['pid'] === 'number' &&
    typeof o['started_at'] === 'number' &&
    (o['ended_at'] === null || typeof o['ended_at'] === 'number') &&
    (o['exit_code'] === null || typeof o['exit_code'] === 'number') &&
    typeof o['status'] === 'string'
  );
}

/** Remove a task file (idempotent). */
export async function removeTask(sessionDir: string, taskId: string): Promise<void> {
  // Path-traversal validation outside try/catch.
  const path = taskFile(sessionDir, taskId);
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
