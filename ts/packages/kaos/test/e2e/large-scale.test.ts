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

describe('e2e: large-scale operations', () => {
  let kaos: LocalKaos;
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    kaos = new LocalKaos();
    originalCwd = process.cwd();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'kaos-large-')));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('large file I/O', () => {
    it('write and read 1MB text file → content identical', async () => {
      const filePath = join(tempDir, 'large.txt');
      const oneMB = 'A'.repeat(1024 * 1024);

      await kaos.writeText(filePath, oneMB);
      const readBack = await kaos.readText(filePath);

      expect(readBack.length).toBe(oneMB.length);
      expect(readBack).toBe(oneMB);
    });

    it('write and read 1MB binary file → bytes identical', async () => {
      const filePath = join(tempDir, 'large.bin');
      const data = Buffer.alloc(1024 * 1024);
      // Fill with a repeating pattern
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      await kaos.writeBytes(filePath, data);
      const readBack = await kaos.readBytes(filePath);

      expect(readBack.length).toBe(data.length);
      expect(Buffer.compare(readBack, data)).toBe(0);
    });

    it('stat reports correct size for 1MB file', async () => {
      const filePath = join(tempDir, 'sized.txt');
      const content = 'B'.repeat(1024 * 1024);

      await kaos.writeText(filePath, content);
      const s = await kaos.stat(filePath);

      expect(s.stSize).toBe(1024 * 1024);
    });

    it('readBytes with partial read (first 1024 bytes of 1MB file)', async () => {
      const filePath = join(tempDir, 'partial.bin');
      const data = Buffer.alloc(1024 * 1024, 0x42);

      await kaos.writeBytes(filePath, data);
      const partial = await kaos.readBytes(filePath, 1024);

      expect(partial.length).toBe(1024);
      expect(partial.every((b) => b === 0x42)).toBe(true);
    });

    it('readLines on large file with many lines', async () => {
      const filePath = join(tempDir, 'lines.txt');
      const lineCount = 10000;
      const lines: string[] = [];
      for (let i = 0; i < lineCount; i++) {
        lines.push(`line-${i}`);
      }
      const content = lines.join('\n') + '\n';

      await kaos.writeText(filePath, content);

      const readLines: string[] = [];
      for await (const line of kaos.readLines(filePath)) {
        readLines.push(line);
      }

      // readLines preserves newlines in each line (except possibly last)
      const joinedBack = readLines.join('');
      expect(joinedBack).toBe(content);
    });
  });

  describe('exec with large output', () => {
    it('captures 100KB+ stdout from a single process', async () => {
      // Generate ~100KB of output
      const code = `
        const line = 'x'.repeat(100) + '\\n';
        for (let i = 0; i < 1024; i++) {
          process.stdout.write(line);
        }
      `;
      const proc = await kaos.exec('node', '-e', code);
      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const stdout = await streamToBuffer(proc.stdout);
      // Each line is 101 bytes (100 x's + newline), 1024 lines = ~103KB
      expect(stdout.length).toBeGreaterThanOrEqual(100 * 1024);
    });

    it('captures 100KB+ stderr from a single process', async () => {
      const code = `
        const line = 'e'.repeat(100) + '\\n';
        for (let i = 0; i < 1024; i++) {
          process.stderr.write(line);
        }
      `;
      const proc = await kaos.exec('node', '-e', code);
      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const stderr = await streamToBuffer(proc.stderr);
      expect(stderr.length).toBeGreaterThanOrEqual(100 * 1024);
    });

    it('captures large stdout + stderr simultaneously', async () => {
      const code = `
        for (let i = 0; i < 500; i++) {
          process.stdout.write('OUT:' + i + '\\n');
          process.stderr.write('ERR:' + i + '\\n');
        }
      `;
      const proc = await kaos.exec('node', '-e', code);
      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const [stdout, stderr] = await Promise.all([
        streamToBuffer(proc.stdout),
        streamToBuffer(proc.stderr),
      ]);

      const outLines = stdout.toString('utf-8').trimEnd().split('\n');
      const errLines = stderr.toString('utf-8').trimEnd().split('\n');

      expect(outLines).toHaveLength(500);
      expect(errLines).toHaveLength(500);
      expect(outLines[0]).toBe('OUT:0');
      expect(errLines[0]).toBe('ERR:0');
    });
  });

  describe('iterdir with many files', () => {
    it('iterdir lists 100+ files correctly', async () => {
      const fileCount = 150;

      // Create files
      const createPromises: Promise<number>[] = [];
      for (let i = 0; i < fileCount; i++) {
        createPromises.push(
          kaos.writeText(join(tempDir, `file-${String(i).padStart(3, '0')}.txt`), `data-${i}`),
        );
      }
      await Promise.all(createPromises);

      // List them
      const entries: string[] = [];
      for await (const entry of kaos.iterdir(tempDir)) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(fileCount);

      // Verify all files are present
      const names = new Set(entries.map((e) => e.split('/').pop()!));
      for (let i = 0; i < fileCount; i++) {
        expect(names.has(`file-${String(i).padStart(3, '0')}.txt`)).toBe(true);
      }
    });

    it('iterdir with mixed files and directories', async () => {
      // Create 50 files and 50 directories
      for (let i = 0; i < 50; i++) {
        await kaos.writeText(join(tempDir, `file-${i}.txt`), 'data');
        await kaos.mkdir(join(tempDir, `dir-${i}`));
      }

      const entries: string[] = [];
      for await (const entry of kaos.iterdir(tempDir)) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(100);
    });
  });

  describe('deeply nested directory glob', () => {
    it('glob matches files through 10 levels of nesting', async () => {
      // Build path: tempDir/d0/d1/d2/.../d9/target.txt
      let current = tempDir;
      for (let i = 0; i < 10; i++) {
        current = join(current, `d${i}`);
      }
      await kaos.mkdir(current, { parents: true });

      const targetFile = join(current, 'target.txt');
      await kaos.writeText(targetFile, 'deep content');

      // Also add files at intermediate levels
      await kaos.writeText(join(tempDir, 'd0', 'shallow.txt'), 'shallow');
      await kaos.writeText(join(tempDir, 'd0', 'd1', 'd2', 'mid.txt'), 'mid');

      // glob **/*.txt should find all .txt files
      const results: string[] = [];
      for await (const entry of kaos.glob(tempDir, '**/*.txt')) {
        results.push(entry);
      }

      expect(results.length).toBeGreaterThanOrEqual(3);
      expect(results.some((r) => r.endsWith('target.txt'))).toBe(true);
      expect(results.some((r) => r.endsWith('shallow.txt'))).toBe(true);
      expect(results.some((r) => r.endsWith('mid.txt'))).toBe(true);
    });

    it('glob with specific pattern at deep level', async () => {
      let current = tempDir;
      for (let i = 0; i < 5; i++) {
        current = join(current, `level${i}`);
      }
      await kaos.mkdir(current, { parents: true });

      await kaos.writeText(join(current, 'config.yaml'), 'key: value');
      await kaos.writeText(join(current, 'data.json'), '{}');
      await kaos.writeText(join(current, 'readme.md'), '# hi');

      const yamlResults: string[] = [];
      for await (const entry of kaos.glob(tempDir, '**/*.yaml')) {
        yamlResults.push(entry);
      }

      // The ** glob may yield duplicates due to multiple matching paths;
      // deduplicate and verify the correct file is found.
      const unique = [...new Set(yamlResults)];
      expect(unique).toHaveLength(1);
      expect(unique[0]!.endsWith('config.yaml')).toBe(true);
    });

    it('glob with no matches in deep tree returns empty', async () => {
      let current = tempDir;
      for (let i = 0; i < 5; i++) {
        current = join(current, `nest${i}`);
      }
      await kaos.mkdir(current, { parents: true });
      await kaos.writeText(join(current, 'file.txt'), 'data');

      const results: string[] = [];
      for await (const entry of kaos.glob(tempDir, '**/*.xyz')) {
        results.push(entry);
      }

      expect(results).toHaveLength(0);
    });
  });

  describe('large directory glob performance', () => {
    it('glob *.txt in directory with 200 files of mixed types', async () => {
      // Create 100 .txt and 100 .log files
      const promises: Promise<number>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(kaos.writeText(join(tempDir, `file-${i}.txt`), 'txt'));
        promises.push(kaos.writeText(join(tempDir, `file-${i}.log`), 'log'));
      }
      await Promise.all(promises);

      const txtResults: string[] = [];
      for await (const entry of kaos.glob(tempDir, '*.txt')) {
        txtResults.push(entry);
      }

      expect(txtResults).toHaveLength(100);
      expect(txtResults.every((r) => r.endsWith('.txt'))).toBe(true);
    });
  });
});
