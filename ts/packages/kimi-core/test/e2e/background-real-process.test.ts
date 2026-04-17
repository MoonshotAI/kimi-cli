/**
 * Phase 13 §1.1 #25 / #26 — BackgroundProcessManager wired to a real
 * `node` subprocess via `localKaos.exec` (no KaosProcess mocks).
 *
 * Migrates Python `tests/background/test_manager.py::test_manager_
 * launches_real_worker_and_waits` (L1004) and `::test_manager_surfaces_
 * timeout_failure` (L1024). The Python tests drive a real Python
 * worker; the TS port uses `node -e` so we don't need a shared worker
 * binary — the manager's external contract (register → wait → stop) is
 * identical either way.
 *
 * NB: real `child_process` = real timers. Never combine this file with
 * `vi.useFakeTimers()` (§R4).
 */

import { localKaos } from '@moonshot-ai/kaos';
import { describe, expect, it } from 'vitest';

import { BackgroundProcessManager } from '../../src/tools/background/manager.js';

describe('BackgroundProcessManager — real subprocess end-to-end', () => {
  it('launches a real node subprocess and waits for completion (§1.1 #25)', async () => {
    const mgr = new BackgroundProcessManager();
    const proc = await localKaos.exec('node', '-e', "console.log('bg-ok')");
    const taskId = mgr.register(proc, "node -e console.log('bg-ok')", 'real proc');

    const info = await mgr.wait(taskId, 10_000);
    expect(info?.status).toBe('completed');
    expect(info?.exitCode).toBe(0);

    // Output propagated through the ring buffer.
    const output = mgr.getOutput(taskId);
    expect(output).toContain('bg-ok');
  }, 30_000);

  it('stop() kills a real long-running subprocess (§1.1 #26)', async () => {
    const mgr = new BackgroundProcessManager();
    // `node -e 'setInterval(() => {}, 1000)'` keeps the event loop
    // alive indefinitely — we use `stop()` as the caller-driven
    // deadline analog since TS BPM uses AbortSignal/stop() instead
    // of a per-task timeout wrapper (D-4 = keep KaosProcess fork).
    const proc = await localKaos.exec('node', '-e', 'setInterval(() => {}, 1000);');
    const taskId = mgr.register(proc, 'node -e setInterval', 'long running');

    const stopped = await mgr.stop(taskId);
    expect(stopped?.status).toBe('killed');

    // After stop returns, waiters see the terminal state too.
    const finalInfo = await mgr.wait(taskId, 5_000);
    expect(finalInfo?.status).toBe('killed');
  }, 30_000);
});
