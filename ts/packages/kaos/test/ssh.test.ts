import { EventEmitter } from 'node:events';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';

import { resetCurrentKaos, setCurrentKaos } from '../src/current.js';
import type { KaosToken } from '../src/current.js';
import { KaosValueError } from '../src/errors.js';
import { KaosPath } from '../src/path.js';
import { SSHKaos } from '../src/ssh.js';

// Environment variable configuration for SSH connection
const SSH_SMOKE = process.env['KAOS_SSH_SMOKE'] === '1';
const SSH_HOST = process.env['KAOS_SSH_HOST'] ?? '127.0.0.1';
const SSH_PORT = Number(process.env['KAOS_SSH_PORT'] ?? '22');
const SSH_USERNAME = process.env['KAOS_SSH_USERNAME'];
const SSH_PASSWORD = process.env['KAOS_SSH_PASSWORD'];
const SSH_KEY_PATHS = process.env['KAOS_SSH_KEY_PATHS']?.split(',').filter(Boolean);
const SSH_KEY_CONTENTS = process.env['KAOS_SSH_KEY_CONTENTS']?.split('|||').filter(Boolean);

// S_IFMT mask and file type constants
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

// Explicit opt-in smoke: set KAOS_SSH_SMOKE=1 plus SSH credentials.
describe.skipIf(process.platform === 'win32' || !SSH_SMOKE)('SSHKaos smoke', () => {
  let sshKaos: SSHKaos;
  let remoteBase = '';
  let token: KaosToken | undefined;

  beforeAll(async () => {
    if (SSH_USERNAME === undefined) {
      throw new Error('KAOS_SSH_SMOKE=1 requires KAOS_SSH_USERNAME');
    }

    // Dynamic import to avoid compilation errors when ssh2 is not available
    const { SSHKaos: SSHKaosClass } = await import('../src/ssh.js');
    sshKaos = await SSHKaosClass.create({
      host: SSH_HOST,
      port: SSH_PORT,
      username: SSH_USERNAME,
      ...(SSH_PASSWORD !== undefined ? { password: SSH_PASSWORD } : {}),
      ...(SSH_KEY_PATHS !== undefined ? { keyPaths: SSH_KEY_PATHS } : {}),
      ...(SSH_KEY_CONTENTS !== undefined ? { keyContents: SSH_KEY_CONTENTS } : {}),
    });
  });

  beforeEach(async () => {
    // Create an isolated remote directory for each test
    const uuid = Math.random().toString(36).slice(2);
    remoteBase = `${sshKaos.gethome()}/.kaos_test_${process.pid}_${uuid}`;
    await sshKaos.mkdir(remoteBase, { parents: true, existOk: true });
    await sshKaos.chdir(remoteBase);
  });

  afterEach(async () => {
    if (token !== undefined) {
      resetCurrentKaos(token);
      token = undefined;
    }
    // Cleanup the remote directory best-effort, but always restore cwd.
    if (remoteBase.length > 0) {
      try {
        const proc = await sshKaos.exec('rm', '-rf', remoteBase);
        await proc.wait();
      } finally {
        remoteBase = '';
        await sshKaos.chdir(sshKaos.gethome());
      }
    }
  });

  afterAll(async () => {
    if (sshKaos) await sshKaos.close();
  });

  test('pathClass, home, and cwd', () => {
    const home = sshKaos.gethome();
    const cwd = sshKaos.getcwd();

    expect(sshKaos.pathClass()).toBe('posix');
    expect(home.length).toBeGreaterThan(0);
    expect(cwd.length).toBeGreaterThan(0);
    // Home should be absolute
    expect(home.startsWith('/')).toBe(true);
    // cwd should be absolute
    expect(cwd.startsWith('/')).toBe(true);
  });

  test('chdir updates real path', async () => {
    await sshKaos.chdir(remoteBase);
    expect(sshKaos.getcwd()).toBe(remoteBase);

    await sshKaos.mkdir(remoteBase + '/child', { existOk: true });
    await sshKaos.chdir('child');
    expect(sshKaos.getcwd()).toBe(remoteBase + '/child');

    await sshKaos.chdir('..');
    expect(sshKaos.getcwd()).toBe(remoteBase);
  });

  test('exec respects cwd', async () => {
    await sshKaos.chdir(remoteBase);

    const proc = await sshKaos.exec('pwd');
    const out = (await streamToBuffer(proc.stdout)).toString().trim();
    const code = await proc.wait();

    expect(code).toBe(0);
    expect(out).toBe(remoteBase);
  });

  test('exec wait before read', async () => {
    const proc = await sshKaos.exec('echo', 'output');

    const exitCode = await proc.wait();
    const output = (await streamToBuffer(proc.stdout)).toString().trim();

    expect(exitCode).toBe(0);
    expect(output).toBe('output');
  });

  test('mkdir respects existOk', async () => {
    const nestedDir = remoteBase + '/deep/level';

    await sshKaos.mkdir(nestedDir, { parents: true, existOk: false });

    await expect(sshKaos.mkdir(nestedDir, { existOk: false })).rejects.toThrow();

    // Should not throw with existOk
    await sshKaos.mkdir(nestedDir, { parents: true, existOk: true });
  });

  test('stat reports directory and file metadata', async () => {
    const dirStat = await sshKaos.stat(remoteBase, { followSymlinks: false });
    expect((dirStat.stMode & S_IFMT) === S_IFDIR).toBe(true);

    const filePath = remoteBase + '/payload.txt';
    const payload = 'metadata';
    await sshKaos.writeText(filePath, payload);

    const fileStat = await sshKaos.stat(filePath);
    expect((fileStat.stMode & S_IFMT) === S_IFREG).toBe(true);
    expect(fileStat.stSize).toBe(payload.length);
    expect(fileStat.stNlink).toBeGreaterThanOrEqual(0);
  });

  test('KaosPath roundtrip via SSH', async () => {
    token = setCurrentKaos(sshKaos);
    await sshKaos.chdir(remoteBase);

    const textPath = remoteBase + '/text.txt';
    const bytesPath = remoteBase + '/blob.bin';

    const textPayload = 'Hello SSH\n';
    const appended = 'More data\n';
    const written = await sshKaos.writeText(textPath, textPayload);
    expect(written).toBe(textPayload.length);

    const appendedLen = await sshKaos.writeText(textPath, appended, { mode: 'a' });
    expect(appendedLen).toBe(appended.length);

    const fullText = await sshKaos.readText(textPath);
    expect(fullText).toBe(textPayload + appended);

    const lines: string[] = [];
    for await (const line of sshKaos.readLines(textPath)) {
      lines.push(line);
    }
    expect(lines).toEqual(['Hello SSH', 'More data']);

    const bytesPayload = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const bytesWritten = await sshKaos.writeBytes(bytesPath, bytesPayload);
    expect(bytesWritten).toBe(bytesPayload.length);

    const roundtrip = await sshKaos.readBytes(bytesPath);
    expect(Buffer.compare(roundtrip, bytesPayload)).toBe(0);

    expect(KaosPath.cwd().toString()).toBe(remoteBase);
  });

  test('iterdir lists child entries', async () => {
    await sshKaos.writeText(remoteBase + '/file1.txt', '1');
    await sshKaos.writeText(remoteBase + '/file2.log', '2');
    await sshKaos.mkdir(remoteBase + '/subdir', { existOk: true });

    const entries: string[] = [];
    for await (const entry of sshKaos.iterdir(remoteBase)) {
      entries.push(entry);
    }
    const names = new Set(entries.map((e) => e.split('/').pop()!));

    expect(names).toEqual(new Set(['file1.txt', 'file2.log', 'subdir']));
  });

  test('glob is case sensitive', async () => {
    await sshKaos.writeText(remoteBase + '/file.log', 'lowercase');
    await sshKaos.writeText(remoteBase + '/FILE.LOG', 'uppercase');

    const matches = new Set<string>();
    for await (const path of sshKaos.glob(remoteBase, '*.log')) {
      matches.add(path);
    }
    expect(matches.has(remoteBase + '/file.log')).toBe(true);
    expect(matches.has(remoteBase + '/FILE.LOG')).toBe(false);

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of sshKaos.glob(remoteBase, '*.log', { caseSensitive: false })) {
        // should throw before yielding
      }
    }).rejects.toThrow('Case insensitive glob is not supported');
  });

  test('exec streams stdout and stderr', async () => {
    const proc = await sshKaos.exec('sh', '-c', "printf 'out\\n' && printf 'err\\n' 1>&2");

    const [stdoutData, stderrData] = await Promise.all([
      streamToBuffer(proc.stdout),
      streamToBuffer(proc.stderr),
    ]);
    const exitCode = await proc.wait();

    expect(exitCode).toBe(0);
    expect(proc.exitCode).toBe(0);
    expect(stdoutData.toString().trim()).toBe('out');
    expect(stderrData.toString().trim()).toBe('err');
  });

  test('exec rejects empty command', async () => {
    await expect((sshKaos.exec as (...args: string[]) => Promise<unknown>)()).rejects.toThrow();
  });

  test('process kill updates returncode', async () => {
    const proc = await sshKaos.exec('sh', '-c', 'echo ready; sleep 30');

    // Read the first line to know the process has started
    const firstChunk = await new Promise<Buffer>((resolve) => {
      proc.stdout.once('data', (chunk: Buffer) => {
        resolve(chunk);
      });
    });
    expect(firstChunk.toString().trim()).toBe('ready');
    expect(proc.exitCode).toBeNull();

    await proc.kill();
    const exitCode = await proc.wait();

    expect(exitCode).not.toBe(0);
    expect(proc.exitCode).toBe(exitCode);
    expect(proc.pid).toBe(-1);
  });
});

