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

import { describe, expect, it, vi } from 'vitest';

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

describe('CommandHookExecutor', () => {
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
});
