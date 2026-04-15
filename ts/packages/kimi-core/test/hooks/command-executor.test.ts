/**
 * Covers: CommandHookExecutor (v2 §9-C.2 / Python hooks/runner.py).
 *
 * Pins:
 *   - Exit 0 → ok: true (allow)
 *   - Exit 2 → blockAction: true + reason from stderr
 *   - Timeout → ok: true (fail-open)
 *   - Command error → ok: true (fail-open)
 *   - Environment variables passed to subprocess
 *   - stderr captured in result
 */

import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandHookExecutor } from '../../src/hooks/command-executor.js';
import type { CommandHookConfig, PostToolUseInput } from '../../src/hooks/types.js';
import { createFakeKaos } from '../tools/fixtures/fake-kaos.js';

function makeInput(overrides?: Partial<PostToolUseInput>): PostToolUseInput {
  return {
    event: 'PostToolUse',
    sessionId: 'sess_1',
    turnId: 'turn_1',
    agentId: 'agent_main',
    toolCall: { id: 'tc_1', name: 'Bash', args: { command: 'ls' } },
    args: { command: 'ls' },
    result: { content: 'file1.ts\nfile2.ts' },
    ...overrides,
  };
}

function makeHook(overrides?: Partial<CommandHookConfig>): CommandHookConfig {
  return {
    type: 'command',
    event: 'PostToolUse',
    command: 'echo ok',
    ...overrides,
  };
}

