/**
 * Phase 13 §1.2 D-8 — `registerAgentTask` `timeoutMs` option.
 *
 * Ports Python `tests/background/test_agent_timeout.py` (3 cases).
 *
 * Semantics:
 *   - external deadline fires → status=`failed`, `timedOut=true`
 *   - no `timeoutMs` → the task runs to completion without a wrapper
 *   - internal `TimeoutError` rejection (e.g. aiohttp sock_read) is a
 *     generic `failed` with `timedOut` left unset — the flag must
 *     only be set for the caller-driven deadline
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager.js';

describe('BackgroundProcessManager.registerAgentTask — timeoutMs (D-8)', () => {
  const manager = new BackgroundProcessManager();

  afterEach(() => {
    manager._reset();
    vi.useRealTimers();
  });

  it('external deadline marks task failed with timedOut=true', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // A never-resolving completion — only the deadline will fire.
    const hangForever = new Promise<{ result: string }>(() => {});
    const taskId = manager.registerAgentTask(hangForever, 'hang', { timeoutMs: 2_000 });

    // Advance past the deadline; awaitTerminal resolves once the race
    // finishes and the `.finally` block runs.
    const terminalPromise = manager.waitForTerminal(taskId);
    await vi.advanceTimersByTimeAsync(2_100);
    const info = await terminalPromise;

    expect(info?.status).toBe('failed');
    expect(info?.timedOut).toBe(true);
  });

  it('omitting timeoutMs lets the task run to completion (no wrapper)', async () => {
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = manager.registerAgentTask(completion, 'no deadline');

    resolveFn({ result: 'finished' });
    const info = await manager.waitForTerminal(taskId);
    expect(info?.status).toBe('completed');
    expect(info?.timedOut).toBeUndefined();
  });

  it('internal TimeoutError rejection = generic failure, timedOut unset', async () => {
    // Even with a deadline set, an internal TimeoutError that fires
    // BEFORE the deadline must land as a plain `failed` (Python
    // `BackgroundAgentRunner._run`'s TimeoutError branch for
    // `__cause__` not being CancelledError).
    const internalErr = new Error('aiohttp sock_read timeout');
    internalErr.name = 'TimeoutError';
    const rejecting = Promise.reject(internalErr);
    const taskId = manager.registerAgentTask(rejecting, 'internal timeout', {
      timeoutMs: 900_000,
    });

    const info = await manager.waitForTerminal(taskId);
    expect(info?.status).toBe('failed');
    // Deadline never fired → timedOut must NOT be set.
    expect(info?.timedOut).toBeUndefined();
  });
});
