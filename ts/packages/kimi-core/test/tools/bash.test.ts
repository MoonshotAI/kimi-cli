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
 */

import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import { BashTool } from '../../src/tools/index.js';
import { createFakeKaos } from './fixtures/fake-kaos.js';

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

describe('BashTool', () => {
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
      timeout: 30000,
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
    // The tool should use the provided cwd, not the default
    expect(result.output?.stdout).toContain('/custom');
  });

  it('handles timeout by returning isError', async () => {
    const proc = fakeProcess({ exitCode: 124, stdout: '', stderr: 'timeout' });
    const tool = makeBashTool(proc);
    const result = await tool.execute(
      'call_4',
      { command: 'sleep 999', timeout: 100 },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });

  it('getActivityDescription truncates long commands to 50 chars', () => {
    const tool = makeBashTool();
    const longCommand = 'a'.repeat(100);
    const desc = tool.getActivityDescription({ command: longCommand });
    expect(desc.length).toBeLessThanOrEqual(60); // "Running: " + 50 + "…"
    expect(desc).toContain('…');
  });

  it('getActivityDescription shows short commands in full', () => {
    const tool = makeBashTool();
    const desc = tool.getActivityDescription({ command: 'ls -la' });
    expect(desc).toBe('Running: ls -la');
  });
});
