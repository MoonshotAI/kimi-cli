/**
 * Covers: TaskListTool, TaskOutputTool, TaskStopTool (Slice 3.5).
 *
 * Uses KaosProcess fakes (M2 fix: manager accepts KaosProcess).
 */

import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager.js';
import { TaskListTool } from '../../../src/tools/background/task-list.js';
import { TaskOutputTool } from '../../../src/tools/background/task-output.js';
import { TaskStopTool } from '../../../src/tools/background/task-stop.js';
import { toolContentString } from '../fixtures/fake-kaos.js';

const signal = new AbortController().signal;

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

function pendingProcess(): KaosProcess {
  let resolveWait: (n: number) => void = () => {};
  const waitPromise = new Promise<number>((res) => {
    resolveWait = res;
  });
  let currentExitCode: number | null = null;
  const killSpy = vi.fn(async () => {
    if (currentExitCode === null) {
      currentExitCode = 143;
      resolveWait(143);
    }
  });
  return {
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
}

describe('TaskListTool', () => {
  const manager = new BackgroundProcessManager();
  const tool = new TaskListTool(manager);

  afterEach(() => {
    manager._reset();
  });

  it('has name "TaskList"', () => {
    expect(tool.name).toBe('TaskList');
  });

  it('returns "No background tasks found." when empty', async () => {
    const result = await tool.execute('c1', { active_only: true }, signal);
    expect(toolContentString(result)).toContain('No background tasks found');
  });

  it('lists active tasks', () => {
    const proc = pendingProcess();
    manager.register(proc, 'sleep 60', 'test task');
    // Synchronous check — the task is running immediately after register.
    const tasks = manager.list(true);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.command).toBe('sleep 60');
  });
});

describe('TaskOutputTool', () => {
  const manager = new BackgroundProcessManager();
  const tool = new TaskOutputTool(manager);

  afterEach(() => {
    manager._reset();
  });

  it('has name "TaskOutput"', () => {
    expect(tool.name).toBe('TaskOutput');
  });

  it('returns error for unknown task', async () => {
    const result = await tool.execute('c1', { task_id: 'bash-unknown0' }, signal);
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Task not found');
  });

  it('returns output for a completed task', async () => {
    const proc = immediateProcess(0, 'hello from bg\n');
    const taskId = manager.register(proc, 'echo hello from bg', 'output test');

    // Let wait() and stream settle.
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    const result = await tool.execute('c2', { task_id: taskId }, signal);
    expect(result.isError).toBe(false);
    const content = toolContentString(result);
    expect(content).toContain('status: completed');
    expect(content).toContain('hello from bg');
  });
});

describe('TaskStopTool', () => {
  const manager = new BackgroundProcessManager();
  const tool = new TaskStopTool(manager);

  afterEach(() => {
    manager._reset();
  });

  it('has name "TaskStop"', () => {
    expect(tool.name).toBe('TaskStop');
  });

  it('returns error for unknown task', async () => {
    const result = await tool.execute('c1', { task_id: 'bash-unknown0' }, signal);
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('Task not found');
  });

  it('stops a running task', async () => {
    const proc = pendingProcess();
    const taskId = manager.register(proc, 'sleep 60', 'stop test');
    const result = await tool.execute('c2', { task_id: taskId }, signal);
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('killed');
  });

  it('returns info when task is already in terminal state', async () => {
    const proc = immediateProcess(0);
    const taskId = manager.register(proc, 'echo done', 'terminal test');

    // Let wait() settle.
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const result = await tool.execute('c3', { task_id: taskId }, signal);
    expect(result.isError).toBe(false);
    expect(toolContentString(result)).toContain('already in terminal state');
  });
});
