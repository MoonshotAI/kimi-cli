/**
 * Covers: BashTool (v2 §9-F / Appendix E.4).
 *
 * Pins:
 *   - Basic command execution (echo / ls)
 *   - Working directory passthrough
 *   - Non-zero exit code → isError
 *   - Timeout handling
 *   - stdout / stderr in structured output
 *   - getActivityDescription truncation
 *   - Execution goes through Kaos, not direct child_process
 *
 * Audit M1 regression:
 *   - Timeout kills the subprocess and fail-reports (fake timers + pending proc)
 *   - Abort signal kills the subprocess and fail-reports
 *   - stdin is closed immediately after spawn (interactive commands get EOF)
 */

import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager, BashTool } from '../../src/tools/index.js';
import { createFakeKaos, toolContentString } from './fixtures/fake-kaos.js';

function fakeProcess(opts: { exitCode: number; stdout: string; stderr: string }): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([opts.stdout]),
    stderr: Readable.from([opts.stderr]),
    pid: 12345,
    exitCode: opts.exitCode,
    wait: vi.fn().mockResolvedValue(opts.exitCode) as KaosProcess['wait'],
    // oxlint-disable-next-line unicorn/no-useless-undefined
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
  };
}

function makeBashTool(process?: KaosProcess): BashTool {
  const proc = process ?? fakeProcess({ exitCode: 0, stdout: '', stderr: '' });
  const kaos = createFakeKaos({
    exec: vi.fn().mockResolvedValue(proc),
    execWithEnv: vi.fn().mockResolvedValue(proc),
  });
  return new BashTool(kaos, '/workspace');
}

/**
 * Process that never exits on its own. `.kill()` flips the exit code
 * and resolves the pending `wait()` promise, emulating a real subprocess
 * that only exits once killed.
 */
interface PendingProcessHandles {
  readonly proc: KaosProcess;
  readonly killSpy: ReturnType<typeof vi.fn>;
  readonly stdinEndSpy: ReturnType<typeof vi.fn>;
}

function pendingProcess(exitOnKill = 143): PendingProcessHandles {
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
  const stdinEndSpy = vi.fn();
  const proc: KaosProcess = {
    stdin: { write: vi.fn(), end: stdinEndSpy } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as KaosProcess['kill'],
  };
  return { proc, killSpy, stdinEndSpy };
}

