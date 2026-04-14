import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '../../src/local.js';

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: concurrent operations', () => {
  let kaos: LocalKaos;
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    kaos = new LocalKaos();
    originalCwd = process.cwd();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'kaos-concurrent-')));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('concurrent reads and writes on different files', () => {
    it('10 concurrent writeText + readText on separate files → all consistent', async () => {
      const count = 10;
      const promises = Array.from({ length: count }, async (_, i): Promise<void> => {
        const filePath = join(tempDir, `file-${i}.txt`);
        const content = `content-${i}-${'data'.repeat(100)}`;
        await kaos.writeText(filePath, content);
        const readBack = await kaos.readText(filePath);
        expect(readBack).toBe(content);
      });

      await Promise.all(promises);
    });
  });

  describe('concurrent writes to the same file', () => {
    it('sequential writes to same file → last write wins', async () => {
      const filePath = join(tempDir, 'shared.txt');
      const writes = 20;

      // Write sequentially to guarantee ordering
      for (let i = 0; i < writes; i++) {
        await kaos.writeText(filePath, `version-${i}`);
      }

      // The file should have the last written content
      const content = await kaos.readText(filePath);
      expect(content).toBe(`version-${writes - 1}`);
    });

    it('concurrent appends to same file → all data present', async () => {
      const filePath = join(tempDir, 'append-target.txt');
      await kaos.writeText(filePath, '');

      const count = 20;
      const promises: Promise<number>[] = [];

      for (let i = 0; i < count; i++) {
        promises.push(kaos.writeText(filePath, `line-${i}\n`, { mode: 'a' }));
      }

      await Promise.all(promises);

      const content = await kaos.readText(filePath);
      const lines = content.trimEnd().split('\n');

      // All lines should be present (order may vary due to concurrency)
      expect(lines).toHaveLength(count);
      const lineSet = new Set(lines);
      for (let i = 0; i < count; i++) {
        expect(lineSet.has(`line-${i}`)).toBe(true);
      }
    });
  });

  describe('concurrent exec of multiple subprocesses', () => {
    it('5 concurrent node processes → all complete independently', async () => {
      const count = 5;
      const promises = Array.from(
        { length: count },
        async (_, i): Promise<{ index: number; exitCode: number; stdout: string }> => {
          const code = `process.stdout.write('proc-${i}');`;
          const proc = await kaos.exec('node', '-e', code);
          const exitCode = await proc.wait();

          const chunks: Buffer[] = [];
          for await (const chunk of proc.stdout) {
            chunks.push(Buffer.from(chunk as Buffer));
          }
          const stdout = Buffer.concat(chunks).toString('utf-8');

          return { index: i, exitCode, stdout };
        },
      );

      const results = await Promise.all(promises);

      for (const result of results) {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(`proc-${result.index}`);
      }
    });

    it('concurrent processes with different exit codes', async () => {
      const exitCodes = [0, 1, 2, 42, 0];
      const promises = exitCodes.map(async (code) => {
        const proc = await kaos.exec('node', '-e', `process.exit(${code})`);
        return proc.wait();
      });

      const results = await Promise.all(promises);
      expect(results).toEqual(exitCodes);
    });
  });

  describe('concurrent iterdir + file creation', () => {
    it('iterdir does not crash when files are being created concurrently', async () => {
      // Pre-create some files
      for (let i = 0; i < 5; i++) {
        await kaos.writeText(join(tempDir, `existing-${i}.txt`), `data-${i}`);
      }

      // Start iterdir and file creation concurrently
      const iterdirPromise = (async (): Promise<string[]> => {
        const entries: string[] = [];
        for await (const entry of kaos.iterdir(tempDir)) {
          entries.push(entry);
        }
        return entries;
      })();

      const creationPromise = (async (): Promise<void> => {
        for (let i = 0; i < 5; i++) {
          await kaos.writeText(join(tempDir, `new-${i}.txt`), `new-data-${i}`);
        }
      })();

      const [entries] = await Promise.all([iterdirPromise, creationPromise]);

      // iterdir should return at least the pre-existing files
      // (new files may or may not be included depending on timing)
      expect(entries.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('concurrent glob operations', () => {
    it('multiple concurrent globs return correct results', async () => {
      // Create files with different extensions
      await kaos.writeText(join(tempDir, 'a.ts'), 'ts');
      await kaos.writeText(join(tempDir, 'b.ts'), 'ts');
      await kaos.writeText(join(tempDir, 'c.js'), 'js');
      await kaos.writeText(join(tempDir, 'd.js'), 'js');
      await kaos.writeText(join(tempDir, 'e.json'), 'json');

      const [tsFiles, jsFiles, jsonFiles] = await Promise.all([
        collectGlob(kaos, tempDir, '*.ts'),
        collectGlob(kaos, tempDir, '*.js'),
        collectGlob(kaos, tempDir, '*.json'),
      ]);

      expect(tsFiles.toSorted()).toEqual([join(tempDir, 'a.ts'), join(tempDir, 'b.ts')].toSorted());
      expect(jsFiles.toSorted()).toEqual([join(tempDir, 'c.js'), join(tempDir, 'd.js')].toSorted());
      expect(jsonFiles).toEqual([join(tempDir, 'e.json')]);
    });

    it('10 concurrent glob(*.txt) on same directory → consistent results', async () => {
      // Use a flat glob pattern to avoid ** duplication behavior
      await kaos.writeText(join(tempDir, 'a.txt'), 'a');
      await kaos.writeText(join(tempDir, 'b.txt'), 'b');
      await kaos.writeText(join(tempDir, 'c.txt'), 'c');

      const expected = [
        join(tempDir, 'a.txt'),
        join(tempDir, 'b.txt'),
        join(tempDir, 'c.txt'),
      ].toSorted();

      const promises: Promise<string[]>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(collectGlob(kaos, tempDir, '*.txt'));
      }

      const results = await Promise.all(promises);

      for (const result of results) {
        expect(result.toSorted()).toEqual(expected);
      }
    });
  });

  describe('concurrent mixed operations', () => {
    it('read + write + stat + iterdir concurrently on same directory', async () => {
      const filePath = join(tempDir, 'mixed.txt');
      await kaos.writeText(filePath, 'initial');

      const [readResult, _writeResult, statResult, entries] = await Promise.all([
        kaos.readText(filePath),
        kaos.writeText(join(tempDir, 'another.txt'), 'other'),
        kaos.stat(filePath),
        collectIterdir(kaos, tempDir),
      ]);

      // readResult might be 'initial' (read before write) or a valid string
      expect(typeof readResult).toBe('string');
      expect(statResult.stSize).toBeGreaterThan(0);
      expect(entries.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ── Helper functions ──────────────────────────────────────────────────

async function collectGlob(kaos: LocalKaos, path: string, pattern: string): Promise<string[]> {
  const results: string[] = [];
  for await (const entry of kaos.glob(path, pattern)) {
    results.push(entry);
  }
  return results;
}

async function collectIterdir(kaos: LocalKaos, path: string): Promise<string[]> {
  const results: string[] = [];
  for await (const entry of kaos.iterdir(path)) {
    results.push(entry);
  }
  return results;
}
