import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '../../src/local.js';

// ── E2E: exec edge cases ──────────────────────────────────────────────
//
// Covers exec() scenarios that the other kaos suites do not touch:
//
//   - spawning a non-existent command and safely awaiting the error,
//   - killing a running child with SIGTERM,
//   - closing stdin while the child is still alive,
//   - >10MB stdout throughput without dropping or corrupting bytes,
//   - proving that each LocalKaos instance carries its OWN cwd into
//     concurrent child processes (isolation invariant).

// ── Helpers ───────────────────────────────────────────────────────────

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function streamByteLength(stream: NodeJS.ReadableStream): Promise<number> {
  let n = 0;
  for await (const chunk of stream) {
    n += (chunk as Buffer).length;
  }
  return n;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: exec edge cases', () => {
  let kaos: LocalKaos;
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    kaos = new LocalKaos();
    originalCwd = process.cwd();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'kaos-exec-edge-')));
    await kaos.chdir(tempDir);
  });

  afterEach(async () => {
    // Restore original cwd in case any test accidentally mutated it
    // (though LocalKaos should never touch process.cwd()).
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('spawning a non-existent command', () => {
    it('exec() rejects promptly when the binary does not exist (never hangs)', async () => {
      // Contract: LocalKaos.exec() awaits the child's 'spawn' or 'error' event
      // before returning, so a missing binary becomes a synchronous rejection
      // rather than a ghost process handle. The test used to tolerate both
      // POSIX (error event) and Windows (non-zero exit) outcomes via wait();
      // under the new contract both platforms funnel through the ENOENT/
      // ENOTFOUND path emitted by `spawn`.
      await expect(kaos.exec('this-binary-does-not-exist-kaos-edge-test-12345')).rejects.toThrow(
        /ENOENT|ENOTFOUND|not found|spawn/i,
      );
    });
  });

  describe('kill() terminates a running child', () => {
    it('long-running child can be killed with SIGTERM', async () => {
      // A node script that sleeps forever.
      const proc = await kaos.exec('node', '-e', 'setInterval(() => {}, 1000 * 60);');

      expect(proc.pid).toBeGreaterThan(0);

      // Give the child a moment to actually start.
      await new Promise<void>((r) => setTimeout(r, 20));

      await proc.kill('SIGTERM');

      const exitCode = await proc.wait();
      // SIGTERM typically produces exitCode = null → -1 under our wrapper,
      // or 143 (128 + 15). Either way, it must NOT be 0.
      expect(exitCode).not.toBe(0);
    });

    it('kill() after the child has already exited is a no-op (no ESRCH leak)', async () => {
      const proc = await kaos.exec('node', '-e', 'process.exit(0);');
      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      // Killing an already-exited process must not throw.
      await expect(proc.kill('SIGTERM')).resolves.toBeUndefined();
    });
  });

  describe('stdin lifecycle', () => {
    it('closing stdin while the child keeps running does not corrupt stdout', async () => {
      // Child reads stdin until EOF, then emits "done:<bytes>".
      const proc = await kaos.exec(
        'node',
        '-e',
        `
          let total = 0;
          process.stdin.on('data', (chunk) => { total += chunk.length; });
          process.stdin.on('end', () => {
            // Intentionally wait before writing, simulating child work
            // continuing after stdin EOF.
            setTimeout(() => {
              process.stdout.write('done:' + total);
              process.exit(0);
            }, 20);
          });
        `,
      );

      proc.stdin.write('abc');
      proc.stdin.write('def');
      proc.stdin.end();

      const stdout = await streamToString(proc.stdout);
      const exitCode = await proc.wait();

      expect(exitCode).toBe(0);
      expect(stdout).toBe('done:6');
    });
  });

  describe('large stdout throughput', () => {
    it('>10MB of stdout streams through without byte loss', async () => {
      // 10.5MB: 10500 writes of a 1KB payload. Using a tight loop in the
      // child guarantees the OS pipe buffer gets exercised and we exit
      // the BufferedReadable backpressure path.
      const targetKB = 10500;
      const proc = await kaos.exec(
        'node',
        '-e',
        `
          const chunk = Buffer.alloc(1024, 0x61); // 1KB of 'a'
          let written = 0;
          function tick() {
            while (written < ${targetKB} - 1) {
              const ok = process.stdout.write(chunk);
              written++;
              if (!ok) {
                process.stdout.once('drain', tick);
                return;
              }
            }
            // Final write with callback guarantees bytes are flushed to the
            // pipe before we exit. Without this, process.exit() races with
            // the internal libuv write queue and drops the tail.
            process.stdout.write(chunk, () => process.exit(0));
          }
          tick();
        `,
      );

      // Read stream and wait concurrently to avoid races where wait() resolves
      // before the stream pipe has flushed (BufferedReadable continues to
      // accumulate after the child exits, but the consumer must be drained
      // explicitly before checking length).
      const [stdoutLen, exitCode] = await Promise.all([streamByteLength(proc.stdout), proc.wait()]);

      expect(exitCode).toBe(0);
      expect(stdoutLen).toBe(targetKB * 1024);
    });
  });

  describe('cwd isolation for concurrent instances', () => {
    it('two LocalKaos instances with different cwds run concurrent child processes that each see their own cwd', async () => {
      const subA = join(tempDir, 'A');
      const subB = join(tempDir, 'B');

      await kaos.mkdir(subA);
      await kaos.mkdir(subB);

      const kaosA = new LocalKaos();
      const kaosB = new LocalKaos();
      await kaosA.chdir(subA);
      await kaosB.chdir(subB);

      // Verify process.cwd() is NOT mutated by chdir.
      expect(process.cwd()).not.toBe(subA);
      expect(process.cwd()).not.toBe(subB);

      // Run concurrently: each child prints its cwd to stdout.
      const [procA, procB] = await Promise.all([
        kaosA.exec('node', '-e', 'process.stdout.write(process.cwd())'),
        kaosB.exec('node', '-e', 'process.stdout.write(process.cwd())'),
      ]);

      const [outA, outB, exitA, exitB] = await Promise.all([
        streamToString(procA.stdout),
        streamToString(procB.stdout),
        procA.wait(),
        procB.wait(),
      ]);

      expect(exitA).toBe(0);
      expect(exitB).toBe(0);

      // Each child's cwd MUST equal its kaos instance's cwd.
      // On macOS `tmpdir()` can be either `/var/folders/...` or
      // `/private/var/folders/...`. We already realpath'd tempDir so
      // string equality should hold.
      expect(outA).toBe(subA);
      expect(outB).toBe(subB);
    });

    it('execWithEnv honors the per-instance cwd and injects env vars', async () => {
      const proc = await kaos.execWithEnv(
        ['node', '-e', 'process.stdout.write(process.env.KAOS_TEST_MARKER + "|" + process.cwd())'],
        { KAOS_TEST_MARKER: 'beacon42', PATH: process.env['PATH'] ?? '' },
      );
      const stdout = await streamToString(proc.stdout);
      const exitCode = await proc.wait();

      expect(exitCode).toBe(0);
      expect(stdout.startsWith('beacon42|')).toBe(true);
      expect(stdout.endsWith(tempDir)).toBe(true);
    });
  });
});
