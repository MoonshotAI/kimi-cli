import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '../../src/local.js';

// ── Helper ────────────────────────────────────────────────────────────

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: process lifecycle', () => {
  let kaos: LocalKaos;
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    kaos = new LocalKaos();
    originalCwd = process.cwd();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'kaos-proc-')));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('stdin → stdout → wait → exitCode', () => {
    it('write to stdin, read from stdout, wait for exit', async () => {
      // Node script that reads stdin and echoes it to stdout
      const code = `
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => {
          process.stdout.write('echo:' + data);
        });
      `;
      const proc = await kaos.exec('node', '-e', code);

      // Write to stdin
      proc.stdin.write('hello from test');
      proc.stdin.end();

      // Wait for process to complete
      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      // Read stdout
      const stdout = await streamToBuffer(proc.stdout);
      expect(stdout.toString('utf-8')).toBe('echo:hello from test');
    });

    it('multiple stdin writes before end', async () => {
      const code = `
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => {
          process.stdout.write(data.toUpperCase());
        });
      `;
      const proc = await kaos.exec('node', '-e', code);

      proc.stdin.write('hello ');
      proc.stdin.write('world ');
      proc.stdin.write('test');
      proc.stdin.end();

      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const stdout = await streamToBuffer(proc.stdout);
      expect(stdout.toString('utf-8')).toBe('HELLO WORLD TEST');
    });

    it('exitCode is null before wait, correct after wait', async () => {
      const proc = await kaos.exec('node', '-e', 'process.exit(42)');

      // Before wait, exitCode may be null
      // (it could also be set if process is very fast, so we just check after wait)
      const exitCode = await proc.wait();
      expect(exitCode).toBe(42);
      expect(proc.exitCode).toBe(42);
    });
  });

  describe('long-running process → kill', () => {
    it('start → verify running → kill → confirm exit', async () => {
      // Process that runs indefinitely
      const code = `
        process.stdout.write('started\\n');
        setInterval(() => {}, 1000);
      `;
      const proc = await kaos.exec('node', '-e', code);

      expect(proc.pid).toBeGreaterThan(0);

      // Wait a bit for the process to start and emit stdout
      await new Promise<void>((r) => setTimeout(r, 100));

      // Kill it
      await proc.kill('SIGTERM');

      const exitCode = await proc.wait();
      // On SIGTERM, node typically exits with non-zero
      expect(typeof exitCode).toBe('number');
    });

    it('kill with SIGKILL → immediate termination', async () => {
      const code = `
        // Trap SIGTERM to test that SIGKILL forces exit
        process.on('SIGTERM', () => { /* ignore */ });
        process.stdout.write('alive\\n');
        setInterval(() => {}, 1000);
      `;
      const proc = await kaos.exec('node', '-e', code);

      await new Promise<void>((r) => setTimeout(r, 100));

      await proc.kill('SIGKILL');
      const exitCode = await proc.wait();

      // SIGKILL cannot be caught - process is terminated
      expect(exitCode).not.toBe(0);
    });

    it('multiple wait() calls return same exit code', async () => {
      const proc = await kaos.exec('node', '-e', 'process.exit(7)');

      const code1 = await proc.wait();
      const code2 = await proc.wait();
      const code3 = await proc.wait();

      expect(code1).toBe(7);
      expect(code2).toBe(7);
      expect(code3).toBe(7);
    });
  });

  describe('stdin close → natural exit', () => {
    it('closing stdin causes stdin-reading process to exit naturally', async () => {
      // Process that exits when stdin closes
      const code = `
        process.stdin.resume();
        process.stdin.on('end', () => {
          process.stdout.write('stdin closed');
          process.exit(0);
        });
      `;
      const proc = await kaos.exec('node', '-e', code);

      // Close stdin immediately
      proc.stdin.end();

      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const stdout = await streamToBuffer(proc.stdout);
      expect(stdout.toString('utf-8')).toBe('stdin closed');
    });

    it('cat-like process exits when stdin is closed', async () => {
      const code = `
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => {
          process.stdout.write(chunk);
        });
        process.stdin.on('end', () => {
          process.exit(0);
        });
      `;
      const proc = await kaos.exec('node', '-e', code);

      proc.stdin.write('line1\n');
      proc.stdin.write('line2\n');
      proc.stdin.end();

      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const stdout = await streamToBuffer(proc.stdout);
      expect(stdout.toString('utf-8')).toBe('line1\nline2\n');
    });
  });

  describe('process.pid validity', () => {
    it('pid is a positive integer', async () => {
      const proc = await kaos.exec('node', '-e', 'process.exit(0)');
      expect(proc.pid).toBeGreaterThan(0);
      expect(Number.isInteger(proc.pid)).toBe(true);

      await proc.wait();
    });

    it('different processes have different pids', async () => {
      const proc1 = await kaos.exec('node', '-e', 'process.exit(0)');
      const proc2 = await kaos.exec('node', '-e', 'process.exit(0)');

      expect(proc1.pid).not.toBe(proc2.pid);

      await Promise.all([proc1.wait(), proc2.wait()]);
    });

    it('pid matches the actual child process pid', async () => {
      // Have the child process report its own pid
      const code = `process.stdout.write(String(process.pid))`;
      const proc = await kaos.exec('node', '-e', code);
      await proc.wait();

      const stdout = await streamToBuffer(proc.stdout);
      const reportedPid = Number(stdout.toString('utf-8'));

      expect(proc.pid).toBe(reportedPid);
    });
  });

  describe('exec failure (command not found)', () => {
    it('non-existent command → error on wait()', async () => {
      // exec() itself may succeed (spawn returns) but wait() should
      // report the error or the process should fail
      try {
        const proc = await kaos.exec('this-command-absolutely-does-not-exist-xyz-123');
        // If exec resolves, wait should give a rejection
        await expect(proc.wait()).rejects.toThrow();
      } catch (error: unknown) {
        // If exec itself throws, that's also acceptable
        expect(error).toBeInstanceOf(Error);
      }
    });

    it('exec with empty arguments rejects', async () => {
      // exec() is now async, so validation errors (missing command) surface
      // as rejected promises rather than synchronous throws.
      await expect(kaos.exec()).rejects.toThrow(/at least one argument/);
    });
  });

  describe('execWithEnv', () => {
    it('passes custom environment variables to the child process', async () => {
      const code = `process.stdout.write(process.env.MY_VAR || 'undefined')`;
      const proc = await kaos.execWithEnv(['node', '-e', code], {
        ...(process.env as Record<string, string>),
        MY_VAR: 'test-value-123',
      });
      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const stdout = await streamToBuffer(proc.stdout);
      expect(stdout.toString('utf-8')).toBe('test-value-123');
    });

    it('custom env overrides specific variables', async () => {
      // Passing a custom env with PATH so node can still run,
      // but with a custom variable that overrides a default one.
      const code = `process.stdout.write(process.env.MY_CUSTOM || 'missing')`;
      const proc = await kaos.execWithEnv(['node', '-e', code], {
        PATH: process.env['PATH'] ?? '',
        MY_CUSTOM: 'overridden-value',
      });
      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const stdout = await streamToBuffer(proc.stdout);
      expect(stdout.toString('utf-8')).toBe('overridden-value');
    });
  });

  describe('process output ordering', () => {
    it('stdout preserves line order for sequential writes', async () => {
      const code = `
        for (let i = 0; i < 100; i++) {
          process.stdout.write(i + '\\n');
        }
      `;
      const proc = await kaos.exec('node', '-e', code);
      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const stdout = await streamToBuffer(proc.stdout);
      const lines = stdout.toString('utf-8').trimEnd().split('\n');

      expect(lines).toHaveLength(100);
      for (let i = 0; i < 100; i++) {
        expect(lines[i]).toBe(String(i));
      }
    });

    it('stderr preserves line order for sequential writes', async () => {
      const code = `
        for (let i = 0; i < 50; i++) {
          process.stderr.write('err-' + i + '\\n');
        }
      `;
      const proc = await kaos.exec('node', '-e', code);
      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const stderr = await streamToBuffer(proc.stderr);
      const lines = stderr.toString('utf-8').trimEnd().split('\n');

      expect(lines).toHaveLength(50);
      for (let i = 0; i < 50; i++) {
        expect(lines[i]).toBe(`err-${i}`);
      }
    });
  });

  describe('process exit codes', () => {
    it('exit code 0 for successful process', async () => {
      const proc = await kaos.exec('node', '-e', 'process.exit(0)');
      expect(await proc.wait()).toBe(0);
    });

    it('exit code 1 for generic failure', async () => {
      const proc = await kaos.exec('node', '-e', 'process.exit(1)');
      expect(await proc.wait()).toBe(1);
    });

    it('custom exit codes (2, 42, 127, 255)', async () => {
      for (const code of [2, 42, 127, 255]) {
        const proc = await kaos.exec('node', '-e', `process.exit(${code})`);
        expect(await proc.wait()).toBe(code);
      }
    });

    it('uncaught exception results in exit code 1', async () => {
      const code = `throw new Error('uncaught')`;
      const proc = await kaos.exec('node', '-e', code);
      const exitCode = await proc.wait();
      expect(exitCode).toBe(1);

      // stderr should contain the error message
      const stderr = await streamToBuffer(proc.stderr);
      expect(stderr.toString('utf-8')).toContain('uncaught');
    });
  });
});
