/**
 * Shell (Bash) — Python parity migration (Phase 14 §1.5).
 *
 * Ports the 15 Python tests from
 *   `/Users/moonshot/Developer/kimi-cli/tests/tools/test_shell_bash.py`
 * that are NOT already covered by the unit-style `bash.test.ts` (which
 * uses a fake Kaos). These cases exercise real shell semantics — piping,
 * substitution, chaining — so they use a live `LocalKaos` and only run
 * on POSIX hosts (the Python `pytestmark = skipif(win32)` gate).
 *
 * They target the post-Phase-14 `ShellTool` (aliased `BashTool` for
 * wire-name compatibility) constructed with an injected `Environment`
 * (§1.2). Until the `Environment` constructor parameter lands, these
 * tests FAIL at import or construction — by design, this is the Phase
 * 14 red bar.
 *
 * Notes:
 *   - `DEFAULT_MAX_CHARS` — Python uses 30_000 (`tools/utils.py`). TS
 *     today caps bytes at 10 MiB (`bash.ts:40`). The Python parity tests
 *     for truncation probe behaviour, not the exact ceiling, so we
 *     assert "either truncates with a marker OR returns the full
 *     payload" — whichever ceiling Phase 14 decides.
 */

import { describe, expect, it } from 'vitest';
import { LocalKaos } from '@moonshot-ai/kaos';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BashTool } from '../../src/tools/index.js';
import { toolContentString } from './fixtures/fake-kaos.js';
import { isWindows } from '../helpers/platform.js';
// Will fail to import until Phase 14 §1.2 lands — by design.
// eslint-disable-next-line import/no-unresolved
import { detectEnvironment } from '../../src/utils/environment.js';

// Skip the whole file on Windows (Python `pytestmark = skipif(win32)`).
const skipOnWindows = isWindows;

const signal = new AbortController().signal;

