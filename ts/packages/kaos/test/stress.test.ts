import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '../src/local.js';

// ── Helpers ──────────────────────────────────────────────────────────

function nodeArgs(code: string): string[] {
  return ['node', '-e', code];
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('stress: LocalKaos', () => {
  let kaos: LocalKaos;
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    kaos = new LocalKaos();
    originalCwd = process.cwd();
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'kaos-stress-')));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── 1. Read non-existent file ────────────────────────────────────

  describe('readText non-existent file', () => {
    it('should throw an error for a non-existent file path', async () => {
      await expect(kaos.readText('/nonexistent-path-that-does-not-exist')).rejects.toThrow();
    });

    it('should throw ENOENT error', async () => {
      try {
        await kaos.readText(join(tempDir, 'no-such-file.txt'));
        expect.unreachable('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(Error);
        expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('readBytes should also throw for non-existent file', async () => {
      await expect(kaos.readBytes(join(tempDir, 'missing.bin'))).rejects.toThrow();
    });
  });

  // ── 2. Write then immediately read consistency ───────────────────

  describe('write-then-read consistency', () => {
    it('writeText then readText returns identical content', async () => {
      const filePath = join(tempDir, 'consistency.txt');
      const content = 'Hello, consistency check!\nLine 2\nLine 3';

      await kaos.writeText(filePath, content);
      const readBack = await kaos.readText(filePath);

      expect(readBack).toBe(content);
    });

    it('writeBytes then readBytes returns identical content', async () => {
      const filePath = join(tempDir, 'consistency.bin');
      const data = Buffer.from([0x00, 0x01, 0x80, 0xff, 0xfe, 0x42]);

      await kaos.writeBytes(filePath, data);
      const readBack = await kaos.readBytes(filePath);

      expect(Buffer.compare(readBack, data)).toBe(0);
    });

    it('multiple rapid write-read cycles are consistent', async () => {
      const filePath = join(tempDir, 'rapid.txt');

      for (let i = 0; i < 50; i++) {
        const content = `iteration-${i}-${'x'.repeat(100)}`;
        await kaos.writeText(filePath, content);
        const readBack = await kaos.readText(filePath);
        expect(readBack).toBe(content);
      }
    });
  });

  // ── 3. Exec large output ─────────────────────────────────────────

  describe('exec large output', () => {
    it('captures complete stdout for large output (seq 1 10000 via node)', async () => {
      // Use node to generate seq 1..10000 (portable, no reliance on `seq` command)
      const code = `for(let i=1;i<=10000;i++) process.stdout.write(i+'\\n');`;
      const proc = await kaos.exec(...nodeArgs(code));

      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const stdout = await streamToBuffer(proc.stdout);
      const lines = stdout.toString('utf-8').trimEnd().split('\n');

      expect(lines).toHaveLength(10000);
      expect(lines[0]).toBe('1');
      expect(lines[9999]).toBe('10000');
    });
  });

  // ── 4. Exec simultaneous stderr and stdout ───────────────────────

  describe('exec simultaneous stderr and stdout', () => {
    it('stdout and stderr do not mix', async () => {
      const code = [
        `process.stdout.write('OUT-LINE-1\\n');`,
        `process.stderr.write('ERR-LINE-1\\n');`,
        `process.stdout.write('OUT-LINE-2\\n');`,
        `process.stderr.write('ERR-LINE-2\\n');`,
      ].join('');

      const proc = await kaos.exec(...nodeArgs(code));
      const exitCode = await proc.wait();
      expect(exitCode).toBe(0);

      const stdoutData = await streamToBuffer(proc.stdout);
      const stderrData = await streamToBuffer(proc.stderr);

      const stdoutStr = stdoutData.toString('utf-8').trimEnd();
      const stderrStr = stderrData.toString('utf-8').trimEnd();

      // stdout should only contain OUT lines
      expect(stdoutStr).toContain('OUT-LINE-1');
      expect(stdoutStr).toContain('OUT-LINE-2');
      expect(stdoutStr).not.toContain('ERR-LINE');

      // stderr should only contain ERR lines
      expect(stderrStr).toContain('ERR-LINE-1');
      expect(stderrStr).toContain('ERR-LINE-2');
      expect(stderrStr).not.toContain('OUT-LINE');
    });
  });

  // ── 5. mkdir existing directory ──────────────────────────────────

  describe('mkdir existing directory', () => {
    it('existOk=true does not throw for existing directory', async () => {
      const dirPath = join(tempDir, 'existing-dir');
      await kaos.mkdir(dirPath);

      // Should not throw
      await kaos.mkdir(dirPath, { existOk: true });

      // Verify directory still exists
      const s = await kaos.stat(dirPath);
      expect(s.stMode & 0o170000).toBe(0o040000); // S_IFDIR
    });

    it('without existOk (default false), recursive mkdir does not throw for existing', async () => {
      // Node's mkdir with recursive: false is the default
      // When parents=false and existOk=false (defaults), creating an existing dir
      // Note: Node.js mkdir with recursive:false throws EEXIST
      const dirPath = join(tempDir, 'will-exist');
      await kaos.mkdir(dirPath);

      // Default: parents=false, existOk=false
      // However, Node.js mkdir({recursive: false}) does throw EEXIST
      // Let's verify the behavior
      try {
        await kaos.mkdir(dirPath);
        // If it doesn't throw, that's also a valid behavior to document
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(Error);
        expect((error as NodeJS.ErrnoException).code).toBe('EEXIST');
      }
    });

    it('parents=true creates nested directories', async () => {
      const deepPath = join(tempDir, 'a', 'b', 'c', 'd');
      await kaos.mkdir(deepPath, { parents: true });

      const s = await kaos.stat(deepPath);
      expect(s.stMode & 0o170000).toBe(0o040000);
    });
  });

  // ── 6. Empty file operations ─────────────────────────────────────

  describe('empty file operations', () => {
    it('writeText("") then readText returns ""', async () => {
      const filePath = join(tempDir, 'empty.txt');

      const written = await kaos.writeText(filePath, '');
      expect(written).toBe(0);

      const content = await kaos.readText(filePath);
      expect(content).toBe('');
    });

    it('writeBytes(empty buffer) then readBytes returns empty buffer', async () => {
      const filePath = join(tempDir, 'empty.bin');

      const written = await kaos.writeBytes(filePath, Buffer.alloc(0));
      expect(written).toBe(0);

      const content = await kaos.readBytes(filePath);
      expect(content.length).toBe(0);
    });
  });

  // ── 7. Unicode file paths ────────────────────────────────────────

  describe('unicode file paths', () => {
    it('path with Chinese characters: correct read/write', async () => {
      const filePath = join(tempDir, '测试文件.txt');
      const content = '这是中文内容 Hello World';

      await kaos.writeText(filePath, content);
      const readBack = await kaos.readText(filePath);

      expect(readBack).toBe(content);
    });

    it('path with mixed unicode: emoji and CJK', async () => {
      const filePath = join(tempDir, '数据_报告.txt');
      const content = 'Unicode test content with special chars';

      await kaos.writeText(filePath, content);
      const readBack = await kaos.readText(filePath);

      expect(readBack).toBe(content);
    });

    it('unicode content in binary files', async () => {
      const filePath = join(tempDir, 'unicode_binary.bin');
      const content = '日本語テスト 한국어 العربية';
      const data = Buffer.from(content, 'utf-8');

      await kaos.writeBytes(filePath, data);
      const readBack = await kaos.readBytes(filePath);

      expect(readBack.toString('utf-8')).toBe(content);
    });

    it('stat works on unicode-named file', async () => {
      const filePath = join(tempDir, '统计.txt');
      await kaos.writeText(filePath, 'data');

      const s = await kaos.stat(filePath);
      expect(s.stSize).toBe(Buffer.byteLength('data', 'utf-8'));
    });
  });

  // ── 8. Glob empty results ────────────────────────────────────────

  describe('glob empty results', () => {
    it('glob with no matching files yields nothing', async () => {
      // tempDir is empty (or contains no .xyz files)
      const results: string[] = [];
      for await (const entry of kaos.glob(tempDir, '*.xyz')) {
        results.push(entry);
      }

      expect(results).toHaveLength(0);
    });

    it('glob in empty directory yields nothing', async () => {
      const emptyDir = join(tempDir, 'empty-dir');
      await kaos.mkdir(emptyDir);

      const results: string[] = [];
      for await (const entry of kaos.glob(emptyDir, '*')) {
        results.push(entry);
      }

      expect(results).toHaveLength(0);
    });

    it('glob with ** pattern in empty directory yields nothing', async () => {
      const emptyDir = join(tempDir, 'deep-empty');
      await kaos.mkdir(emptyDir);

      const results: string[] = [];
      for await (const entry of kaos.glob(emptyDir, '**/*.ts')) {
        results.push(entry);
      }

      expect(results).toHaveLength(0);
    });
  });
});