describe('BashTool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has name "Bash" and a non-empty description', () => {
    const tool = makeBashTool();
    expect(tool.name).toBe('Bash');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('inputSchema accepts valid BashInput', () => {
    const tool = makeBashTool();
    const result = tool.inputSchema.safeParse({ command: 'echo hello' });
    expect(result.success).toBe(true);
  });

  it('inputSchema accepts optional cwd and timeout', () => {
    const tool = makeBashTool();
    const result = tool.inputSchema.safeParse({
      command: 'ls',
      cwd: '/tmp',
      timeout: 30,
    });
    expect(result.success).toBe(true);
  });

  it('executes a command and returns stdout', async () => {
    const proc = fakeProcess({ exitCode: 0, stdout: 'hello world\n', stderr: '' });
    const tool = makeBashTool(proc);
    const result = await tool.execute(
      'call_1',
      { command: 'echo hello world' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.stdout).toContain('hello');
    expect(result.output?.exitCode).toBe(0);
  });

  it('returns isError when exit code is non-zero', async () => {
    const proc = fakeProcess({ exitCode: 1, stdout: '', stderr: 'command not found' });
    const tool = makeBashTool(proc);
    const result = await tool.execute(
      'call_2',
      { command: 'nonexistent_command' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.output?.exitCode).toBe(1);
    expect(result.output?.stderr).toContain('command not found');
  });

  it('passes custom cwd to the shell executor', async () => {
    const proc = fakeProcess({ exitCode: 0, stdout: '/custom\n', stderr: '' });
    const execFn = vi.fn().mockResolvedValue(proc);
    const kaos = createFakeKaos({ exec: execFn, execWithEnv: execFn });
    const tool = new BashTool(kaos, '/workspace');
    const result = await tool.execute(
      'call_3',
      { command: 'pwd', cwd: '/custom' },
      new AbortController().signal,
    );
    expect(result.output?.stdout).toContain('/custom');
  });

  it('handles timeout by returning isError', async () => {
    const proc = fakeProcess({ exitCode: 124, stdout: '', stderr: 'timeout' });
    const tool = makeBashTool(proc);
    const result = await tool.execute(
      'call_4',
      { command: 'sleep 999', timeout: 1 },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });

  it('getActivityDescription truncates long commands to 50 chars', () => {
    const tool = makeBashTool();
    const longCommand = 'a'.repeat(100);
    const desc = tool.getActivityDescription({ command: longCommand });
    expect(desc.length).toBeLessThanOrEqual(60);
    expect(desc).toContain('…');
  });

  it('getActivityDescription shows short commands in full', () => {
    const tool = makeBashTool();
    const desc = tool.getActivityDescription({ command: 'ls -la' });
    expect(desc).toBe('Running: ls -la');
  });

  // ── M1 regression: timeout / abort / stdin close ───────────────────

  it('closes stdin immediately after spawn (so interactive commands get EOF)', async () => {
    const { proc, stdinEndSpy } = pendingProcess(0);
    const tool = makeBashTool(proc);
    // Kick off execution; we don't await because wait() is pending until kill
    const pending = tool.execute(
      'call_stdin',
      { command: 'cat', timeout: 1 },
      new AbortController().signal,
    );
    // Give the microtask queue a chance to run the stdin.end() call
    await Promise.resolve();
    await Promise.resolve();
    expect(stdinEndSpy).toHaveBeenCalled();
    // Clean up: advance fake timers would require enabling them; resolve
    // the pending proc via kill instead.
    await proc.kill();
    await pending;
  });

  it('kills subprocess when timeout elapses and reports timeout error', async () => {
    vi.useFakeTimers();
    const { proc, killSpy } = pendingProcess(124);
    const tool = makeBashTool(proc);
    const resultPromise = tool.execute(
      'call_timeout',
      { command: 'sleep 999', timeout: 1 },
      new AbortController().signal,
    );
    // Advance past the 1-second timeout
    await vi.advanceTimersByTimeAsync(1500);
    const result = await resultPromise;
    expect(killSpy).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('timeout');
  });

  it('kills subprocess when the ambient signal aborts', async () => {
    const { proc, killSpy } = pendingProcess(143);
    const tool = makeBashTool(proc);
    const controller = new AbortController();
    const resultPromise = tool.execute(
      'call_abort',
      { command: 'sleep 999', timeout: 60 },
      controller.signal,
    );
    // Fire abort on the next microtask
    queueMicrotask(() => {
      controller.abort();
    });
    const result = await resultPromise;
    expect(killSpy).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('aborted');
  });

  it('returns immediately when the signal is already aborted at entry', async () => {
    const tool = makeBashTool();
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute('call_pre_abort', { command: 'echo hi' }, controller.signal);
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Aborted');
  });

  // ── run_in_background tests (M1) ─────────────────────────────────

  describe('run_in_background', () => {
    function makeBgBashTool(process?: KaosProcess, bgManager?: BackgroundProcessManager): BashTool {
      const proc = process ?? fakeProcess({ exitCode: 0, stdout: '', stderr: '' });
      const kaos = createFakeKaos({
        exec: vi.fn().mockResolvedValue(proc),
        execWithEnv: vi.fn().mockResolvedValue(proc),
      });
      return new BashTool(kaos, '/workspace', bgManager);
    }

    it('returns task_id and pid when run_in_background=true', async () => {
      const bgManager = new BackgroundProcessManager();
      const proc = fakeProcess({ exitCode: 0, stdout: '', stderr: '' });
      const tool = makeBgBashTool(proc, bgManager);
      const result = await tool.execute(
        'call_bg_1',
        {
          command: 'sleep 60',
          run_in_background: true,
          description: 'long running task',
        },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      const content = toolContentString(result);
      expect(content).toMatch(/task_id: bash-[0-9a-z]{8}/);
      expect(content).toContain('pid:');
      expect(content).toContain('long running task');
      expect(content).toContain('automatic_notification: true');
    });

    it('returns isError when no BackgroundProcessManager is configured', async () => {
      // Construct BashTool without backgroundManager
      // oxlint-disable-next-line unicorn/no-useless-undefined
      const tool = makeBgBashTool();
      const result = await tool.execute(
        'call_bg_no_mgr',
        {
          command: 'sleep 60',
          run_in_background: true,
          description: 'should fail',
        },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(toolContentString(result)).toContain('not available');
    });

    it('returns isError when description is missing', async () => {
      const bgManager = new BackgroundProcessManager();
      const tool = makeBgBashTool(undefined, bgManager);
      const result = await tool.execute(
        'call_bg_no_desc',
        {
          command: 'sleep 60',
          run_in_background: true,
          // No description provided
        },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(toolContentString(result)).toContain('description is required');
    });

    it('returns isError when description is empty/whitespace', async () => {
      const bgManager = new BackgroundProcessManager();
      const tool = makeBgBashTool(undefined, bgManager);
      const result = await tool.execute(
        'call_bg_empty_desc',
        {
          command: 'sleep 60',
          run_in_background: true,
          description: '   ',
        },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(toolContentString(result)).toContain('description is required');
    });

    it('background task can be stopped via TaskStop after launch', async () => {
      const bgManager = new BackgroundProcessManager();
      const { proc } = pendingProcess(143);
      const tool = makeBgBashTool(proc, bgManager);

      const launchResult = await tool.execute(
        'call_bg_stop',
        {
          command: 'sleep 999',
          run_in_background: true,
          description: 'stoppable task',
        },
        new AbortController().signal,
      );
      expect(launchResult.isError).toBeFalsy();

      // Extract task_id from output.
      const content = toolContentString(launchResult);
      const match = /task_id: (bash-[0-9a-z]{8})/.exec(content);
      expect(match).not.toBeNull();
      const taskId = match![1]!;

      // Verify it is registered as running.
      const taskInfo = bgManager.getTask(taskId);
      expect(taskInfo).toBeDefined();
      expect(taskInfo!.status).toBe('running');

      // Stop it.
      const stopResult = await bgManager.stop(taskId);
      expect(stopResult).toBeDefined();
      expect(stopResult!.status).toBe('killed');
    });

    it('getActivityDescription includes "background" prefix', () => {
      const tool = makeBgBashTool();
      const desc = tool.getActivityDescription({
        command: 'sleep 60',
        run_in_background: true,
      });
      expect(desc).toContain('background');
    });
  });
});