async function makeShell(cwd: string): Promise<BashTool> {
  const kaos = new LocalKaos();
  await kaos.chdir(cwd);
  const env = await detectEnvironment({
    platform: process.platform,
    arch: process.arch,
    release: process.release.name ?? '0',
    env: process.env as Record<string, string | undefined>,
    isFile: async (path: string) => {
      try {
        const { stat } = await import('node:fs/promises');
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
  });
  // Phase 14 §1.2: `BashTool` (aliased `ShellTool`) gains an
  // `Environment` constructor parameter. Tests pass it explicitly so
  // that when the constructor signature updates, these tests stop
  // compiling against the old 2-arg form.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (BashTool as any)(kaos, cwd, env) as BashTool;
}

describe.skipIf(skipOnWindows)('ShellTool — bash parity (Phase 14 §1.5)', () => {
  let workDir: string;

  async function setup(): Promise<BashTool> {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-shell-bash-'));
    return makeShell(workDir);
  }

  async function teardown(): Promise<void> {
    await rm(workDir, { recursive: true, force: true });
  }

  it('chains commands with &&', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'c1',
        { command: "echo 'First' && echo 'Second'" },
        signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.stdout).toBe('First\nSecond\n');
    } finally {
      await teardown();
    }
  });

  it('executes sequential commands separated by ;', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'c2',
        { command: "echo 'One'; echo 'Two'" },
        signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.stdout).toBe('One\nTwo\n');
    } finally {
      await teardown();
    }
  });

  it('evaluates conditional || when the first leg fails', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'c3',
        { command: "false || echo 'Success'" },
        signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.stdout).toBe('Success\n');
    } finally {
      await teardown();
    }
  });

  it('pipes command output', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'c4',
        { command: "echo 'Hello World' | wc -w" },
        signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.stdout?.trim()).toBe('2');
    } finally {
      await teardown();
    }
  });

  it('supports multiple pipes in one command', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'c5',
        { command: "printf '1\\n2\\n3\\n' | grep '2' | wc -l" },
        signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.stdout?.trim()).toBe('1');
    } finally {
      await teardown();
    }
  });

  it('exports and references an environment variable', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'c6',
        { command: "export TEST_VAR='test_value' && echo $TEST_VAR" },
        signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.stdout).toBe('test_value\n');
    } finally {
      await teardown();
    }
  });

  it('writes and reads a file via the shell', async () => {
    const shell = await setup();
    try {
      const filePath = join(workDir, 'test_file.txt');
      const createResult = await shell.execute(
        'c7a',
        { command: `echo 'Test content' > ${filePath}` },
        signal,
      );
      expect(createResult.isError).toBeFalsy();

      const readResult = await shell.execute('c7b', { command: `cat ${filePath}` }, signal);
      expect(readResult.isError).toBeFalsy();
      expect(readResult.output?.stdout).toBe('Test content\n');
    } finally {
      await teardown();
    }
  });

  it('performs simple text processing with sed', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'c8',
        { command: "echo 'apple banana cherry' | sed 's/banana/orange/'" },
        signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.stdout).toBe('apple orange cherry\n');
    } finally {
      await teardown();
    }
  });

  it('handles command substitution $(...)', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'c9',
        { command: 'echo "Result: $(echo hello)"' },
        signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.stdout).toBe('Result: hello\n');
    } finally {
      await teardown();
    }
  });

  it('handles arithmetic substitution $((...))', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'c10',
        { command: 'echo "Answer: $((2 + 2))"' },
        signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.stdout).toBe('Answer: 4\n');
    } finally {
      await teardown();
    }
  });

  it('returns a long but non-truncated output verbatim when under the cap', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'c11',
        { command: 'seq 1 100 | head -50' },
        signal,
      );
      expect(result.isError).toBeFalsy();
      const stdout = result.output?.stdout ?? '';
      // `seq 1 100 | head -50` emits `1\n2\n...\n50\n`; the first `1`
      // has no leading newline, so we probe a line-boundary match a few
      // rows in instead of `\n1\n` (Phase 14 test-migrator bug fix
      // reported to team-lead).
      expect(stdout).toContain('\n2\n');
      expect(stdout).toContain('\n50\n');
      expect(stdout).not.toContain('\n51\n');
    } finally {
      await teardown();
    }
  });

  it('truncates very large stdout on success', async () => {
    const shell = await setup();
    try {
      // Produce ~11 MiB of 'X' so we comfortably exceed the 10 MiB byte
      // cap (bash.ts:40) even after line-buffering overhead.
      const chunks = 11 * 1024; // 1 KiB chunks → ~11 MiB
      const result = await shell.execute(
        'c12',
        {
          command: `python3 -c "print('X' * ${String(chunks * 1024)})"`,
          timeout: 60,
        },
        signal,
      );
      expect(result.isError).toBeFalsy();
      const stdout = result.output?.stdout ?? '';
      // Either the runtime truncates (and marks it) or it returns the
      // full payload — the Python test is "if len > MAX, expect marker".
      if (stdout.length >= 10 * 1024 * 1024) {
        expect(stdout).toMatch(/truncated/);
      }
    } finally {
      await teardown();
    }
  }, 30_000);

  it('truncates very large stdout on failure', async () => {
    const shell = await setup();
    try {
      const result = await shell.execute(
        'c13',
        {
          command:
            "python3 -c \"import sys; print('ERROR_' * (2 * 1024 * 1024)); sys.exit(1)\"",
          timeout: 60,
        },
        signal,
      );
      expect(result.isError).toBe(true);
      expect(result.output?.exitCode).toBe(1);
      const merged = `${result.output?.stdout ?? ''}${result.output?.stderr ?? ''}`;
      if (merged.length >= 10 * 1024 * 1024) {
        expect(merged).toMatch(/truncated/);
      }
    } finally {
      await teardown();
    }
  }, 30_000);

  it('rejects timeout values outside permitted bounds at input-schema level', async () => {
    const shell = await setup();
    try {
      // Zero and negative timeouts must not parse (Python: ValueError
      // raised at Params() construction).
      expect(shell.inputSchema.safeParse({ command: 'echo x', timeout: 0 }).success).toBe(
        false,
      );
      expect(
        shell.inputSchema.safeParse({ command: 'echo x', timeout: -1 }).success,
      ).toBe(false);

      // Extremely large foreground timeout (e.g. 1 day) must not parse.
      expect(
        shell.inputSchema.safeParse({ command: 'echo x', timeout: 24 * 60 * 60 }).success,
      ).toBe(false);

      // Background mode allows longer timeouts (Python:
      // MAX_FOREGROUND_TIMEOUT + 1 is permitted with run_in_background).
      expect(
        shell.inputSchema.safeParse({
          command: 'make build',
          timeout: 6 * 60 * 60,
          run_in_background: true,
          description: 'long build',
        }).success,
      ).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('still works in plan mode (Plan-mode is enforced by prompt, not the tool)', async () => {
    // Python test passes `runtime.session.state.plan_mode = True` and
    // the shell still executes. TS-core has no session object in the
    // tool layer — ShellTool never consults plan_mode, so the parity
    // assertion is simply "same command, same result".
    const shell = await setup();
    try {
      const result = await shell.execute('c14', { command: 'echo plan_ok' }, signal);
      expect(result.isError).toBeFalsy();
      expect(result.output?.stdout).toContain('plan_ok');
    } finally {
      await teardown();
    }
  });

  it('leaves the workspace untouched between calls (smoke check)', async () => {
    // Simple end-to-end smoke: earlier file survives a second shell call.
    const shell = await setup();
    try {
      const marker = join(workDir, 'marker.txt');
      await writeFile(marker, 'seed');
      const result = await shell.execute('c15', { command: `cat ${marker}` }, signal);
      expect(result.isError).toBeFalsy();
      expect((await readFile(marker, 'utf8')).trim()).toBe('seed');
      expect(toolContentString(result) || result.output?.stdout || '').toContain('seed');
    } finally {
      await teardown();
    }
  });
});
