import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getCurrentKaos, runWithKaos } from '../../src/current.js';
import { LocalKaos } from '../../src/local.js';

// ── Instance-level cwd isolation: real concurrent file operations ─────
//
// Covers the Codex P1 fix: LocalKaos must maintain its own per-instance
// `_cwd` rather than mutating `process.cwd()`. Two concurrent LocalKaos
// instances chdir-ing into different temp directories and issuing
// relative-path reads/writes must not clobber each other.
//
// Before the fix, LocalKaos delegated to Node's `process.chdir()` which
// is process-global. Two instances would race, and one instance's
// relative-path read would be resolved against the *other* instance's
// cwd — producing ENOENT or cross-contaminated reads.

describe('e2e: LocalKaos instance-level cwd isolation (concurrent, real FS)', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(label: string): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), `kaos-cwd-iso-${label}-`)));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('two concurrent runWithKaos scopes with different LocalKaos cwds each read their own files', async () => {
    const dirA = await makeTempDir('A');
    const dirB = await makeTempDir('B');

    const kaosA = new LocalKaos();
    const kaosB = new LocalKaos();

    // Pre-seed distinct files in each dir using absolute paths.
    await kaosA.writeText(join(dirA, 'marker.txt'), 'A-content');
    await kaosB.writeText(join(dirB, 'marker.txt'), 'B-content');

    // Run two concurrent scopes. Each scope chdirs into its own temp
    // directory and reads 'marker.txt' via a *relative* path. Yielding
    // the event loop between the chdir and the read gives the other
    // scope a chance to clobber shared state if it exists.
    const [a, b] = await Promise.all([
      runWithKaos(kaosA, async () => {
        const k = getCurrentKaos();
        await k.chdir(dirA);
        // Yield to the other concurrent scope.
        await new Promise<void>((r) => setImmediate(r));
        const value = await k.readText('marker.txt');
        // Yield again after reading.
        await new Promise<void>((r) => setImmediate(r));
        const cwdAfter = k.getcwd();
        return { value, cwdAfter };
      }),
      runWithKaos(kaosB, async () => {
        const k = getCurrentKaos();
        await k.chdir(dirB);
        await new Promise<void>((r) => setImmediate(r));
        const value = await k.readText('marker.txt');
        await new Promise<void>((r) => setImmediate(r));
        const cwdAfter = k.getcwd();
        return { value, cwdAfter };
      }),
    ]);

    expect(a.value).toBe('A-content');
    expect(b.value).toBe('B-content');
    expect(a.cwdAfter).toBe(dirA);
    expect(b.cwdAfter).toBe(dirB);

    // Neither chdir should have touched the node-level process.cwd().
    // (We don't assert a specific value — the test runner controls it —
    //  but the two LocalKaos instances must hold distinct _cwds.)
    expect(kaosA.getcwd()).toBe(dirA);
    expect(kaosB.getcwd()).toBe(dirB);
  });

  it('interleaved concurrent relative writes stay isolated', async () => {
    const dirA = await makeTempDir('wA');
    const dirB = await makeTempDir('wB');

    const kaosA = new LocalKaos();
    const kaosB = new LocalKaos();
    await kaosA.chdir(dirA);
    await kaosB.chdir(dirB);

    // Perform many interleaved relative writes from both scopes.
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(
        runWithKaos(kaosA, async () => {
          await new Promise<void>((r) => setImmediate(r));
          await getCurrentKaos().writeText(`a-${i}.txt`, `A-${i}`);
        }),
      );
      tasks.push(
        runWithKaos(kaosB, async () => {
          await new Promise<void>((r) => setImmediate(r));
          await getCurrentKaos().writeText(`b-${i}.txt`, `B-${i}`);
        }),
      );
    }
    await Promise.all(tasks);

    // All A files must live in dirA with A content, and B in dirB.
    for (let i = 0; i < 20; i++) {
      const aVal = await kaosA.readText(join(dirA, `a-${i}.txt`));
      const bVal = await kaosB.readText(join(dirB, `b-${i}.txt`));
      expect(aVal).toBe(`A-${i}`);
      expect(bVal).toBe(`B-${i}`);
    }

    // And no cross-contamination: A files must NOT exist under dirB.
    await expect(kaosA.readText(join(dirB, 'a-0.txt'))).rejects.toThrow();
    await expect(kaosB.readText(join(dirA, 'b-0.txt'))).rejects.toThrow();
  });

  it('nested runWithKaos with different cwds restores the outer cwd correctly', async () => {
    const dirOuter = await makeTempDir('outer');
    const dirInner = await makeTempDir('inner');

    const kaosOuter = new LocalKaos();
    const kaosInner = new LocalKaos();
    await kaosOuter.chdir(dirOuter);
    await kaosInner.chdir(dirInner);

    await kaosOuter.writeText(join(dirOuter, 'outer.txt'), 'OUTER');
    await kaosInner.writeText(join(dirInner, 'inner.txt'), 'INNER');

    const result = await runWithKaos(kaosOuter, async () => {
      const beforeNest = await getCurrentKaos().readText('outer.txt');

      const innerValue = await runWithKaos(kaosInner, async () => {
        return getCurrentKaos().readText('inner.txt');
      });

      const afterNest = await getCurrentKaos().readText('outer.txt');
      return { beforeNest, innerValue, afterNest };
    });

    expect(result.beforeNest).toBe('OUTER');
    expect(result.innerValue).toBe('INNER');
    expect(result.afterNest).toBe('OUTER');
  });

  it('LocalKaos.chdir never mutates process.cwd()', async () => {
    const dirA = await makeTempDir('nochangeA');
    const originalProcessCwd = process.cwd();

    const kaos = new LocalKaos();
    await kaos.chdir(dirA);

    // The instance cwd must have changed.
    expect(kaos.getcwd()).toBe(dirA);
    // But the process-global cwd must not have been touched.
    expect(process.cwd()).toBe(originalProcessCwd);
  });

  it('exec respects instance-level cwd (two instances with different cwds)', async () => {
    const dirA = await makeTempDir('execA');
    const dirB = await makeTempDir('execB');

    const kaosA = new LocalKaos();
    const kaosB = new LocalKaos();
    await kaosA.chdir(dirA);
    await kaosB.chdir(dirB);

    async function readStdout(proc: Awaited<ReturnType<LocalKaos['exec']>>): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of proc.stdout) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      await proc.wait();
      return Buffer.concat(chunks).toString('utf-8').trim();
    }

    // Run `pwd` concurrently in both instances. Each must report its own cwd.
    const [outA, outB] = await Promise.all([
      kaosA.exec('sh', '-c', 'pwd').then(readStdout),
      kaosB.exec('sh', '-c', 'pwd').then(readStdout),
    ]);

    // On macOS /tmp is a symlink to /private/tmp — we already realpath'd
    // the temp dir during creation, so comparing strings is safe.
    expect(outA).toBe(dirA);
    expect(outB).toBe(dirB);
  });
});
