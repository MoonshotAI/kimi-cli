/**
 * Covers: BackgroundProcessManager (Slice 3.5).
 *
 * Uses KaosProcess fakes — the manager now accepts KaosProcess directly
 * (M2 fix: no more ChildProcess dependency).
 */

import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager.js';

/**
 * Creates a KaosProcess that completes immediately with the given exit code.
 * stdout emits `stdoutText` if provided.
 */
function immediateProcess(exitCode: number, stdoutText = ''): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 10000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    // oxlint-disable-next-line unicorn/no-useless-undefined
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
  };
}

/**
 * Creates a KaosProcess that stays running until `kill()` is called.
 * Calling `kill()` resolves `wait()` with `exitOnKill`.
 */
function pendingProcess(exitOnKill = 143): {
  proc: KaosProcess;
  killSpy: ReturnType<typeof vi.fn>;
} {
  let resolveWait: (n: number) => void = () => {
    /* replaced below */
  };
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async () => {
    if (currentExitCode === null) {
      currentExitCode = exitOnKill;
      resolveWait(exitOnKill);
    }
  });
  const proc: KaosProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as KaosProcess['kill'],
  };
  return { proc, killSpy };
}

describe('BackgroundProcessManager', () => {
  const manager = new BackgroundProcessManager();

  afterEach(() => {
    manager._reset();
  });

  it('register returns a task ID and tracks the process', () => {
    const proc = immediateProcess(0);
    const taskId = manager.register(proc, 'echo hello', 'test echo');
    // Phase 13 D-6 — id format is `{bash|agent}-{8 base36}`.
    expect(taskId).toMatch(/^bash-[0-9a-z]{8}$/);
    const info = manager.getTask(taskId);
    expect(info).toBeDefined();
    expect(info!.command).toBe('echo hello');
    expect(info!.description).toBe('test echo');
    expect(info!.pid).toBe(proc.pid);
  });

  // ── Phase 13 §1.1 — migrated from Python test_manager.py ─────────────

  it('records failed runtime when proc.wait() rejects (§1.1 #4)', async () => {
    // Simulate a Kaos launch that resolves into a KaosProcess whose
    // subsequent wait() rejects (e.g. shell fork failure mid-exec).
    const proc: KaosProcess = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      pid: 99999,
      exitCode: null,
      wait: vi.fn().mockRejectedValue(new Error('launch failed')) as KaosProcess['wait'],
      // oxlint-disable-next-line unicorn/no-useless-undefined
      kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    };
    const taskId = manager.register(proc, '/bogus/cmd', 'broken launch');

    // Let the wait() rejection propagate through the .finally block.
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const info = manager.getTask(taskId);
    expect(info!.status).toBe('failed');
    expect(info!.endedAt).not.toBeNull();
  });

  it('registerAgentTask registers as running with agent- id prefix (§1.1 #5)', () => {
    // Promise that never resolves — we only inspect the initial register
    // snapshot here.
    const taskId = manager.registerAgentTask(new Promise(() => {}), 'agent task');
    expect(taskId).toMatch(/^agent-[0-9a-z]{8}$/);
    const info = manager.getTask(taskId);
    expect(info).toBeDefined();
    expect(info!.status).toBe('running');
    // Agent tasks use pid=0 (dummy KaosProcess).
    expect(info!.pid).toBe(0);
    // Spec marker: command includes the `[agent]` tag so LLM renderers
    // can distinguish bash vs agent entries when scrolling tasks.
    expect(info!.command).toContain('[agent]');
  });

  it('getTask on an unknown id does not touch disk or create state (§1.1 #11)', () => {
    // Live + ghost maps stay untouched; no partial creation.
    const before = manager.list(false).length;
    expect(manager.getTask('bash-deadbeef')).toBeUndefined();
    const after = manager.list(false).length;
    expect(after).toBe(before);
  });

  it('list returns active tasks by default', () => {
    const { proc: proc1 } = pendingProcess();
    const { proc: proc2 } = pendingProcess();
    manager.register(proc1, 'sleep 60', 'task 1');
    manager.register(proc2, 'sleep 60', 'task 2');
    const active = manager.list(true);
    expect(active.length).toBe(2);
  });

  it('getOutput returns captured stdout', async () => {
    const proc = immediateProcess(0, 'captured output\n');
    const taskId = manager.register(proc, 'echo captured output', 'capture test');

    // Allow the wait() promise and stream data events to settle.
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    const output = manager.getOutput(taskId);
    expect(output).toContain('captured output');
  });

  it('task status transitions to completed on exit code 0', async () => {
    const proc = immediateProcess(0, 'done');
    const taskId = manager.register(proc, 'echo done', 'completion test');

    // Allow the wait() promise to settle.
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const info = manager.getTask(taskId);
    expect(info!.status).toBe('completed');
    expect(info!.exitCode).toBe(0);
  });

  it('task status transitions to failed on non-zero exit', async () => {
    const proc = immediateProcess(42);
    const taskId = manager.register(proc, 'exit 42', 'fail test');

    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const info = manager.getTask(taskId);
    expect(info!.status).toBe('failed');
    expect(info!.exitCode).toBe(42);
  });

  it('stop kills a running task via KaosProcess.kill()', async () => {
    const { proc, killSpy } = pendingProcess(143);
    const taskId = manager.register(proc, 'sleep 60', 'kill test');

    const result = await manager.stop(taskId);
    expect(result).toBeDefined();
    expect(result!.status).toBe('killed');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });

  it('wait resolves when task completes', async () => {
    const proc = immediateProcess(0, 'fast');
    const taskId = manager.register(proc, 'echo fast', 'wait test');

    const info = await manager.wait(taskId, 5000);
    expect(info).toBeDefined();
    expect(info!.status).toBe('completed');
  });

  it('getTask returns undefined for unknown ID', () => {
    expect(manager.getTask('bash-nonexist')).toBeUndefined();
  });

  it('getOutput returns empty string for unknown ID', () => {
    expect(manager.getOutput('bash-nonexist')).toBe('');
  });

  it('stop returns terminal info for already-exited task', async () => {
    const proc = immediateProcess(0);
    const taskId = manager.register(proc, 'echo done', 'already done');

    // Let wait() settle first.
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const result = await manager.stop(taskId);
    expect(result).toBeDefined();
    expect(result!.status).toBe('completed');
  });
});