function fakeProcess(opts: { exitCode: number; stdout: string; stderr: string }) {
  return {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: Readable.from([opts.stdout]),
    stderr: Readable.from([opts.stderr]),
    pid: 42,
    exitCode: opts.exitCode,
    wait: vi.fn().mockResolvedValue(opts.exitCode),
    // oxlint-disable-next-line unicorn/no-useless-undefined
    kill: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Subprocess that never exits on its own; `.kill()` flips the exit code
 * and resolves the pending `wait()` — emulates a real hook command that
 * hangs waiting for stdin that never comes.
 */
interface PendingHookProcess {
  readonly proc: KaosProcess;
  readonly killSpy: ReturnType<typeof vi.fn>;
  readonly stdinWriteSpy: ReturnType<typeof vi.fn>;
  readonly stdinEndSpy: ReturnType<typeof vi.fn>;
}

function pendingHookProc(exitOnKill = 143): PendingHookProcess {
  let resolveWait: (n: number) => void = () => {
    /* replaced */
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
  const stdinWriteSpy = vi.fn();
  const stdinEndSpy = vi.fn();
  const proc: KaosProcess = {
    stdin: { write: stdinWriteSpy, end: stdinEndSpy } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 99,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: killSpy as unknown as KaosProcess['kill'],
  };
  return { proc, killSpy, stdinWriteSpy, stdinEndSpy };
}

describe('CommandHookExecutor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exit code 0 → ok: true (allow)', async () => {
    const proc = fakeProcess({ exitCode: 0, stdout: '', stderr: '' });
    const kaos = createFakeKaos({
      exec: vi.fn().mockResolvedValue(proc),
      execWithEnv: vi.fn().mockResolvedValue(proc),
    });
    const executor = new CommandHookExecutor(kaos);
    const result = await executor.execute(makeHook(), makeInput(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.blockAction).toBeFalsy();
  });

  it('exit code 2 → blockAction: true with reason from stderr', async () => {
    const proc = fakeProcess({ exitCode: 2, stdout: '', stderr: 'blocked by policy' });
    const kaos = createFakeKaos({
      exec: vi.fn().mockResolvedValue(proc),
      execWithEnv: vi.fn().mockResolvedValue(proc),
    });
    const executor = new CommandHookExecutor(kaos);
    const result = await executor.execute(makeHook(), makeInput(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.blockAction).toBe(true);
    expect(result.reason).toContain('blocked by policy');
  });

  it('timeout → ok: true (fail-open)', async () => {
    const kaos = createFakeKaos({
      exec: vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => {
              reject(new Error('timeout'));
            }, 50);
          }),
      ),
      execWithEnv: vi.fn().mockRejectedValue(new Error('timeout')),
    });
    const executor = new CommandHookExecutor(kaos);
    const result = await executor.execute(
      makeHook({ timeoutMs: 10 }),
      makeInput(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(result.blockAction).toBeFalsy();
  });

  it('command execution error → ok: true (fail-open)', async () => {
    const kaos = createFakeKaos({
      exec: vi.fn().mockRejectedValue(new Error('command not found')),
      execWithEnv: vi.fn().mockRejectedValue(new Error('command not found')),
    });
    const executor = new CommandHookExecutor(kaos);
    const result = await executor.execute(
      makeHook({ command: 'nonexistent_hook' }),
      makeInput(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(result.blockAction).toBeFalsy();
  });

  it('captures stderr in result', async () => {
    const proc = fakeProcess({ exitCode: 0, stdout: 'out', stderr: 'warning: something' });
    const kaos = createFakeKaos({
      exec: vi.fn().mockResolvedValue(proc),
      execWithEnv: vi.fn().mockResolvedValue(proc),
    });
    const executor = new CommandHookExecutor(kaos);
    const result = await executor.execute(makeHook(), makeInput(), new AbortController().signal);
    expect(result.ok).toBe(true);
  });

  // ── M2 regression: stdin JSON / cwd / timeout / signal ─────────────

  it('writes hook input as JSON to subprocess stdin and closes it', async () => {
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn();
    const proc = {
      stdin: { write: stdinWrite, end: stdinEnd } as unknown as Writable,
      stdout: Readable.from(['']),
      stderr: Readable.from(['']),
      pid: 42,
      exitCode: 0,
      wait: vi.fn().mockResolvedValue(0),
      // oxlint-disable-next-line unicorn/no-useless-undefined
      kill: vi.fn().mockResolvedValue(undefined),
    } satisfies KaosProcess;
    const kaos = createFakeKaos({
      exec: vi.fn().mockResolvedValue(proc),
      execWithEnv: vi.fn().mockResolvedValue(proc),
    });
    const executor = new CommandHookExecutor(kaos);
    const input = makeInput();
    await executor.execute(makeHook(), input, new AbortController().signal);

    expect(stdinWrite).toHaveBeenCalledTimes(1);
    expect(stdinEnd).toHaveBeenCalledTimes(1);
    const written = stdinWrite.mock.calls[0]?.[0] as string | undefined;
    expect(written).toBeDefined();
    const parsed = JSON.parse(written as string) as Record<string, unknown>;
    expect(parsed['event']).toBe('PostToolUse');
    expect((parsed['toolCall'] as { name: string }).name).toBe('Bash');
  });

  it('honors cwd by prefixing `cd` to the shell invocation', async () => {
    const proc = fakeProcess({ exitCode: 0, stdout: '', stderr: '' });
    const execSpy = vi.fn().mockResolvedValue(proc);
    const kaos = createFakeKaos({
      exec: execSpy,
      execWithEnv: execSpy,
    });
    const executor = new CommandHookExecutor(kaos);
    await executor.execute(
      makeHook({ command: 'true', cwd: '/tmp/hook-dir' }),
      makeInput(),
      new AbortController().signal,
    );
    const call = execSpy.mock.calls[0] as [string[], unknown];
    const [bashArgs] = call;
    expect(bashArgs[0]).toBe('bash');
    expect(bashArgs[1]).toBe('-c');
    expect(bashArgs[2]).toContain("cd '/tmp/hook-dir'");
  });

  it('times out pending subprocess and fail-opens', async () => {
    vi.useFakeTimers();
    const { proc, killSpy } = pendingHookProc(137);
    const kaos = createFakeKaos({
      exec: vi.fn().mockResolvedValue(proc),
      execWithEnv: vi.fn().mockResolvedValue(proc),
    });
    const executor = new CommandHookExecutor(kaos);
    const pending = executor.execute(
      makeHook({ timeoutMs: 10 }),
      makeInput(),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(30);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.blockAction).toBeFalsy();
    expect(killSpy).toHaveBeenCalled();
  });

  it('fail-opens when the ambient signal aborts mid-execution', async () => {
    const { proc, killSpy } = pendingHookProc(143);
    const kaos = createFakeKaos({
      exec: vi.fn().mockResolvedValue(proc),
      execWithEnv: vi.fn().mockResolvedValue(proc),
    });
    const executor = new CommandHookExecutor(kaos);
    const controller = new AbortController();
    const pending = executor.execute(makeHook(), makeInput(), controller.signal);
    queueMicrotask(() => {
      controller.abort();
    });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.blockAction).toBeFalsy();
    expect(killSpy).toHaveBeenCalled();
  });
});
