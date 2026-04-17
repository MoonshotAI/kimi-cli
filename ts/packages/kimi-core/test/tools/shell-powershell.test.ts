/**
 * Shell (PowerShell) — Phase 14 §1.5.
 *
 * Ports `/Users/moonshot/Developer/kimi-cli/tests/tools/test_shell_powershell.py`
 * verbatim (4 tests). Runs only on Windows CI runners — the
 * Python file uses `pytestmark = skipif(platform != 'Windows')`.
 *
 * Phase 14 §1.1 decisions these tests pin:
 *   - Wire tool name stays "Bash"; internal class is `ShellTool`
 *     (aliased `BashTool`).
 *   - On Windows, `ShellTool` invokes
 *     `powershell.exe -command "Set-Location -LiteralPath '<cwd>'; <cmd>"`.
 *   - Line endings normalize via `normalizeLineEndings` for snapshot
 *     comparisons (see `helpers/wire/path-replacements.ts:24`).
 *
 * These tests FAIL until Phase 14 §1.2 lands:
 *   - `detectEnvironment()` resolves to `shellName: 'Windows PowerShell'`
 *   - `ShellTool` constructor accepts the `Environment` and picks
 *     `-command` vs `-c` accordingly.
 */

import { describe, expect, it } from 'vitest';
import { LocalKaos } from '@moonshot-ai/kaos';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BashTool } from '../../src/tools/index.js';
import { isWindows } from '../helpers/platform.js';
import { normalizeLineEndings } from '../helpers/wire/path-replacements.js';
// eslint-disable-next-line import/no-unresolved
import { detectEnvironment } from '../../src/utils/environment.js';

const signal = new AbortController().signal;

async function makeShell(cwd: string): Promise<BashTool> {
  const kaos = new LocalKaos();
  await kaos.chdir(cwd);
  const env = await detectEnvironment({
    platform: process.platform,
    arch: process.arch,
    release: process.release.name ?? '0',
    env: process.env as Record<string, string | undefined>,
    isFile: async (p: string) => {
      try {
        return (await stat(p)).isFile();
      } catch {
        return false;
      }
    },
  });
  // Phase 14 §1.2 — constructor accepts `Environment`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (BashTool as any)(kaos, cwd, env) as BashTool;
}

describe.skipIf(!isWindows)('ShellTool — PowerShell parity (Phase 14 §1.5)', () => {
  let workDir: string;

  async function setup(): Promise<BashTool> {
    workDir = await mkdtemp(path.join(tmpdir(), 'kimi-shell-ps-'));
    return makeShell(workDir);
  }

  async function teardown(): Promise<void> {
    await rm(workDir, { recursive: true, force: true });
  }

  it('executes a simple command', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'ps1',
        { command: 'echo "Hello Windows"' },
        signal,
      );
      expect(result.isError).toBeFalsy();
      const normalized = normalizeLineEndings(result.output?.stdout ?? '');
      expect(normalized.trim()).toBe('Hello Windows');
    } finally {
      await teardown();
    }
  });

  it('reports exit code 1 on a failing command', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'ps2',
        { command: 'python -c "import sys; sys.exit(1)"' },
        signal,
      );
      expect(result.isError).toBe(true);
      expect(result.output?.exitCode).toBe(1);
    } finally {
      await teardown();
    }
  });

  it('chains commands via ";" + "if ($?)"', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'ps3',
        { command: 'echo First; if ($?) { echo Second }' },
        signal,
      );
      expect(result.isError).toBeFalsy();
      const normalized = normalizeLineEndings(result.output?.stdout ?? '');
      expect(normalized).toBe('First\nSecond\n');
    } finally {
      await teardown();
    }
  });

  it('writes and reads a file via redirection + type', async () => {
    const shell = await setup();
    try {
      const filePath = path.win32.join(workDir, 'test_file.txt');

      const createResult = await shell.execute(
        'ps4a',
        { command: `echo "Test content" > "${filePath}"` },
        signal,
      );
      expect(createResult.isError).toBeFalsy();

      const readResult = await shell.execute(
        'ps4b',
        { command: `type "${filePath}"` },
        signal,
      );
      expect(readResult.isError).toBeFalsy();
      // PowerShell's `type` emits CRLF — assert raw so CRLF handling is pinned.
      expect(readResult.output?.stdout).toContain('Test content');
    } finally {
      await teardown();
    }
  });
});
