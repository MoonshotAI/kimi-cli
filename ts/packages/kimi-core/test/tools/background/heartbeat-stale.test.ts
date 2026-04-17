/**
 * Phase 13 §3.3 / §1.1 #20, #22 — BPM reconcile identifies stale ghost
 * tasks on startup and fires a single `onTerminal` callback (lost) per
 * ghost, deduped on a second reconcile.
 *
 * Uses **real timers** (§R4): reconcile is a batch operation driven by
 * `started_at` comparisons, not setTimeout, so fake timers would only
 * add noise.
 *
 * The broader "BPM ↔ NotificationManager wiring" already lives in
 * `test/soul-plus/notification-task-integration.test.ts` — here we
 * validate the BPM surface (callback shape + idempotency) in isolation.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager.js';
import { writeTask } from '../../../src/tools/background/persist.js';

let sessionDir: string;

beforeEach(async () => {
  sessionDir = join(
    tmpdir(),
    `kimi-hb-stale-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(sessionDir, { recursive: true });
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

describe('BPM reconcile — stale heartbeat ghost detection (§3.3)', () => {
  it('fires onTerminal with status=lost for a stale running ghost', async () => {
    // Seed a ghost that started 1 hour ago and was never closed out.
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    await writeTask(sessionDir, {
      task_id: 'bash-stale000',
      command: 'some_old_cmd',
      description: 'ghost from a prior crash',
      pid: 1234,
      started_at: oneHourAgo,
      ended_at: null,
      exit_code: null,
      status: 'running',
    });

    const mgr = new BackgroundProcessManager();
    const fired: Array<{ taskId: string; status: string }> = [];
    mgr.onTerminal((info) => {
      fired.push({ taskId: info.taskId, status: info.status });
    });
    mgr.attachSessionDir(sessionDir);
    await mgr.loadFromDisk();
    await mgr.reconcile();

    expect(fired).toEqual([{ taskId: 'bash-stale000', status: 'lost' }]);
  });

  it('second reconcile does NOT refire onTerminal for the same ghost', async () => {
    await writeTask(sessionDir, {
      task_id: 'bash-dedup000',
      command: 'x',
      description: 'dedupe stale',
      pid: 99,
      started_at: Date.now() - 30 * 60 * 1000,
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
    await mgr.reconcile();
    expect(fired).toEqual(['bash-dedup000']);
  });
});
