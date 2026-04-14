import { mkdtemp, rm, stat as fsStat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetCurrentKaos, setCurrentKaos } from '../src/current.js';
import type { KaosToken } from '../src/current.js';
import type { Kaos } from '../src/kaos.js';
import { LocalKaos } from '../src/local.js';
import type { KaosProcess } from '../src/process.js';

/**
 * Helper to run a cmd.exe command and collect stdout/stderr/exitCode.
 * Prepends `chcp 65001>nul &` to ensure UTF-8 output.
 */
async function runCmd(
  kaos: Kaos,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc: KaosProcess = await kaos.exec('cmd.exe', '/c', `chcp 65001>nul & ${command}`);

  proc.stdin.end();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const stdoutDone = new Promise<void>((resolve) => {
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    proc.stdout.on('end', () => {
      resolve();
    });
  });

  const stderrDone = new Promise<void>((resolve) => {
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    proc.stderr.on('end', () => {
      resolve();
    });
  });

  const exitCode = await proc.wait();
  await stdoutDone;
  await stderrDone;

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    exitCode,
  };
}

describe.skipIf(process.platform !== 'win32')('LocalKaos cmd.exe', () => {
  let kaos: Kaos;
  let token: KaosToken;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kaos-cmd-'));
    kaos = new LocalKaos();
    token = setCurrentKaos(kaos);
  });

  afterEach(async () => {
    resetCurrentKaos(token);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should run a simple command', async () => {
    const { exitCode, stdout, stderr } = await runCmd(kaos, 'echo Hello Windows');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('Hello Windows');
    expect(stderr).toBe('');
  });

  it('should handle command with error exit', async () => {
    // `exit /b 1` must produce neither stdout nor stderr — pinning that
    // keeps us honest if cmd.exe or the chcp prefix ever leaks output.
    const { exitCode, stdout, stderr } = await runCmd(kaos, 'exit /b 1');
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it('should support command chaining', async () => {
    const { exitCode, stdout, stderr } = await runCmd(kaos, 'echo First&& echo Second');
    expect(exitCode).toBe(0);
    expect(stdout.replaceAll('\r\n', '\n')).toBe('First\nSecond\n');
    expect(stderr).toBe('');
  });

  it('should perform file operations', async () => {
    // Mirror Python test_local_kaos_cmd.py::test_file_operations: two separate
    // kaos.exec invocations (write via redirect, then read back via type),
    // assert the file lands on disk between them, and pin the exact stdout
    // byte-for-byte so any CRLF drift is caught immediately.
    const filePath = join(tmpDir, 'test_file.txt').replaceAll('/', '\\');

    const write = await runCmd(kaos, `echo Test content> "${filePath}"`);
    expect(write.exitCode).toBe(0);
    expect(write.stdout).toBe('');
    expect(write.stderr).toBe('');

    const statInfo = await fsStat(filePath);
    expect(statInfo.isFile()).toBe(true);

    const read = await runCmd(kaos, `type "${filePath}"`);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe('Test content\r\n');
    expect(read.stderr).toBe('');
  });
});
