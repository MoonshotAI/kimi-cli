import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as win32Path from 'node:path/win32';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetCurrentKaos, setCurrentKaos } from '../src/current.js';
import type { KaosToken } from '../src/current.js';
import type { Kaos } from '../src/kaos.js';
import { LocalKaos } from '../src/local.js';
import { KaosPath } from '../src/path.js';

describe('KaosPath', () => {
  let token: KaosToken;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kaos-path-'));
    const kaos = new LocalKaos();
    token = setCurrentKaos(kaos);
  });

  afterEach(async () => {
    resetCurrentKaos(token);
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('join and parent', () => {
    it('should join paths with div', () => {
      const p = new KaosPath('/usr');
      const child = p.div('local').div('bin');
      expect(child.toString()).toBe('/usr/local/bin');
    });

    it('should join paths with joinpath', () => {
      const p = new KaosPath('/usr');
      const child = p.joinpath('local', 'bin');
      expect(child.toString()).toBe('/usr/local/bin');
    });

    it('should accept another KaosPath as div() argument', () => {
      // Exercises the `other instanceof KaosPath` branch in div() — the
      // existing tests only pass raw strings so this covers the other
      // side of the ternary.
      const p = new KaosPath('/usr');
      const sub = new KaosPath('local');
      expect(p.div(sub).toString()).toBe('/usr/local');
    });

    it('should return the parent path', () => {
      const p = new KaosPath('/usr/local/bin');
      expect(p.parent.toString()).toBe('/usr/local');
      expect(p.parent.parent.toString()).toBe('/usr');
    });

    it('should return the name', () => {
      const p = new KaosPath('/usr/local/bin');
      expect(p.name).toBe('bin');
    });

    it('should detect absolute paths', () => {
      expect(new KaosPath('/usr').isAbsolute()).toBe(true);
      expect(new KaosPath('relative/path').isAbsolute()).toBe(false);
    });

    it('should default to "." when constructed with no arguments', () => {
      // KaosPath() with no args represents the current directory placeholder.
      // Used as a neutral starting point before chaining .div()/.joinpath().
      const p = new KaosPath();
      expect(p.toString()).toBe('.');
    });
  });

  describe('home and cwd', () => {
    it('should return home directory via KaosPath.home()', () => {
      const home = KaosPath.home();
      expect(home.isAbsolute()).toBe(true);
      expect(home.toString()).toBe(homedir());
    });

    it('should return cwd via KaosPath.cwd()', () => {
      const cwd = KaosPath.cwd();
      expect(cwd.isAbsolute()).toBe(true);
      expect(cwd.toString()).toBe(process.cwd());
    });
  });

  describe('expanduser', () => {
    it('should expand ~ to home directory', () => {
      const p = new KaosPath('~/Documents');
      const expanded = p.expanduser();
      expect(expanded.toString()).toBe(join(homedir(), 'Documents'));
      expect(expanded.isAbsolute()).toBe(true);
    });

    it('should expand bare ~ to home directory', () => {
      const p = new KaosPath('~');
      const expanded = p.expanduser();
      expect(expanded.toString()).toBe(homedir());
    });

    it('should not expand ~ in the middle of a path', () => {
      const p = new KaosPath('/usr/~test');
      const expanded = p.expanduser();
      expect(expanded.toString()).toBe('/usr/~test');
    });
  });

  describe('canonical and relativeTo', () => {
    it('should resolve .. in an absolute path', () => {
      const p = new KaosPath('/usr/local/../bin');
      const c = p.canonical();
      expect(c.toString()).toBe('/usr/bin');
    });

    it('should make relative paths absolute using cwd', () => {
      const p = new KaosPath('foo/bar');
      const c = p.canonical();
      expect(c.isAbsolute()).toBe(true);
      expect(c.toString()).toBe(join(process.cwd(), 'foo/bar'));
    });

    it('should resolve .. in a relative path against cwd', () => {
      // Pins the Python test_kaos_path.py::test_canonical_and_relative_to case:
      // a relative input that also contains '..' must first rebase to cwd and
      // then collapse the parent reference.
      const p = new KaosPath('nested/../file.txt').canonical();
      expect(p.isAbsolute()).toBe(true);
      expect(p.toString()).toBe(join(process.cwd(), 'file.txt'));
    });

    it('should compute relativeTo correctly', () => {
      const child = new KaosPath('/usr/local/bin');
      const base = new KaosPath('/usr/local');
      const rel = child.relativeTo(base);
      expect(rel.toString()).toBe('bin');
    });

    it('should return dot for identical paths', () => {
      const p = new KaosPath('/usr/local');
      expect(p.relativeTo(new KaosPath('/usr/local')).toString()).toBe('.');
    });

    it('should reject sibling paths for relativeTo', () => {
      const a = new KaosPath('/usr/local/lib');
      const base = new KaosPath('/usr/local/bin');
      expect(() => a.relativeTo(base)).toThrow(/not within/);
    });

    it('should reject when base is deeper than target', () => {
      // The target is strictly shorter than base — there is no way for it to
      // live "within" a deeper base. Hits the parts-length guard separately
      // from the loop-based prefix-mismatch guard.
      const a = new KaosPath('/usr');
      const base = new KaosPath('/usr/local/bin');
      expect(() => a.relativeTo(base)).toThrow(/not within/);
    });

    it('should compute relativeTo between two relative paths (empty root)', () => {
      // Both operands have no absolute root, so splitPathLexically takes
      // the `root.length === 0 ? path : path.slice(root.length)` else branch.
      // Pinning this keeps the purely-relative relativeTo path honest.
      const child = new KaosPath('a/b/c');
      const base = new KaosPath('a/b');
      expect(child.relativeTo(base).toString()).toBe('c');
    });

    it('should use win32 separators when the current kaos reports win32', () => {
      // Build a minimal Kaos mock that claims win32 path semantics. Canonical
      // must not hard-code POSIX separators — it should use win32's resolver
      // so relative paths joined with the Windows cwd use backslashes.
      const winKaos: Kaos = {
        name: 'mock-win32',
        pathClass: () => 'win32',
        normpath: (p: string) => win32Path.normalize(p),
        gethome: () => 'C:\\Users\\test',
        getcwd: () => 'C:\\work\\project',
        chdir: async () => {},
        stat: async () => ({
          stMode: 0,
          stIno: 0,
          stDev: 0,
          stNlink: 0,
          stUid: 0,
          stGid: 0,
          stSize: 0,
          stAtime: 0,
          stMtime: 0,
          stCtime: 0,
        }),
        iterdir: async function* () {},
        glob: async function* () {},
        readBytes: async () => Buffer.alloc(0),
        readText: async () => '',
        readLines: async function* () {},
        writeBytes: async () => 0,
        writeText: async () => 0,
        mkdir: async () => {},
        exec: async () => {
          throw new Error('not implemented');
        },
        execWithEnv: async () => {
          throw new Error('not implemented');
        },
      };

      // Nested set so the outer beforeEach token is still restored cleanly
      // by afterEach; we explicitly reset the inner token here.
      const innerToken = setCurrentKaos(winKaos);
      try {
        const rel = new KaosPath('foo\\bar').canonical();
        // Resolved against 'C:\\work\\project' → 'C:\\work\\project\\foo\\bar'.
        // Critically: NO forward slashes in the result.
        expect(rel.toString()).toBe('C:\\work\\project\\foo\\bar');
        expect(rel.toString().includes('/')).toBe(false);

        const abs = new KaosPath('C:\\foo\\..\\bar').canonical();
        expect(abs.toString()).toBe('C:\\bar');

        expect(() => new KaosPath('D:\\logs').relativeTo(new KaosPath('C:\\work'))).toThrow(
          /not within/,
        );
      } finally {
        resetCurrentKaos(innerToken);
      }
    });
  });

  describe('exists and file operations', () => {
    it('should detect file existence', async () => {
      const p = new KaosPath(join(tmpDir, 'hello.txt'));
      expect(await p.exists()).toBe(false);
      await p.writeText('hello');
      expect(await p.exists()).toBe(true);
    });

    it('should write and read text', async () => {
      const p = new KaosPath(join(tmpDir, 'test.txt'));
      await p.writeText('hello world');
      const text = await p.readText();
      expect(text).toBe('hello world');
    });

    it('should identify files and directories', async () => {
      const f = new KaosPath(join(tmpDir, 'file.txt'));
      await f.writeText('content');
      expect(await f.isFile()).toBe(true);
      expect(await f.isDir()).toBe(false);

      const d = new KaosPath(tmpDir);
      expect(await d.isDir()).toBe(true);
      expect(await d.isFile()).toBe(false);
    });

    it('should append text', async () => {
      const p = new KaosPath(join(tmpDir, 'append.txt'));
      await p.writeText('hello');
      await p.appendText(' world');
      const text = await p.readText();
      expect(text).toBe('hello world');
    });

    it('should create directories', async () => {
      const d = new KaosPath(join(tmpDir, 'a', 'b', 'c'));
      await d.mkdir({ parents: true });
      expect(await d.isDir()).toBe(true);
    });

    it('should handle existOk for mkdir', async () => {
      const d = new KaosPath(tmpDir);
      // Should not throw
      await expect(d.mkdir({ existOk: true })).resolves.toBeUndefined();
    });

    it('should return false for isFile on a non-existent path', async () => {
      // exists()/isFile()/isDir() all swallow stat errors and return false
      // for missing paths. Pin that behavior so a regression does not
      // silently start throwing on absent files.
      const p = new KaosPath(join(tmpDir, 'does-not-exist.txt'));
      expect(await p.isFile()).toBe(false);
    });

    it('should return false for isDir on a non-existent path', async () => {
      const p = new KaosPath(join(tmpDir, 'also-missing'));
      expect(await p.isDir()).toBe(false);
    });

    it('should append text with an explicit encoding option', async () => {
      // appendText accepts an encoding option that threads through to
      // kaos.writeText({ mode: 'a', encoding }). Exercising the explicit
      // encoding branch keeps the option wiring honest.
      const p = new KaosPath(join(tmpDir, 'enc-append.txt'));
      await p.writeText('head-');
      await p.appendText('tail', { encoding: 'utf-8' });
      expect(await p.readText()).toBe('head-tail');
    });
  });

  describe('iterdir and glob', () => {
    it('should iterate directory entries', async () => {
      await new KaosPath(join(tmpDir, 'a.txt')).writeText('a');
      await new KaosPath(join(tmpDir, 'b.txt')).writeText('b');
      await new KaosPath(join(tmpDir, 'c.md')).writeText('c');

      const entries: string[] = [];
      const dir = new KaosPath(tmpDir);
      for await (const entry of dir.iterdir()) {
        entries.push(entry.name);
      }
      expect([...entries].toSorted()).toEqual(['a.txt', 'b.txt', 'c.md']);
    });

    it('should glob for matching files', async () => {
      await new KaosPath(join(tmpDir, 'foo.txt')).writeText('foo');
      await new KaosPath(join(tmpDir, 'bar.txt')).writeText('bar');
      await new KaosPath(join(tmpDir, 'baz.md')).writeText('baz');

      const matches: string[] = [];
      const dir = new KaosPath(tmpDir);
      for await (const entry of dir.glob('*.txt')) {
        matches.push(entry.name);
      }
      expect([...matches].toSorted()).toEqual(['bar.txt', 'foo.txt']);
    });
  });

  describe('read and write bytes', () => {
    it('should write and read binary data', async () => {
      const p = new KaosPath(join(tmpDir, 'data.bin'));
      const data = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
      const written = await p.writeBytes(data);
      expect(written).toBe(5);

      const read = await p.readBytes();
      expect(Buffer.compare(read, data)).toBe(0);
    });
  });

  describe('readLines', () => {
    it('should yield lines from a file', async () => {
      const p = new KaosPath(join(tmpDir, 'lines.txt'));
      await p.writeText('line1\nline2\nline3');

      const lines: string[] = [];
      for await (const line of p.readLines()) {
        lines.push(line);
      }
      // readLines yields lines with trailing \n except for the last line
      expect(lines).toEqual(['line1\n', 'line2\n', 'line3']);
    });
  });

  describe('fromLocalPath and toLocalPath', () => {
    it('should round-trip a path string', () => {
      const original = '/usr/local/bin/node';
      const p = KaosPath.fromLocalPath(original);
      expect(p.toLocalPath()).toBe(original);
      expect(p.toString()).toBe(original);
    });
  });

  describe('equals', () => {
    it('returns true for two KaosPath instances with the same path string', () => {
      const a = new KaosPath('/foo/bar');
      const b = new KaosPath('/foo/bar');
      expect(a.equals(b)).toBe(true);
    });

    it('returns false for different path strings', () => {
      const a = new KaosPath('/foo/bar');
      const b = new KaosPath('/foo/baz');
      expect(a.equals(b)).toBe(false);
    });

    it('returns true after joining equivalent segments', () => {
      const a = new KaosPath('/foo').div('bar');
      const b = new KaosPath('/foo/bar');
      expect(a.equals(b)).toBe(true);
    });

    it('is symmetric', () => {
      const a = new KaosPath('/a/b/c');
      const b = new KaosPath('/a/b/c');
      expect(a.equals(b)).toBe(b.equals(a));
    });
  });
});
