/**
 * BackgroundProcessManager reconcile + persistence integration (Slice 5.2).
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager.js';
import { writeTask, listTasks } from '../../../src/tools/background/persist.js';

let sessionDir: string;

beforeEach(async () => {
  sessionDir = join(tmpdir(), `kimi-bg-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(sessionDir, { recursive: true });
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

describe('BackgroundProcessManager — loadFromDisk + reconcile', () => {
  it('loadFromDisk does nothing when sessionDir not attached', async () => {
    const mgr = new BackgroundProcessManager();
    await mgr.loadFromDisk();
    expect(mgr.list(false)).toEqual([]);
  });

  it('reconciles a previously-running task as lost', async () => {
    // Seed disk as if a previous CLI process registered a task.
    await writeTask(sessionDir, {
      task_id: 'bg_orphan',
      command: 'npm install',
      description: 'install',
      pid: 99999,
      started_at: 1_700_000_000,
      ended_at: null,
      exit_code: null,
      status: 'running',
    });

    const mgr = new BackgroundProcessManager();
    mgr.attachSessionDir(sessionDir);
    await mgr.loadFromDisk();
    const result = await mgr.reconcile();

    expect(result.lost).toEqual(['bg_orphan']);
    expect(result.lostInfo).toHaveLength(1);
    expect(result.lostInfo[0]?.status).toBe('lost');
    // Persisted state updated
    const onDisk = await listTasks(sessionDir);
    expect(onDisk[0]?.status).toBe('lost');
  });

  it('does not reclassify already-terminal tasks', async () => {
    await writeTask(sessionDir, {
      task_id: 'bg_done',
      command: 'echo hi',
      description: 'echo',
      pid: 88888,
      started_at: 1_700_000_000,
      ended_at: 1_700_000_010,
      exit_code: 0,
      status: 'completed',
    });
    await writeTask(sessionDir, {
      task_id: 'bg_running',
      command: 'sleep 1000',
      description: 'sleep',
      pid: 77777,
      started_at: 1_700_000_000,
      ended_at: null,
      exit_code: null,
      status: 'running',
    });

    const mgr = new BackgroundProcessManager();
    mgr.attachSessionDir(sessionDir);
    await mgr.loadFromDisk();
    const result = await mgr.reconcile();
    expect([...result.lost].sort()).toEqual(['bg_running']);

    const all = await listTasks(sessionDir);
    const byId = new Map(all.map((t) => [t.task_id, t]));
    expect(byId.get('bg_done')?.status).toBe('completed');
    expect(byId.get('bg_running')?.status).toBe('lost');
  });

  it('list(activeOnly=false) includes ghosts; list(true) excludes them', async () => {
    await writeTask(sessionDir, {
      task_id: 'bg_lost_one',
      command: 'x',
      description: 'd',
      pid: 1,
      started_at: 0,
      ended_at: null,
      exit_code: null,
      status: 'running',
    });
    const mgr = new BackgroundProcessManager();
    mgr.attachSessionDir(sessionDir);
    await mgr.loadFromDisk();
    await mgr.reconcile();
    expect(mgr.list(true)).toEqual([]);  // active-only: no live tasks
    const all = mgr.list(false);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('lost');
  });

  it('getTask returns ghost when the live process map has no entry', async () => {
    await writeTask(sessionDir, {
      task_id: 'bg_ghost',
      command: 'x',
      description: 'd',
      pid: 1,
      started_at: 0,
      ended_at: null,
      exit_code: null,
      status: 'running',
    });
    const mgr = new BackgroundProcessManager();
    mgr.attachSessionDir(sessionDir);
    await mgr.loadFromDisk();
    await mgr.reconcile();
    const t = mgr.getTask('bg_ghost');
    expect(t?.status).toBe('lost');
  });

  it('forgetTask drops ghost and disk entry', async () => {
    await writeTask(sessionDir, {
      task_id: 'bg_forget',
      command: 'x',
      description: 'd',
      pid: 1,
      started_at: 0,
      ended_at: null,
      exit_code: null,
      status: 'running',
    });
    const mgr = new BackgroundProcessManager();
    mgr.attachSessionDir(sessionDir);
    await mgr.loadFromDisk();
    await mgr.reconcile();
    await mgr.forgetTask('bg_forget');
    expect(mgr.getTask('bg_forget')).toBeUndefined();
    expect(await listTasks(sessionDir)).toEqual([]);
  });

  it('reconcile returns empty when no ghosts loaded', async () => {
    const mgr = new BackgroundProcessManager();
    mgr.attachSessionDir(sessionDir);
    await mgr.loadFromDisk();
    const result = await mgr.reconcile();
    expect(result.lost).toEqual([]);
    expect(result.lostInfo).toEqual([]);
  });
});
