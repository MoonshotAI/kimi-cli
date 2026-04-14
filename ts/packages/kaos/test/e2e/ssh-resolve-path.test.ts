import type { Client, SFTPWrapper, Stats as SFTPStats } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KaosFileExistsError } from '../../src/errors.js';
import { KaosFileNotFoundError, SSHKaos } from '../../src/ssh.js';

// ── SSH path resolution: mock SFTP harness ────────────────────────────
//
// This test file validates that SSHKaos file/dir operations correctly
// resolve *relative* paths against the instance's current working
// directory (`_cwd`) before handing the path off to SFTP.
//
// We mock the underlying `SFTPWrapper` so no network traffic is needed.
// Every SFTP method (readFile, writeFile, stat, lstat, mkdir, appendFile,
// exists, readdir, realpath) records the absolute path it receives, and
// returns a deterministic response. After each SSHKaos operation we
// inspect the recorded path to ensure the resolution worked.
//
// The private SSHKaos constructor is bypassed via `Reflect.construct` —
// TypeScript `private` is compile-time only, and we need a test-only
// instance that is not backed by a real SSH connection.

// ── Mock helpers ──────────────────────────────────────────────────────

interface MockSFTP {
  calls: { method: string; path: string; data?: string | Buffer }[];
  files: Map<string, Buffer>;
  dirs: Set<string>;
  mkdirFailures: Map<string, { error: Error; materializeAs: 'dir' | 'file' }>;
}

function makeMockStats(isDir: boolean, size: number = 0): SFTPStats {
  return {
    mode: isDir ? 0o040755 : 0o100644,
    uid: 1000,
    gid: 1000,
    size,
    atime: 0,
    mtime: 0,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
    isSocket: () => false,
    isCharacterDevice: () => false,
    isBlockDevice: () => false,
    isFIFO: () => false,
  } as unknown as SFTPStats;
}

function createMockSftp(state: MockSFTP): SFTPWrapper {
  // Only stub the SFTP methods used by the tests below.
  const sftp = {
    realpath(path: string, cb: (err: unknown, absPath: string) => void): void {
      state.calls.push({ method: 'realpath', path });
      // Mock realpath: if path is already absolute, echo it.
      // Otherwise it would be relative — but since SSHKaos always
      // resolves first, we should never see a relative input here.
      cb(null, path);
    },
    stat(path: string, cb: (err: unknown, stats: SFTPStats) => void): void {
      state.calls.push({ method: 'stat', path });
      if (state.dirs.has(path)) {
        cb(null, makeMockStats(true));
        return;
      }
      const buf = state.files.get(path);
      if (buf !== undefined) {
        cb(null, makeMockStats(false, buf.length));
        return;
      }
      // Missing — surface an ENOENT-shaped error.
      const err = Object.assign(new Error(`ENOENT: ${path}`), { code: 2 });
      cb(err, undefined as unknown as SFTPStats);
    },
    lstat(path: string, cb: (err: unknown, stats: SFTPStats) => void): void {
      state.calls.push({ method: 'lstat', path });
      sftp.stat(path, cb);
    },
    readFile(path: string, cb: (err: unknown, data: Buffer) => void): void {
      state.calls.push({ method: 'readFile', path });
      const buf = state.files.get(path);
      if (buf === undefined) {
        cb(new Error(`ENOENT: ${path}`), Buffer.alloc(0));
        return;
      }
      cb(null, buf);
    },
    writeFile(path: string, data: string | Buffer, cb: (err: unknown) => void): void {
      state.calls.push({ method: 'writeFile', path, data });
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      state.files.set(path, buf);
      cb(null);
    },
    appendFile(path: string, data: string | Buffer, cb: (err: unknown) => void): void {
      state.calls.push({ method: 'appendFile', path, data });
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      const existing = state.files.get(path) ?? Buffer.alloc(0);
      state.files.set(path, Buffer.concat([existing, buf]));
      cb(null);
    },
    exists(path: string, cb: (exists: boolean) => void): void {
      state.calls.push({ method: 'exists', path });
      cb(state.files.has(path) || state.dirs.has(path));
    },
    mkdir(path: string, cb: (err: unknown) => void): void {
      state.calls.push({ method: 'mkdir', path });
      const failure = state.mkdirFailures.get(path);
      if (failure) {
        if (failure.materializeAs === 'dir') {
          state.dirs.add(path);
        } else {
          state.files.set(path, Buffer.from('collision'));
        }
        cb(failure.error);
        return;
      }
      state.dirs.add(path);
      cb(null);
    },
    readdir(
      path: string,
      cb: (err: unknown, list: { filename: string; attrs: SFTPStats }[]) => void,
    ): void {
      state.calls.push({ method: 'readdir', path });
      // Return empty listing for simplicity.
      cb(null, []);
    },
    end(): void {
      // no-op
    },
  };
  return sftp as unknown as SFTPWrapper;
}

