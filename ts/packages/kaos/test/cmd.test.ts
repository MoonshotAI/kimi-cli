import { mkdtemp, rm } from 'node:fs/promises';
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
    const { exitCode, stdout } = await runCmd(kaos, 'echo Hello Windows');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('Hello Windows');
  });

  it('should handle command with error exit', async () => {
    const { exitCode } = await runCmd(kaos, 'exit /b 1');
    expect(exitCode).toBe(1);
  });

  it('should support command chaining', async () => {
    const { exitCode, stdout } = await runCmd(kaos, 'echo First&& echo Second');
    expect(exitCode).toBe(0);
    expect(stdout.replaceAll('\r\n', '\n')).toBe('First\nSecond\n');
  });

  it('should perform file operations', async () => {
    const filePath = join(tmpDir, 'test.txt').replaceAll('/', '\\');
    const { exitCode, stdout } = await runCmd(
      kaos,
      `echo file content> "${filePath}" && type "${filePath}"`,
    );
    expect(exitCode).toBe(0);
    expect(stdout.replaceAll('\r\n', '\n').trim()).toContain('file content');
  });
});
