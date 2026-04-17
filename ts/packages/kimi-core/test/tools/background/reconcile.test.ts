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
      task_id: 'bash-orphan00',
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

    expect(result.lost).toEqual(['bash-orphan00']);
    expect(result.lostInfo).toHaveLength(1);
    expect(result.lostInfo[0]?.status).toBe('lost');
    // Persisted state updated
    const onDisk = await listTasks(sessionDir);
    expect(onDisk[0]?.status).toBe('lost');
  });

  it('does not reclassify already-terminal tasks', async () => {
    await writeTask(sessionDir, {
      task_id: 'bash-done0000',
      command: 'echo hi',
      description: 'echo',
      pid: 88888,
      started_at: 1_700_000_000,
      ended_at: 1_700_000_010,
      exit_code: 0,
      status: 'completed',
    });
    await writeTask(sessionDir, {
      task_id: 'bash-running0',
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
    expect([...result.lost].sort()).toEqual(['bash-running0']);

    const all = await listTasks(sessionDir);
    const byId = new Map(all.map((t) => [t.task_id, t]));
    expect(byId.get('bash-done0000')?.status).toBe('completed');
    expect(byId.get('bash-running0')?.status).toBe('lost');
  });

  it('list(activeOnly=false) includes ghosts; list(true) excludes them', async () => {
    await writeTask(sessionDir, {
      task_id: 'bash-lost0000',
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
      task_id: 'bash-ghost000',
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
    const t = mgr.getTask('bash-ghost000');
    expect(t?.status).toBe('lost');
  });

  it('forgetTask drops ghost and disk entry', async () => {
    await writeTask(sessionDir, {
      task_id: 'bash-forget00',
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
    await mgr.forgetTask('bash-forget00');
    expect(mgr.getTask('bash-forget00')).toBeUndefined();
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

  // ── Phase 13 §1.1 — migrated from Python test_manager.py ────────────

  it('reconcile fires onTerminal for each newly-lost ghost (§1.1 #20, D-7)', async () => {
    await writeTask(sessionDir, {
      task_id: 'bash-publish0',
      command: 'sleep 9999',
      description: 'publish lost',
      pid: 42,
      started_at: 1_700_000_000,
      ended_at: null,
      exit_code: null,
      status: 'running',
    });
    const mgr = new BackgroundProcessManager();
    const fired: { taskId: string; status: string }[] = [];
    mgr.onTerminal((info) => {
      fired.push({ taskId: info.taskId, status: info.status });
    });
    mgr.attachSessionDir(sessionDir);
    await mgr.loadFromDisk();
    await mgr.reconcile();

    expect(fired).toHaveLength(1);
    expect(fired[0]?.taskId).toBe('bash-publish0');
    expect(fired[0]?.status).toBe('lost');
  });

  it('reconcile treats corrupted runtime (awaiting_approval ghost) as lost (§1.1 #21)', async () => {
    // awaiting_approval is non-terminal — when the previous process
    // died mid-approval, the task cannot possibly resume; reconcile
    // must downgrade it to `lost` just like a running ghost.
    await writeTask(sessionDir, {
      task_id: 'bash-corrupt0',
      command: 'do_approval',
      description: 'corrupted approval',
      pid: 7777,
      started_at: 1_700_000_000,
      ended_at: null,
      exit_code: null,
      status: 'awaiting_approval',
      approval_reason: 'ghost reason that should be cleared',
    });
    const mgr = new BackgroundProcessManager();
    mgr.attachSessionDir(sessionDir);
    await mgr.loadFromDisk();
    const result = await mgr.reconcile();

    expect(result.lost).toEqual(['bash-corrupt0']);
    expect(result.lostInfo[0]?.status).toBe('lost');
    expect(result.lostInfo[0]?.approvalReason).toBeUndefined();
  });

  it('reconcile does not republish already-lost ghosts on second pass (§1.1 #22)', async () => {
    await writeTask(sessionDir, {
      task_id: 'bash-nodup000',
      command: 'sleep 9999',
      description: 'dedupe check',
      pid: 42,
      started_at: 1_700_000_000,
      ended_at: null,
      exit_code: null,
      status: 'running',
    });
    const mgr = new BackgroundProcessManager();
    const fired: string[] = [];
    mgr.onTerminal((info) => {
      fired.push(info.taskId);
    });
    mgr.attachSessionDir(sessionDir);
    await mgr.loadFromDisk();
    await mgr.reconcile();
    // Second reconcile should find nothing to downgrade.
    const again = await mgr.reconcile();
    expect(again.lost).toEqual([]);
    expect(fired).toEqual(['bash-nodup000']);
  });
});