// These tests don't need a live SSH connection — they exercise the
// argument-validation guards that run before any network I/O. We invoke the
// methods through the prototype so no real instance is constructed.
describe('SSHKaos argument validation', () => {
  it('exec() throws with the correct class name when args is empty', () => {
    const fakeThis = {} as SSHKaos;
    expect(() => SSHKaos.prototype.exec.call(fakeThis)).toThrow(KaosValueError);
    expect(() => SSHKaos.prototype.exec.call(fakeThis)).toThrow(/SSHKaos\.exec\(\)/);
  });

  it('execWithEnv() throws with the correct class name when args is empty', () => {
    const fakeThis = {} as SSHKaos;
    expect(() => SSHKaos.prototype.execWithEnv.call(fakeThis, [])).toThrow(KaosValueError);
    expect(() => SSHKaos.prototype.execWithEnv.call(fakeThis, [])).toThrow(
      /SSHKaos\.execWithEnv\(\)/,
    );
  });
});

// chdir should refuse to treat a regular file (or anything that isn't a
// directory) as the new working directory. Without this guard, `sftp.realpath`
// happily returns file paths and later relative reads/writes/execs would
// resolve against a file — silently wrong. We exercise this by constructing
// a fake SFTP that returns a file stat so the test needs no live SSH.
describe('SSHKaos.chdir directory validation', () => {
  // Minimal SFTPWrapper stub with only the methods chdir needs.
  function makeFakeSftp(target: string, isDir: boolean): unknown {
    return {
      realpath(_path: string, cb: (err: Error | null | undefined, absPath: string) => void): void {
        cb(null, target);
      },
      stat(
        _path: string,
        cb: (err: Error | null | undefined, stats: Record<string, unknown>) => void,
      ): void {
        cb(null, {
          mode: isDir ? 0o040755 : 0o100644,
          size: 0,
          uid: 0,
          gid: 0,
          atime: 0,
          mtime: 0,
          isDirectory: () => isDir,
          isFile: () => !isDir,
          isSymbolicLink: () => false,
          isSocket: () => false,
          isCharacterDevice: () => false,
          isBlockDevice: () => false,
          isFIFO: () => false,
        });
      },
    };
  }

  function makeFakeInstance(sftp: unknown, cwd: string): SSHKaos {
    // Bypass the real constructor (which requires a live ssh2 client) and
    // populate just the private fields that chdir touches.
    const instance = Object.create(SSHKaos.prototype) as SSHKaos;
    const internal = instance as unknown as { _sftp: unknown; _cwd: string };
    internal._sftp = sftp;
    internal._cwd = cwd;
    return instance;
  }

  it('rejects a target that resolves to a regular file', async () => {
    const target = '/tmp/not-a-dir.txt';
    const sftp = makeFakeSftp(target, /*isDir=*/ false);
    const kaos = makeFakeInstance(sftp, '/tmp');

    await expect(kaos.chdir(target)).rejects.toThrow(KaosValueError);
    await expect(kaos.chdir(target)).rejects.toThrow(/not a directory/);
    // cwd must remain unchanged on failure.
    expect(kaos.getcwd()).toBe('/tmp');
  });

  it('accepts a target that resolves to a directory', async () => {
    const target = '/tmp/real-dir';
    const sftp = makeFakeSftp(target, /*isDir=*/ true);
    const kaos = makeFakeInstance(sftp, '/tmp');

    await kaos.chdir(target);
    expect(kaos.getcwd()).toBe(target);
  });
});

