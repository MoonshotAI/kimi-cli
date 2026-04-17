/**
 * Phase 13 D-1 — `awaiting_approval` state transitions.
 *
 * Migrates Python `tests/background/test_manager.py` §§1.1 #1 / #9 /
 * #10 / #15 / #17. The TS BPM has 6 states after D-1:
 *   running ↔ awaiting_approval → {completed, failed, killed, lost}
 *
 * Semantics:
 *   - mark / clear are no-ops unless the target task exists and is not
 *     terminal
 *   - UI reads the BPM state directly (ApprovalRuntime remains the
 *     policy layer); BPM is the single source of truth for "is this
 *     task actively running or gated"
 *   - `stop()` applied to an awaiting_approval task transitions
 *     straight to `killed` with the approvalReason cleared
 */

import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager.js';

function pendingProcess(): { proc: KaosProcess; resolve: (code: number) => void } {
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  const proc: KaosProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 42_042,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: vi.fn(async () => {
      if (currentExitCode === null) {
        currentExitCode = 143;
        resolveWait(143);
      }
    }) as unknown as KaosProcess['kill'],
  };
  return {
    proc,
    resolve: (code) => {
      if (currentExitCode === null) {
        currentExitCode = code;
        resolveWait(code);
      }
    },
  };
}

describe('BackgroundProcessManager — awaiting_approval state (D-1)', () => {
  const manager = new BackgroundProcessManager();

  afterEach(() => {
    manager._reset();
  });

  it('markAwaitingApproval flips running → awaiting_approval and stores reason', () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'sleep 999', 'approval test');

    manager.markAwaitingApproval(taskId, 'Write to /etc/hosts');
    const info = manager.getTask(taskId);
    expect(info?.status).toBe('awaiting_approval');
    expect(info?.approvalReason).toBe('Write to /etc/hosts');
  });

  it('clearAwaitingApproval flips awaiting_approval → running and drops reason', () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    manager.markAwaitingApproval(taskId, 'do thing');

    manager.clearAwaitingApproval(taskId);
    const info = manager.getTask(taskId);
    expect(info?.status).toBe('running');
    expect(info?.approvalReason).toBeUndefined();
  });

  it('markAwaitingApproval is a no-op on terminal tasks', async () => {
    const { proc, resolve } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    resolve(0);
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(manager.getTask(taskId)?.status).toBe('completed');

    manager.markAwaitingApproval(taskId, 'too late');
    // Status and approvalReason unchanged.
    const info = manager.getTask(taskId);
    expect(info?.status).toBe('completed');
    expect(info?.approvalReason).toBeUndefined();
  });

  it('stop on an awaiting_approval task flips to killed and clears reason', async () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    manager.markAwaitingApproval(taskId, 'waiting…');

    const stopped = await manager.stop(taskId);
    expect(stopped?.status).toBe('killed');
    expect(stopped?.approvalReason).toBeUndefined();
  });

  it('list(true) includes awaiting_approval (non-terminal is active)', () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    manager.markAwaitingApproval(taskId, 'waiting…');

    const active = manager.list(true);
    expect(active).toHaveLength(1);
    expect(active[0]?.status).toBe('awaiting_approval');
  });

  it('clearAwaitingApproval on a non-awaiting task is a no-op', () => {
    const { proc } = pendingProcess();
    const taskId = manager.register(proc, 'x', 'd');
    // Task is still `running` — nothing to clear.
    manager.clearAwaitingApproval(taskId);
    expect(manager.getTask(taskId)?.status).toBe('running');
  });
});
