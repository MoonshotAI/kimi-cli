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
import { basename, join } from 'node:path';

import { atomicWrite } from '../../storage/atomic-write.js';

import type { BackgroundTaskStatus } from './manager.js';

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
}

function tasksDirOf(sessionDir: string): string {
  return join(sessionDir, 'tasks');
}

function taskFile(sessionDir: string, taskId: string): string {
  // Path-traversal guard: callers are internal but defense-in-depth.
  const safe = basename(taskId);
  if (safe.length === 0 || safe !== taskId) {
    throw new Error(`Invalid task id: "${taskId}"`);
  }
  return join(tasksDirOf(sessionDir), `${safe}.json`);
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
    const task = await readTask(sessionDir, taskId);
    if (task !== undefined) out.push(task);
  }
  return out;
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
