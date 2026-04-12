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

  it('should run a simple command', async () => {
    const result = await runSh(kaos, "echo 'Hello World'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Hello World');
  });

  it('should handle command with error', async () => {
    const result = await runSh(kaos, 'ls /nonexistent_path_12345');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('should support command chaining with &&', async () => {
    const result = await runSh(kaos, "echo 'first' && echo 'second'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('first');
    expect(result.stdout).toContain('second');
  });

  it('should support command pipe', async () => {
    const result = await runSh(kaos, "echo 'one two three' | wc -w");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('3');
  });

  it('should handle command with timeout (completes before timeout)', async () => {
    const result = await runSh(kaos, 'sleep 0.1 && echo done', { timeout: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('done');
  });

  it('should handle timeout expiration', async () => {
    const result = await runSh(kaos, 'sleep 60', { timeout: 100 });
    // When timed out, we force exit code to -1
    expect(result.exitCode).toBe(-1);
  });

  it('should pass environment variables to shell', async () => {
    const result = await runSh(kaos, 'export MY_VAR=hello && echo $MY_VAR');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('should perform file operations', async () => {
    const result = await runSh(
      kaos,
      `echo 'file content' > "${tmpDir}/test.txt" && cat "${tmpDir}/test.txt"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('file content');
  });

  it('should handle stdin data', async () => {
    const result = await runSh(kaos, 'cat', { stdinData: 'hello from stdin' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from stdin');
  });

  it('should execute commands sequentially with ;', async () => {
    const result = await runSh(kaos, "echo 'One'; echo 'Two'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('One\nTwo\n');
  });

  it('should support conditional execution with ||', async () => {
    const result = await runSh(kaos, "false || echo 'Success'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Success\n');
  });

  it('should support multiple pipes', async () => {
    const result = await runSh(kaos, "printf '1\\n2\\n3\\n' | grep '2' | wc -l");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1');
  });

  it('should handle text processing with sed', async () => {
    const result = await runSh(kaos, "echo 'apple banana cherry' | sed 's/banana/orange/'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('apple orange cherry\n');
  });

  it('should support command substitution', async () => {
    const result = await runSh(kaos, 'echo "Result: $(echo hello)"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Result: hello\n');
  });

  it('should support arithmetic substitution', async () => {
    const result = await runSh(kaos, 'echo "Answer: $((2 + 2))"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Answer: 4\n');
  });

  it('should handle very long output', async () => {
    const result = await runSh(kaos, 'seq 1 100 | head -50');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1');
    expect(result.stdout).toContain('50');
    expect(result.stdout).not.toContain('51');
  });

  it('should read multiple lines from stdin', async () => {
    const result = await runSh(
      kaos,
      'count=0; while IFS= read -r _; do count=$((count+1)); done; printf \'%s\\n\' "$count"',
      { stdinData: 'alpha\nbeta\ngamma\n' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('3');
  });
});
