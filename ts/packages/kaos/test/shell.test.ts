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
 * Helper to run a shell command via /bin/sh -c and collect stdout/stderr/exitCode.
 * Since the new Kaos.exec(...args) doesn't take options, timeout is implemented
 * by killing the process after the given duration.
 */
async function runSh(
  kaos: Kaos,
  command: string,
  options?: { timeout?: number; stdinData?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc: KaosProcess = await kaos.exec('/bin/sh', '-c', command);

  // Set up timeout if requested
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeout !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      void proc.kill('SIGKILL');
    }, options.timeout);
  }

  // If stdinData is provided, write it and close stdin
  if (options?.stdinData !== undefined) {
    proc.stdin.write(options.stdinData);
    proc.stdin.end();
  } else {
    proc.stdin.end();
  }

  // Collect stdout and stderr concurrently with waiting for process exit
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

  if (timer !== undefined) {
    clearTimeout(timer);
  }

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    exitCode: timedOut ? -1 : exitCode,
  };
}

describe.skipIf(process.platform === 'win32')('LocalKaos shell operations', () => {
  let kaos: Kaos;
  let token: KaosToken;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kaos-shell-'));
    kaos = new LocalKaos();
    token = setCurrentKaos(kaos);
  });

  afterEach(async () => {
    resetCurrentKaos(token);
    await rm(tmpDir, { recursive: true, force: true });
  });

  // NOTE: These tests mirror Python test_local_kaos_sh.py one-for-one.
  // Python pins stderr to '' on every non-error case and uses inline_snapshot
  // for exact stdout comparisons — the TS side now matches that strength so
  // any future drift (e.g. a rogue newline or a leaked warning) is caught.

  it('should run a simple command', async () => {
    const result = await runSh(kaos, "echo 'Hello World'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Hello World\n');
    expect(result.stderr).toBe('');
  });

  it('should handle command with error', async () => {
    const result = await runSh(kaos, 'ls /nonexistent/directory');
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No such file or directory');
  });

  it('should support command chaining with &&', async () => {
    const result = await runSh(kaos, "echo 'First' && echo 'Second'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('First\nSecond\n');
    expect(result.stderr).toBe('');
  });

  it('should support command pipe', async () => {
    const result = await runSh(kaos, "echo 'Hello World' | wc -w");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('2');
    expect(result.stderr).toBe('');
  });

  it('should handle command with timeout (completes before timeout)', async () => {
    // Python asserts stdout='' for `sleep 0.1` so pin that exactly — if the
    // helper ever introduces its own chatter we want to hear about it.
    const result = await runSh(kaos, 'sleep 0.1', { timeout: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('should handle timeout expiration', async () => {
    // Python raises TimeoutError from its helper; the TS helper surfaces the
    // same condition as exitCode === -1 after force-killing the process.
    // The contract pinned here is "super-short timeout kills a long sleep".
    const result = await runSh(kaos, 'sleep 60', { timeout: 100 });
    expect(result.exitCode).toBe(-1);
  });

  it('should pass environment variables to shell', async () => {
    const result = await runSh(kaos, 'TEST_VAR=\'test_value\'; export TEST_VAR; echo "$TEST_VAR"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('test_value\n');
    expect(result.stderr).toBe('');
  });

  it('should perform file operations', async () => {
    // Mirror Python test_file_operations: two separate kaos.exec calls so
    // that the "file lands on disk between calls" invariant is actually
    // exercised, plus explicit stat() check.
    const filePath = join(tmpDir, 'test_file.txt');

    const write = await runSh(kaos, `echo 'Test content' > "${filePath}"`);
    expect(write.exitCode).toBe(0);
    expect(write.stdout).toBe('');
    expect(write.stderr).toBe('');

    const statInfo = await fsStat(filePath);
    expect(statInfo.isFile()).toBe(true);

    const read = await runSh(kaos, `cat "${filePath}"`);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe('Test content\n');
    expect(read.stderr).toBe('');
  });

  it('should handle stdin data', async () => {
    // Mirror Python test_command_reads_stdin: use the shell `read` builtin,
    // which requires a newline-terminated input. Previously the TS version
    // was a trivial `cat` passthrough that did not exercise `read`.
    const result = await runSh(kaos, 'read value; printf \'%s\\n\' "$value"', {
      stdinData: 'from stdin\n',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('from stdin\n');
    expect(result.stderr).toBe('');
  });

  it('should execute commands sequentially with ;', async () => {
    const result = await runSh(kaos, "echo 'One'; echo 'Two'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('One\nTwo\n');
    expect(result.stderr).toBe('');
  });

  it('should support conditional execution with ||', async () => {
    const result = await runSh(kaos, "false || echo 'Success'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Success\n');
    expect(result.stderr).toBe('');
  });

  it('should support multiple pipes', async () => {
    const result = await runSh(kaos, "printf '1\\n2\\n3\\n' | grep '2' | wc -l");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1');
    expect(result.stderr).toBe('');
  });

  it('should handle text processing with sed', async () => {
    const result = await runSh(kaos, "echo 'apple banana cherry' | sed 's/banana/orange/'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('apple orange cherry\n');
    expect(result.stderr).toBe('');
  });

  it('should support command substitution', async () => {
    const result = await runSh(kaos, 'echo "Result: $(echo hello)"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Result: hello\n');
    expect(result.stderr).toBe('');
  });

  it('should support arithmetic substitution', async () => {
    const result = await runSh(kaos, 'echo "Answer: $((2 + 2))"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Answer: 4\n');
    expect(result.stderr).toBe('');
  });

  it('should handle very long output', async () => {
    const result = await runSh(kaos, 'seq 1 100 | head -50');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1');
    expect(result.stdout).toContain('50');
    expect(result.stdout).not.toContain('51');
    expect(result.stderr).toBe('');
  });

  it('should read multiple lines from stdin', async () => {
    const result = await runSh(
      kaos,
      'count=0; while IFS= read -r _; do count=$((count+1)); done; printf \'%s\\n\' "$count"',
      { stdinData: 'alpha\nbeta\ngamma\n' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('3');
    expect(result.stderr).toBe('');
  });
});