function createMockClient(): Client {
  return {
    end(): void {
      // no-op
    },
  } as unknown as Client;
}

/**
 * Construct an SSHKaos with the private constructor bypassed. TS
 * `private` is compile-time only — runtime reflection works. We use
 * `Reflect.construct` to hand-build an instance seeded with the mock
 * SFTP wrapper and a chosen home/cwd.
 */
function createMockedKaos(sftp: SFTPWrapper, home: string, cwd: string): SSHKaos {
  const client = createMockClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CtorAny = SSHKaos as any;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  return new CtorAny(client, sftp, home, cwd) as SSHKaos;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: SSHKaos relative path resolution after chdir (mocked SFTP)', () => {
  let state: MockSFTP;
  let sftp: SFTPWrapper;
  let kaos: SSHKaos;

  beforeEach(() => {
    state = {
      calls: [],
      files: new Map<string, Buffer>(),
      dirs: new Set<string>(),
      mkdirFailures: new Map<string, { error: Error; materializeAs: 'dir' | 'file' }>(),
    };
    sftp = createMockSftp(state);
    kaos = createMockedKaos(sftp, '/home/user', '/home/user');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readText / readBytes / readLines', () => {
    it('readText resolves relative path against current cwd', async () => {
      // chdir to /remote/tmp; relative "file.txt" must resolve to /remote/tmp/file.txt.
      state.dirs.add('/remote/tmp');
      await kaos.chdir('/remote/tmp');

      state.files.set('/remote/tmp/file.txt', Buffer.from('hello'));

      const text = await kaos.readText('file.txt');
      expect(text).toBe('hello');

      // Verify the SFTP readFile call received the absolute resolved path.
      const readCalls = state.calls.filter((c) => c.method === 'readFile');
      expect(readCalls).toHaveLength(1);
      expect(readCalls[0]!.path).toBe('/remote/tmp/file.txt');
    });

    it('readText accepts absolute path unchanged', async () => {
      state.dirs.add('/remote/tmp');
      await kaos.chdir('/remote/tmp');
      state.files.set('/etc/hosts', Buffer.from('127.0.0.1 localhost'));

      const text = await kaos.readText('/etc/hosts');
      expect(text).toBe('127.0.0.1 localhost');

      const readCalls = state.calls.filter((c) => c.method === 'readFile');
      expect(readCalls.some((c) => c.path === '/etc/hosts')).toBe(true);
      // And NOT /remote/tmp/etc/hosts
      expect(readCalls.some((c) => c.path === '/remote/tmp/etc/hosts')).toBe(false);
    });

    it('readBytes resolves relative path against current cwd', async () => {
      state.dirs.add('/opt/data');
      await kaos.chdir('/opt/data');
      state.files.set('/opt/data/blob.bin', Buffer.from([1, 2, 3, 4]));

      const bytes = await kaos.readBytes('blob.bin');
      expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);

      const readCalls = state.calls.filter((c) => c.method === 'readFile');
      expect(readCalls.some((c) => c.path === '/opt/data/blob.bin')).toBe(true);
    });

    it('readLines resolves relative path against current cwd', async () => {
      state.dirs.add('/var/log');
      await kaos.chdir('/var/log');
      state.files.set('/var/log/app.log', Buffer.from('line1\nline2\nline3'));

      const lines: string[] = [];
      for await (const line of kaos.readLines('app.log')) {
        lines.push(line);
      }
      expect(lines).toEqual(['line1', 'line2', 'line3']);

      const readCalls = state.calls.filter((c) => c.method === 'readFile');
      expect(readCalls.some((c) => c.path === '/var/log/app.log')).toBe(true);
    });

    it('readLines strips CRLF terminators', async () => {
      state.dirs.add('/var/log');
      await kaos.chdir('/var/log');
      state.files.set('/var/log/app-crlf.log', Buffer.from('line1\r\nline2\r\n'));

      const lines: string[] = [];
      for await (const line of kaos.readLines('app-crlf.log')) {
        lines.push(line);
      }

      expect(lines).toEqual(['line1', 'line2']);
    });
  });

  describe('writeText / writeBytes / appendFile', () => {
    it('writeText resolves relative path against current cwd', async () => {
      state.dirs.add('/workspace');
      await kaos.chdir('/workspace');

      const n = await kaos.writeText('out.txt', 'hello world');
      expect(n).toBe('hello world'.length);

      const writeCalls = state.calls.filter((c) => c.method === 'writeFile');
      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0]!.path).toBe('/workspace/out.txt');

      // Mock file store now contains the file at the resolved path.
      expect(state.files.get('/workspace/out.txt')?.toString('utf-8')).toBe('hello world');
    });

    it('writeBytes resolves relative path against current cwd', async () => {
      state.dirs.add('/workspace');
      await kaos.chdir('/workspace');

      const data = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
      const n = await kaos.writeBytes('blob.bin', data);
      expect(n).toBe(4);

      const writeCalls = state.calls.filter((c) => c.method === 'writeFile');
      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0]!.path).toBe('/workspace/blob.bin');
    });

    it('writeText with mode=a uses appendFile and resolves path', async () => {
      state.dirs.add('/logs');
      await kaos.chdir('/logs');

      await kaos.writeText('a.log', 'line1\n', { mode: 'a' });
      await kaos.writeText('a.log', 'line2\n', { mode: 'a' });

      const appendCalls = state.calls.filter((c) => c.method === 'appendFile');
      expect(appendCalls).toHaveLength(2);
      expect(appendCalls[0]!.path).toBe('/logs/a.log');
      expect(appendCalls[1]!.path).toBe('/logs/a.log');

      expect(state.files.get('/logs/a.log')?.toString('utf-8')).toBe('line1\nline2\n');
    });
  });

  describe('stat / mkdir', () => {
    it('stat resolves relative path against current cwd', async () => {
      state.dirs.add('/srv');
      await kaos.chdir('/srv');
      state.files.set('/srv/config.json', Buffer.from('{}'));

      const result = await kaos.stat('config.json');
      expect(result.stSize).toBe(2);

      const statCalls = state.calls.filter((c) => c.method === 'stat');
      expect(statCalls.some((c) => c.path === '/srv/config.json')).toBe(true);
    });

    it('stat preserves NO_SUCH_FILE as KaosFileNotFoundError', async () => {
      state.dirs.add('/srv');
      await kaos.chdir('/srv');

      await expect(kaos.stat('missing.json')).rejects.toBeInstanceOf(KaosFileNotFoundError);
      await expect(kaos.stat('missing.json')).rejects.toMatchObject({ code: 2 });
    });

    it('stat with followSymlinks=false uses lstat and resolves path', async () => {
      state.dirs.add('/srv');
      await kaos.chdir('/srv');
      state.files.set('/srv/link', Buffer.from('data'));

      await kaos.stat('link', { followSymlinks: false });

      const lstatCalls = state.calls.filter((c) => c.method === 'lstat');
      expect(lstatCalls).toHaveLength(1);
      expect(lstatCalls[0]!.path).toBe('/srv/link');
    });

    it('mkdir resolves relative path against current cwd', async () => {
      state.dirs.add('/workspace');
      await kaos.chdir('/workspace');

      await kaos.mkdir('newdir');

      const mkdirCalls = state.calls.filter((c) => c.method === 'mkdir');
      expect(mkdirCalls).toHaveLength(1);
      expect(mkdirCalls[0]!.path).toBe('/workspace/newdir');
    });

    it('mkdir with parents=true resolves and creates intermediate dirs', async () => {
      state.dirs.add('/workspace');
      await kaos.chdir('/workspace');

      await kaos.mkdir('a/b/c', { parents: true });

      const mkdirCalls = state.calls.filter((c) => c.method === 'mkdir');
      const mkdirPaths = mkdirCalls.map((c) => c.path);
      expect(mkdirPaths).toContain('/workspace/a');
      expect(mkdirPaths).toContain('/workspace/a/b');
      expect(mkdirPaths).toContain('/workspace/a/b/c');
      expect(mkdirPaths.every((path) => !path.includes('//'))).toBe(true);
    });

    it('mkdir existOk=true is idempotent against the resolved path', async () => {
      state.dirs.add('/workspace');
      await kaos.chdir('/workspace');
      // Pre-seed the target directory.
      state.dirs.add('/workspace/existing');

      await expect(kaos.mkdir('existing', { existOk: true })).resolves.toBeUndefined();

      // Without existOk, it should throw.
      await expect(kaos.mkdir('existing', { existOk: false })).rejects.toThrow();
    });

    it('mkdir with parents=true rejects a raced file collision when existOk=true', async () => {
      state.dirs.add('/workspace');
      await kaos.chdir('/workspace');

      const racePaths = ['/workspace/collision', '//workspace/collision'];
      for (const racePath of racePaths) {
        state.mkdirFailures.set(racePath, {
          error: new Error('EEXIST'),
          materializeAs: 'file',
        });
      }

      await expect(
        kaos.mkdir('collision', { parents: true, existOk: true }),
      ).rejects.toBeInstanceOf(KaosFileExistsError);
    });
  });

  describe('iterdir', () => {
    it('iterdir with relative "." resolves to cwd', async () => {
      state.dirs.add('/workspace');
      await kaos.chdir('/workspace');

      const entries: string[] = [];
      for await (const entry of kaos.iterdir('.')) {
        entries.push(entry);
      }
      // (readdir mock returns empty list; we're asserting the path passed to readdir)

      const readdirCalls = state.calls.filter((c) => c.method === 'readdir');
      expect(readdirCalls).toHaveLength(1);
      // posix.join('/workspace', '.') normalises to '/workspace'
      expect(readdirCalls[0]!.path).toBe('/workspace');
      expect(entries).toEqual([]);
    });

    it('iterdir with named relative subdir resolves under cwd', async () => {
      state.dirs.add('/workspace');
      state.dirs.add('/workspace/sub');
      await kaos.chdir('/workspace');

      const entries: string[] = [];
      for await (const entry of kaos.iterdir('sub')) {
        entries.push(entry);
      }

      const readdirCalls = state.calls.filter((c) => c.method === 'readdir');
      expect(readdirCalls).toHaveLength(1);
      expect(readdirCalls[0]!.path).toBe('/workspace/sub');
      expect(entries).toEqual([]);
    });
  });

  describe('chdir follows realpath and affects subsequent relative ops', () => {
    it('consecutive chdir + readText rebase the working directory each time', async () => {
      state.dirs.add('/a');
      state.dirs.add('/b');
      state.files.set('/a/one.txt', Buffer.from('A'));
      state.files.set('/b/two.txt', Buffer.from('B'));

      await kaos.chdir('/a');
      expect(await kaos.readText('one.txt')).toBe('A');

      await kaos.chdir('/b');
      expect(await kaos.readText('two.txt')).toBe('B');

      // After chdir(/b), a relative path that only exists under /a
      // must NOT resolve — confirming we've truly rebased.
      await expect(kaos.readText('one.txt')).rejects.toThrow();
    });

    it('chdir with a relative argument resolves against the prior cwd', async () => {
      state.dirs.add('/home/user');
      state.dirs.add('/home/user/project');

      await kaos.chdir('/home/user');
      await kaos.chdir('project');

      expect(kaos.getcwd()).toBe('/home/user/project');

      state.files.set('/home/user/project/README.md', Buffer.from('readme'));
      expect(await kaos.readText('README.md')).toBe('readme');
    });
  });
});