describe('SSHKaos.close lifecycle', () => {
  class FakeClient extends EventEmitter {
    closed = false;

    end(): void {
      queueMicrotask(() => {
        this.closed = true;
        this.emit('close');
      });
    }

    exec(
      _command: string,
      optionsOrCallback:
        | ((err: Error | undefined, channel: never) => void)
        | Record<string, unknown>,
      maybeCallback?: (err: Error | undefined, channel: never) => void,
    ): void {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      if (callback === undefined) {
        return;
      }
      if (this.closed) {
        callback(new Error('channel closed'), undefined as never);
        return;
      }
      callback(undefined, undefined as never);
    }
  }

  function createCloseableKaos(): SSHKaos {
    const instance = Object.create(SSHKaos.prototype) as SSHKaos;
    const internals = instance as unknown as {
      _client: FakeClient;
      _cwd: string;
      _home: string;
      _sftp: { end(): void };
    };
    internals._client = new FakeClient();
    internals._cwd = '/tmp';
    internals._home = '/tmp';
    internals._sftp = {
      end(): void {
        // no-op
      },
    };
    return instance;
  }

  it('awaits the close event before allowing follow-up execs to observe the closed state', async () => {
    const kaos = createCloseableKaos();

    await kaos.close();

    await expect(kaos.exec('pwd')).rejects.toThrow(/channel closed/);
  });
});
