import { EventEmitter } from 'node:events';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';

import { resetCurrentKaos, setCurrentKaos } from '../src/current.js';
import type { KaosToken } from '../src/current.js';
import { KaosFileExistsError, KaosValueError } from '../src/errors.js';
import { KaosPath } from '../src/path.js';
import {
  KaosConnectionError,
  KaosFileNotFoundError,
  KaosPermissionError,
  KaosSSHError,
  SSHKaos,
} from '../src/ssh.js';
import type { StatResult } from '../src/types.js';

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

    // Python test_mkdir_respects_exist_ok pins `pytest.raises(FileExistsError)`
    // — match that strength by asserting the specific KaosFileExistsError class
    // rather than any throwable.
    await expect(sshKaos.mkdir(nestedDir, { existOk: false })).rejects.toBeInstanceOf(
      KaosFileExistsError,
    );

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

  // NOTE: these execWithEnv tests require the remote sshd to accept the
  // injected variable names via its `AcceptEnv` directive (or an equivalent
  // mechanism). Stock OpenSSH only whitelists LANG/LC_*; if the test server
  // is not configured to accept KAOS_TEST_*, these tests will fail — which
  // is exactly the signal we want (it reveals the silent env-drop bug that
  // the Python version has).
  test('execWithEnv delivers a single env var to the remote process', async () => {
    const proc = await sshKaos.execWithEnv(['sh', '-c', 'printf "%s" "${KAOS_TEST_MARKER}"'], {
      KAOS_TEST_MARKER: 'beacon42',
    });
    const out = (await streamToBuffer(proc.stdout)).toString();
    const code = await proc.wait();

    expect(code).toBe(0);
    expect(out).toBe('beacon42');
  });

  test('execWithEnv delivers multiple env vars', async () => {
    const proc = await sshKaos.execWithEnv(
      ['sh', '-c', 'printf "%s|%s" "${KAOS_TEST_A}" "${KAOS_TEST_B}"'],
      { KAOS_TEST_A: 'hello', KAOS_TEST_B: 'world' },
    );
    const out = (await streamToBuffer(proc.stdout)).toString();
    const code = await proc.wait();

    expect(code).toBe(0);
    expect(out).toBe('hello|world');
  });

  test('execWithEnv preserves values with shell metacharacters', async () => {
    // Single quotes, dollar signs, backticks, pipes, ampersands, redirects,
    // double quotes, and a backslash — anything an unsafe impl might mangle.
    const value = `it's $HOME \`id\`; | & < > " \\`;
    const proc = await sshKaos.execWithEnv(['sh', '-c', 'printf "%s" "${KAOS_TEST_VALUE}"'], {
      KAOS_TEST_VALUE: value,
    });
    const out = (await streamToBuffer(proc.stdout)).toString();
    const code = await proc.wait();

    expect(code).toBe(0);
    expect(out).toBe(value);
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

  // glob() is an async generator, so the caseSensitive=false guard fires on
  // the first pull rather than at call-time. We verify both the error class
  // (KaosValueError) and the fact that it rejects before touching SFTP.
  it('glob(caseSensitive: false) rejects with KaosValueError', async () => {
    const instance = Object.create(SSHKaos.prototype) as SSHKaos;
    const internal = instance as unknown as { _cwd: string; _sftp: unknown };
    internal._cwd = '/tmp';
    internal._sftp = {};

    const gen = instance.glob('/some/path', '*', { caseSensitive: false });
    await expect(gen.next()).rejects.toBeInstanceOf(KaosValueError);
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

// These tests pin the SFTPError → KaosError mapping contract. They use a
// fake SFTPWrapper that invokes callbacks with errors carrying the standard
// SFTP status codes (NO_SUCH_FILE=2, PERMISSION_DENIED=3), so they run in
// CI without needing a live SSH connection.
//
// The mapping lives in the promisified SFTP helpers in ssh.ts, so every
// SSHKaos method that touches SFTP automatically throws a KaosSSHError
// subclass (KaosFileNotFoundError / KaosPermissionError / …) instead of
// the raw ssh2 error.
describe('SSHKaos SFTP error mapping', () => {
  const NO_SUCH_FILE = 2;
  const PERMISSION_DENIED = 3;

  interface FailingMethods {
    stat?: boolean;
    lstat?: boolean;
    readFile?: boolean;
    writeFile?: boolean;
    appendFile?: boolean;
    mkdir?: boolean;
    readdir?: boolean;
  }

  function makeSftpError(errorCode: number): Error {
    const err = new Error('simulated SFTP error');
    (err as unknown as { code: number }).code = errorCode;
    return err;
  }

  // Minimal SFTPWrapper stub. For each I/O method, when `failing[method]` is
  // true the callback is invoked with an error carrying `code`; otherwise
  // a harmless default is returned. Only the methods that SSHKaos actually
  // calls need to be stubbed.
  function makeFakeSftp(errorCode: number, failing: FailingMethods): unknown {
    const dirStats = {
      mode: 0o040755,
      size: 0,
      uid: 0,
      gid: 0,
      atime: 0,
      mtime: 0,
      isDirectory: (): boolean => true,
      isFile: (): boolean => false,
      isSymbolicLink: (): boolean => false,
      isSocket: (): boolean => false,
      isCharacterDevice: (): boolean => false,
      isBlockDevice: (): boolean => false,
      isFIFO: (): boolean => false,
    };

    return {
      realpath(path: string, cb: (err: Error | null, abs: string) => void): void {
        cb(null, path);
      },
      stat(_path: string, cb: (err: Error | null, stats?: unknown) => void): void {
        if (failing.stat === true) {
          cb(makeSftpError(errorCode));
          return;
        }
        cb(null, dirStats);
      },
      lstat(_path: string, cb: (err: Error | null, stats?: unknown) => void): void {
        if (failing.lstat === true) {
          cb(makeSftpError(errorCode));
          return;
        }
        cb(null, dirStats);
      },
      readFile(_path: string, cb: (err: Error | null, data?: Buffer) => void): void {
        if (failing.readFile === true) {
          cb(makeSftpError(errorCode));
          return;
        }
        cb(null, Buffer.alloc(0));
      },
      writeFile(_path: string, _data: unknown, cb: (err: Error | null) => void): void {
        if (failing.writeFile === true) {
          cb(makeSftpError(errorCode));
          return;
        }
        cb(null);
      },
      appendFile(_path: string, _data: unknown, cb: (err: Error | null) => void): void {
        if (failing.appendFile === true) {
          cb(makeSftpError(errorCode));
          return;
        }
        cb(null);
      },
      mkdir(_path: string, cb: (err: Error | null) => void): void {
        if (failing.mkdir === true) {
          cb(makeSftpError(errorCode));
          return;
        }
        cb(null);
      },
      readdir(_path: string, cb: (err: Error | null, list?: unknown[]) => void): void {
        if (failing.readdir === true) {
          cb(makeSftpError(errorCode));
          return;
        }
        cb(null, []);
      },
      // exists() always reports the file is absent so plain mkdir takes the
      // create path (where `failing.mkdir` decides the outcome).
      exists(_path: string, cb: (exists: boolean) => void): void {
        cb(false);
      },
    };
  }

  function makeFakeKaos(sftp: unknown): SSHKaos {
    const instance = Object.create(SSHKaos.prototype) as SSHKaos;
    const internal = instance as unknown as { _sftp: unknown; _cwd: string; _home: string };
    internal._sftp = sftp;
    internal._cwd = '/';
    internal._home = '/';
    return instance;
  }

  // ── stat(): the one method that already wraps errors. ────────────────

  it('stat() maps NO_SUCH_FILE → KaosFileNotFoundError', async () => {
    const kaos = makeFakeKaos(makeFakeSftp(NO_SUCH_FILE, { stat: true }));
    await expect(kaos.stat('/missing')).rejects.toBeInstanceOf(KaosFileNotFoundError);
  });

  it('stat() maps PERMISSION_DENIED → KaosPermissionError', async () => {
    const kaos = makeFakeKaos(makeFakeSftp(PERMISSION_DENIED, { stat: true }));
    await expect(kaos.stat('/forbidden')).rejects.toBeInstanceOf(KaosPermissionError);
  });

  it('stat({ followSymlinks: false }) wraps lstat errors the same way', async () => {
    const kaos = makeFakeKaos(makeFakeSftp(NO_SUCH_FILE, { lstat: true }));
    await expect(kaos.stat('/missing', { followSymlinks: false })).rejects.toBeInstanceOf(
      KaosFileNotFoundError,
    );
  });

  it('stat() wraps unmapped failures as the base KaosSSHError', async () => {
    // FAILURE=4 is not specifically mapped → generic KaosSSHError.
    const kaos = makeFakeKaos(makeFakeSftp(4, { stat: true }));
    await expect(kaos.stat('/x')).rejects.toBeInstanceOf(KaosSSHError);
  });

  it('stat() maps NO_CONNECTION → KaosConnectionError', async () => {
    // SFTP STATUS_CODE.NO_CONNECTION = 6
    const kaos = makeFakeKaos(makeFakeSftp(6, { stat: true }));
    await expect(kaos.stat('/x')).rejects.toBeInstanceOf(KaosConnectionError);
  });

  it('stat() maps CONNECTION_LOST → KaosConnectionError', async () => {
    // SFTP STATUS_CODE.CONNECTION_LOST = 7
    const kaos = makeFakeKaos(makeFakeSftp(7, { stat: true }));
    await expect(kaos.stat('/x')).rejects.toBeInstanceOf(KaosConnectionError);
  });

  it('stat() wraps errors without a numeric code as generic KaosSSHError', async () => {
    // An error object whose `.code` is not a number (or absent entirely)
    // must still be wrapped — the mapSftpError fallback should kick in.
    const sftp = {
      realpath(p: string, cb: (err: Error | null, abs: string) => void): void {
        cb(null, p);
      },
      stat(_p: string, cb: (err: Error | null) => void): void {
        // Error with no .code field
        cb(new Error('no code here'));
      },
    };
    const kaos = makeFakeKaos(sftp);
    const err = await kaos.stat('/x').catch((error: unknown) => error);
    expect(err).toBeInstanceOf(KaosSSHError);
    expect((err as KaosSSHError).message).toContain('no code here');
  });

  it('stat() wraps non-Error rejections by stringifying them', async () => {
    // The helper's getErrorMessage fallback handles non-Error values by
    // calling String(error). Reject with a plain string and verify the
    // wrap still produces a KaosSSHError with the string in the message.
    const sftp = {
      realpath(p: string, cb: (err: Error | null, abs: string) => void): void {
        cb(null, p);
      },
      stat(_p: string, cb: (err: unknown) => void): void {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        cb('raw-string-rejection');
      },
    };
    const kaos = makeFakeKaos(sftp);
    const err = await kaos.stat('/x').catch((error: unknown) => error);
    expect(err).toBeInstanceOf(KaosSSHError);
    expect((err as KaosSSHError).message).toContain('raw-string-rejection');
  });

  it('chdir() propagates a realpath failure as a KaosSSHError', async () => {
    // sftpRealpath now runs through mapSftpError too — pin that contract.
    const sftp = {
      realpath(_p: string, cb: (err: Error) => void): void {
        const err = new Error('realpath broke');
        (err as unknown as { code: number }).code = 2;
        cb(err);
      },
      stat(_p: string, _cb: unknown): void {
        throw new Error('should not be called');
      },
    };
    const instance = Object.create(SSHKaos.prototype) as SSHKaos;
    const internal = instance as unknown as { _sftp: unknown; _cwd: string };
    internal._sftp = sftp;
    internal._cwd = '/';
    await expect(instance.chdir('/missing')).rejects.toBeInstanceOf(KaosFileNotFoundError);
  });

  // ── Other I/O methods: mapping is pushed into the promisified helpers
  // in ssh.ts so every method gets the same wrapping for free. ─────────

  it('readText() maps NO_SUCH_FILE → KaosFileNotFoundError', async () => {
    const kaos = makeFakeKaos(makeFakeSftp(NO_SUCH_FILE, { readFile: true }));
    await expect(kaos.readText('/missing')).rejects.toBeInstanceOf(KaosFileNotFoundError);
  });

  it('readBytes() maps NO_SUCH_FILE → KaosFileNotFoundError', async () => {
    const kaos = makeFakeKaos(makeFakeSftp(NO_SUCH_FILE, { readFile: true }));
    await expect(kaos.readBytes('/missing')).rejects.toBeInstanceOf(KaosFileNotFoundError);
  });

  it('writeText() maps PERMISSION_DENIED → KaosPermissionError', async () => {
    const kaos = makeFakeKaos(makeFakeSftp(PERMISSION_DENIED, { writeFile: true }));
    await expect(kaos.writeText('/forbidden', 'data')).rejects.toBeInstanceOf(KaosPermissionError);
  });

  it('writeText(append) maps PERMISSION_DENIED → KaosPermissionError', async () => {
    const kaos = makeFakeKaos(makeFakeSftp(PERMISSION_DENIED, { appendFile: true }));
    await expect(kaos.writeText('/forbidden', 'data', { mode: 'a' })).rejects.toBeInstanceOf(
      KaosPermissionError,
    );
  });

  it('writeBytes() maps PERMISSION_DENIED → KaosPermissionError', async () => {
    const kaos = makeFakeKaos(makeFakeSftp(PERMISSION_DENIED, { writeFile: true }));
    await expect(kaos.writeBytes('/forbidden', Buffer.from('x'))).rejects.toBeInstanceOf(
      KaosPermissionError,
    );
  });

  it('mkdir() maps PERMISSION_DENIED → KaosPermissionError', async () => {
    const kaos = makeFakeKaos(makeFakeSftp(PERMISSION_DENIED, { mkdir: true }));
    await expect(kaos.mkdir('/forbidden')).rejects.toBeInstanceOf(KaosPermissionError);
  });

  it('iterdir() maps NO_SUCH_FILE → KaosFileNotFoundError', async () => {
    const kaos = makeFakeKaos(makeFakeSftp(NO_SUCH_FILE, { readdir: true }));
    const gen = kaos.iterdir('/missing');
    await expect(gen.next()).rejects.toBeInstanceOf(KaosFileNotFoundError);
  });
});

// These tests exercise the pure command-building logic behind execWithEnv
// without needing a live SSH connection. The actual end-to-end delivery of
// env vars is validated by the smoke tests above when KAOS_SSH_SMOKE=1.
describe('SSHKaos._buildExecCommand', () => {
  // Bracket access so we can reach the private static helper from tests
  // without changing its visibility in the public API.
  const build = (
    SSHKaos as unknown as {
      _buildExecCommand: (args: string[], cwd: string, env?: Record<string, string>) => string;
    }
  )._buildExecCommand;

  it('cd prefix + bare command when no env is supplied', () => {
    expect(build(['ls', '-la'], '/home/user')).toBe('cd /home/user && ls -la');
  });

  it('injects inline assignments before the command', () => {
    expect(build(['echo', 'x'], '/home/user', { FOO: 'bar' })).toBe(
      'cd /home/user && FOO=bar echo x',
    );
  });

  it('injects multiple env vars in declaration order', () => {
    const out = build(['sh', '-c', 'echo $A $B'], '/home/user', { A: '1', B: '2' });
    expect(out).toBe("cd /home/user && A=1 B=2 sh -c 'echo $A $B'");
  });

  it('quotes values containing shell metacharacters', () => {
    // Single quote in value → shellQuote escapes via the '"'"' trick.
    expect(build(['cmd'], '/home/user', { V: "it's" })).toBe(`cd /home/user && V='it'"'"'s' cmd`);
    // Dollar sign, backticks, pipe, ampersand → single-quoted wholesale.
    expect(build(['cmd'], '/home/user', { V: '$HOME `id` | &' })).toBe(
      `cd /home/user && V='$HOME \`id\` | &' cmd`,
    );
  });

  it('quotes an empty value as empty single quotes', () => {
    expect(build(['cmd'], '/home/user', { V: '' })).toBe("cd /home/user && V='' cmd");
  });

  it('rejects env var names that are not valid POSIX identifiers', () => {
    expect(() => build(['cmd'], '/home/user', { '1BAD': 'x' })).toThrow(KaosValueError);
    expect(() => build(['cmd'], '/home/user', { 'WITH SPACE': 'x' })).toThrow(KaosValueError);
    expect(() => build(['cmd'], '/home/user', { 'WITH=EQUALS': 'x' })).toThrow(KaosValueError);
    expect(() => build(['cmd'], '/home/user', { '': 'x' })).toThrow(KaosValueError);
  });

  it('accepts underscored and mixed-case identifiers', () => {
    expect(build(['cmd'], '/home/user', { _UNDER: '1', camelCase: '2' })).toBe(
      'cd /home/user && _UNDER=1 camelCase=2 cmd',
    );
  });

  it('skips the cd prefix when cwd is the empty string', () => {
    expect(build(['cmd', 'arg'], '', { FOO: 'bar' })).toBe('FOO=bar cmd arg');
  });

  it('quotes cwd paths with spaces and special characters', () => {
    expect(build(['cmd'], "/home/u ser's dir")).toBe(`cd '/home/u ser'"'"'s dir' && cmd`);
  });

  it('omits the assignment section entirely when env is an empty object', () => {
    // Matches the behavior of plain exec() — no leading space, no KEY=...
    expect(build(['cmd', 'arg'], '/home/user', {})).toBe('cd /home/user && cmd arg');
  });
});

// These tests drive the SSHKaos read/stat/glob/iterdir happy paths via
// fake SFTP wrappers, so they run in CI without a live SSH server. Without
// them the smoke block is the only route to those code paths, which means
// CI only sees the error branches.
describe('SSHKaos mock success paths', () => {
  interface TreeNode {
    type: 'dir' | 'file';
    children?: Record<string, TreeNode>;
    content?: Buffer;
    // Permission bits only — forces buildStMode to derive the type bits
    // from the is* helpers (the "mode without type bits" branch) when true.
    stripTypeBits?: boolean;
  }

  function makeStats(node: TreeNode): unknown {
    const isDir = node.type === 'dir';
    // Either include type bits (0o040000/0o100000) or strip them to force
    // the buildStMode helper to derive them via isDirectory()/isFile().
    const baseMode = isDir ? 0o040755 : 0o100644;
    const mode = node.stripTypeBits === true ? baseMode & 0o7777 : baseMode;
    return {
      mode,
      size: node.content ? node.content.length : 0,
      uid: 1000,
      gid: 1000,
      atime: 100,
      mtime: 200,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isSymbolicLink: () => false,
      isSocket: () => false,
      isCharacterDevice: () => false,
      isBlockDevice: () => false,
      isFIFO: () => false,
    };
  }

  function lookup(root: TreeNode, path: string): TreeNode | undefined {
    if (path === '/') return root;
    const parts = path.split('/').filter(Boolean);
    let current: TreeNode | undefined = root;
    for (const part of parts) {
      if (!current?.children?.[part]) return undefined;
      current = current.children[part];
    }
    return current;
  }

  // Fake SFTP that exposes a tree and implements the handful of callbacks
  // SSHKaos actually calls. Anything not needed is left unimplemented.
  function makeTreeSftp(root: TreeNode): unknown {
    return {
      realpath(path: string, cb: (err: Error | null, abs: string) => void): void {
        cb(null, path);
      },
      stat(path: string, cb: (err: Error | null, stats?: unknown) => void): void {
        const node = lookup(root, path);
        if (!node) {
          const err = new Error(`no such file: ${path}`);
          (err as unknown as { code: number }).code = 2;
          cb(err);
          return;
        }
        cb(null, makeStats(node));
      },
      lstat(path: string, cb: (err: Error | null, stats?: unknown) => void): void {
        const node = lookup(root, path);
        if (!node) {
          const err = new Error(`no such file: ${path}`);
          (err as unknown as { code: number }).code = 2;
          cb(err);
          return;
        }
        cb(null, makeStats(node));
      },
      readdir(path: string, cb: (err: Error | null, list?: unknown[]) => void): void {
        const node = lookup(root, path);
        if (!node || node.type !== 'dir' || !node.children) {
          const err = new Error(`not a directory: ${path}`);
          (err as unknown as { code: number }).code = 2;
          cb(err);
          return;
        }
        cb(
          null,
          Object.entries(node.children).map(([filename, child]) => ({
            filename,
            attrs: makeStats(child),
          })),
        );
      },
      readFile(path: string, cb: (err: Error | null, data?: Buffer) => void): void {
        const node = lookup(root, path);
        if (!node || node.type !== 'file') {
          const err = new Error(`no such file: ${path}`);
          (err as unknown as { code: number }).code = 2;
          cb(err);
          return;
        }
        cb(null, node.content ?? Buffer.alloc(0));
      },
    };
  }

  function makeFakeKaos(sftp: unknown, cwd = '/'): SSHKaos {
    const instance = Object.create(SSHKaos.prototype) as SSHKaos;
    const internal = instance as unknown as { _sftp: unknown; _cwd: string; _home: string };
    internal._sftp = sftp;
    internal._cwd = cwd;
    internal._home = '/home/tester';
    return instance;
  }

  // ── path helpers ────────────────────────────────────────────────────

  it('normpath delegates to posix.normalize', () => {
    // No I/O — just the pure path function. Pins that normpath collapses
    // `..` segments.
    const kaos = makeFakeKaos(makeTreeSftp({ type: 'dir', children: {} }));
    expect(kaos.normpath('/a/b/../c')).toBe('/a/c');
  });

  // ── stat + buildStMode variants ─────────────────────────────────────

  it('stat() returns a StatResult with file-type bits preserved', async () => {
    const root: TreeNode = {
      type: 'dir',
      children: {
        'file.txt': { type: 'file', content: Buffer.from('hi') },
      },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root));

    const fileStat: StatResult = await kaos.stat('/file.txt');
    expect((fileStat.stMode & 0o170000) === 0o100000).toBe(true);
    expect(fileStat.stSize).toBe(2);
    expect(fileStat.stUid).toBe(1000);
  });

  it('stat() derives type bits from is* helpers when mode lacks them', async () => {
    // mode = 0o755 has zero in the S_IFMT bits, so buildStMode must fall
    // back to isDirectory()/isFile() to fill them in.
    const root: TreeNode = {
      type: 'dir',
      stripTypeBits: true,
      children: {
        'bare.txt': { type: 'file', stripTypeBits: true, content: Buffer.from('x') },
      },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root));

    const dirStat = await kaos.stat('/');
    expect((dirStat.stMode & 0o170000) === 0o040000).toBe(true);

    const fileStat = await kaos.stat('/bare.txt');
    expect((fileStat.stMode & 0o170000) === 0o100000).toBe(true);
  });

  it('stat({ followSymlinks: false }) uses the lstat branch', async () => {
    // No actual symlinks — just verify the alternate code path is taken
    // (lstat callback is wired up, it returns stats without throwing).
    const root: TreeNode = {
      type: 'dir',
      children: { 'a.txt': { type: 'file', content: Buffer.from('hi') } },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root));
    const result = await kaos.stat('/a.txt', { followSymlinks: false });
    expect(result.stSize).toBe(2);
  });

  // ── iterdir ────────────────────────────────────────────────────────

  it('iterdir yields directory entries and filters . / ..', async () => {
    // readdir() in the fake returns only real children, but the SSHKaos
    // iterdir loop filters . and .. regardless — pin the filter logic
    // still produces the expected child set. We use a non-root base
    // (`/tree`) to dodge the known `basePath + "/" + entry` double-slash
    // bug at filesystem roots — reported in 02-coverage-gaps.md.
    const root: TreeNode = {
      type: 'dir',
      children: {
        tree: {
          type: 'dir',
          children: {
            'a.txt': { type: 'file', content: Buffer.from('a') },
            'b.txt': { type: 'file', content: Buffer.from('b') },
            sub: { type: 'dir', children: {} },
          },
        },
      },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root));

    const entries: string[] = [];
    for await (const entry of kaos.iterdir('/tree')) {
      entries.push(entry);
    }
    expect(new Set(entries)).toEqual(new Set(['/tree/a.txt', '/tree/b.txt', '/tree/sub']));
  });

  // ── glob ────────────────────────────────────────────────────────────

  // All glob tests use `/tree` (not `/`) as the base to dodge the known
  // root-path double-slash bug — see 02-coverage-gaps.md.

  it('glob matches flat patterns against the directory', async () => {
    const root: TreeNode = {
      type: 'dir',
      children: {
        tree: {
          type: 'dir',
          children: {
            'root.txt': { type: 'file', content: Buffer.from('r') },
            'root.log': { type: 'file', content: Buffer.from('l') },
          },
        },
      },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root));

    const matches: string[] = [];
    for await (const m of kaos.glob('/tree', '*.txt')) {
      matches.push(m);
    }
    expect(matches).toEqual(['/tree/root.txt']);
  });

  it('glob recurses with **/pattern to match nested files', async () => {
    const root: TreeNode = {
      type: 'dir',
      children: {
        tree: {
          type: 'dir',
          children: {
            'root.txt': { type: 'file', content: Buffer.from('r') },
            sub: {
              type: 'dir',
              children: {
                'nested.txt': { type: 'file', content: Buffer.from('n') },
                deep: {
                  type: 'dir',
                  children: {
                    'deeper.txt': { type: 'file', content: Buffer.from('d') },
                  },
                },
              },
            },
          },
        },
      },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root));

    const matches: string[] = [];
    for await (const m of kaos.glob('/tree', '**/*.txt')) {
      matches.push(m);
    }
    const names = new Set(matches);
    expect(names).toEqual(
      new Set(['/tree/root.txt', '/tree/sub/nested.txt', '/tree/sub/deep/deeper.txt']),
    );
    // Pin the de-dup invariant — no single file should appear twice.
    expect(matches.length).toBe(new Set(matches).size);
  });

  it('glob with bare ** yields basePath and every nested entry', async () => {
    const root: TreeNode = {
      type: 'dir',
      children: {
        tree: {
          type: 'dir',
          children: {
            'root.txt': { type: 'file', content: Buffer.from('r') },
            sub: {
              type: 'dir',
              children: {
                'nested.txt': { type: 'file', content: Buffer.from('n') },
              },
            },
          },
        },
      },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root));

    const matches: string[] = [];
    for await (const m of kaos.glob('/tree', '**')) {
      matches.push(m);
    }
    const set = new Set(matches);
    expect(set.has('/tree')).toBe(true);
    expect(set.has('/tree/root.txt')).toBe(true);
    expect(set.has('/tree/sub')).toBe(true);
    expect(set.has('/tree/sub/nested.txt')).toBe(true);
  });

  it('glob with a nested literal path recurses only into the named dir', async () => {
    // Pattern `sub/*.txt` → literal `sub` segment, then `*.txt` inside it.
    // Exercises the non-`**` recursive branch.
    const root: TreeNode = {
      type: 'dir',
      children: {
        tree: {
          type: 'dir',
          children: {
            'root.txt': { type: 'file', content: Buffer.from('r') },
            sub: {
              type: 'dir',
              children: {
                'a.txt': { type: 'file', content: Buffer.from('a') },
                'b.log': { type: 'file', content: Buffer.from('b') },
              },
            },
          },
        },
      },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root));

    const matches: string[] = [];
    for await (const m of kaos.glob('/tree', 'sub/*.txt')) {
      matches.push(m);
    }
    expect(matches).toEqual(['/tree/sub/a.txt']);
  });

  it('glob silently skips unreadable directories', async () => {
    // If readdir() fails the generator should return without throwing —
    // makes glob tolerant of permission-limited subtrees.
    const sftp = {
      realpath(p: string, cb: (err: Error | null, abs: string) => void): void {
        cb(null, p);
      },
      readdir(_p: string, cb: (err: Error | null, list?: unknown[]) => void): void {
        const err = new Error('permission denied');
        (err as unknown as { code: number }).code = 3;
        cb(err);
      },
    };
    const kaos = makeFakeKaos(sftp);

    const matches: string[] = [];
    for await (const m of kaos.glob('/locked', '*.txt')) {
      matches.push(m);
    }
    expect(matches).toEqual([]);
  });

  // ── readLines empty-file early return ─────────────────────────────

  it('readLines yields nothing for an empty file', async () => {
    // `readText` returns an empty string, so the generator must take the
    // early-return branch instead of walking `splitlines()`.
    const root: TreeNode = {
      type: 'dir',
      children: { 'empty.txt': { type: 'file', content: Buffer.alloc(0) } },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root));

    const lines: string[] = [];
    for await (const line of kaos.readLines('/empty.txt')) {
      lines.push(line);
    }
    expect(lines).toEqual([]);
  });

  // ── . / .. filter coverage ────────────────────────────────────────

  it('iterdir at root "/" does not produce double-slash paths', async () => {
    // Regression: `basePath + '/' + entry.filename` produced `//foo` when
    // basePath was the filesystem root. Now uses `posix.join` to collapse.
    const root: TreeNode = {
      type: 'dir',
      children: {
        'a.txt': { type: 'file', content: Buffer.from('a') },
        sub: { type: 'dir', children: {} },
      },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root), '/');

    const entries: string[] = [];
    for await (const entry of kaos.iterdir('/')) {
      entries.push(entry);
    }
    expect(new Set(entries)).toEqual(new Set(['/a.txt', '/sub']));
    expect(entries.every((e) => !e.includes('//'))).toBe(true);
  });

  it('glob at root "/" does not produce double-slash paths', async () => {
    const root: TreeNode = {
      type: 'dir',
      children: {
        'file.txt': { type: 'file', content: Buffer.from('x') },
      },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root), '/');

    const matches: string[] = [];
    for await (const m of kaos.glob('/', '*.txt')) {
      matches.push(m);
    }
    expect(matches).toEqual(['/file.txt']);
    expect(matches.every((p) => !p.includes('//'))).toBe(true);
  });

  it('iterdir filters out "." and ".." entries from readdir output', async () => {
    // Some SFTP servers include `.` / `..` in readdir results, so the
    // filter in SSHKaos.iterdir must skip them unconditionally. Inject
    // those entries into the fake to exercise the filter branch.
    const sftp = {
      realpath(p: string, cb: (err: Error | null, abs: string) => void): void {
        cb(null, p);
      },
      readdir(_p: string, cb: (err: Error | null, list?: unknown[]) => void): void {
        cb(null, [
          { filename: '.', attrs: { isDirectory: (): boolean => true } },
          { filename: '..', attrs: { isDirectory: (): boolean => true } },
          { filename: 'real.txt', attrs: { isDirectory: (): boolean => false } },
        ]);
      },
    };
    const kaos = makeFakeKaos(sftp, '/tree');

    const entries: string[] = [];
    for await (const e of kaos.iterdir('/tree')) {
      entries.push(e);
    }
    // Only the real entry survives — the `.` / `..` are silently dropped.
    expect(entries).toEqual(['/tree/real.txt']);
  });

  it('glob filters "." and ".." entries in both the ** and literal branches', async () => {
    // Same fake readdir in two walks: one with `**` (covers the `**`
    // branch filter) and one with a literal pattern (covers the non-`**`
    // branch filter).
    const sftp = {
      realpath(p: string, cb: (err: Error | null, abs: string) => void): void {
        cb(null, p);
      },
      readdir(_p: string, cb: (err: Error | null, list?: unknown[]) => void): void {
        cb(null, [
          {
            filename: '.',
            attrs: {
              isDirectory: (): boolean => true,
              isFile: (): boolean => false,
            },
          },
          {
            filename: '..',
            attrs: {
              isDirectory: (): boolean => true,
              isFile: (): boolean => false,
            },
          },
          {
            filename: 'keeper.txt',
            attrs: {
              isDirectory: (): boolean => false,
              isFile: (): boolean => true,
            },
          },
        ]);
      },
    };
    const kaos = makeFakeKaos(sftp, '/tree');

    const viaStar: string[] = [];
    for await (const m of kaos.glob('/tree', '*.txt')) viaStar.push(m);
    expect(viaStar).toEqual(['/tree/keeper.txt']);

    const viaStarStar: string[] = [];
    for await (const m of kaos.glob('/tree', '**')) viaStarStar.push(m);
    // The recursion into `.` / `..` must be skipped — we should see only
    // the base dir and the keeper file, never an infinite loop.
    expect(new Set(viaStarStar)).toEqual(new Set(['/tree', '/tree/keeper.txt']));
  });

  // ── glob error handling in the ** branch ──────────────────────────

  it('glob ** silently aborts when readdir fails', async () => {
    // Similar to the non-`**` readdir-error test, but forcing the code
    // through the `**` case's own try/catch. Passing a bare `**` pattern
    // takes the `currentPattern === '**'` branch, and the failing
    // readdir exercises the swallow-and-return path inside it.
    const sftp = {
      realpath(p: string, cb: (err: Error | null, abs: string) => void): void {
        cb(null, p);
      },
      readdir(_p: string, cb: (err: Error | null, list?: unknown[]) => void): void {
        const err = new Error('denied');
        (err as unknown as { code: number }).code = 3;
        cb(err);
      },
    };
    const kaos = makeFakeKaos(sftp, '/tree');

    const matches: string[] = [];
    for await (const m of kaos.glob('/tree', '**')) {
      matches.push(m);
    }
    // Pattern `**` with zero-directory match yields basePath itself
    // BEFORE the readdir even runs, so we still see `/tree`. The
    // important bit is that no exception propagates out.
    expect(matches).toEqual(['/tree']);
  });

  // ── readBytes ──────────────────────────────────────────────────────

  it('readBytes(n) returns only the first n bytes of the file', async () => {
    const content = Buffer.from('0123456789');
    const root: TreeNode = {
      type: 'dir',
      children: { 'data.bin': { type: 'file', content } },
    };
    const kaos = makeFakeKaos(makeTreeSftp(root));

    const full = await kaos.readBytes('/data.bin');
    expect(Buffer.compare(full, content)).toBe(0);

    const first4 = await kaos.readBytes('/data.bin', 4);
    expect(first4.toString()).toBe('0123');
  });

  // ── execWithEnv body ───────────────────────────────────────────────

  it('execWithEnv calls clientExec with the env-prefixed command', async () => {
    // We only exercise the _execInternal path via execWithEnv here — the
    // command-building detail is already covered by the _buildExecCommand
    // describe block. This test just pins that execWithEnv() with a valid
    // non-empty args array routes through the internal helper.
    const commands: string[] = [];
    const fakeClient = {
      exec(cmd: string, _a: unknown, _b?: unknown): void {
        commands.push(cmd);
        // Mimic a channel that never emits — we just want to observe the
        // command string, not wait for real I/O.
        throw new Error('stop');
      },
    };
    const instance = Object.create(SSHKaos.prototype) as SSHKaos;
    const internal = instance as unknown as { _client: unknown; _cwd: string; _home: string };
    internal._client = fakeClient;
    internal._cwd = '/home/tester';
    internal._home = '/home/tester';

    await expect(instance.execWithEnv(['echo', 'hi'], { FOO: 'bar' })).rejects.toThrow('stop');

    expect(commands).toHaveLength(1);
    expect(commands[0]).toBe('cd /home/tester && FOO=bar echo hi');
  });
});

// These tests pin the non-race mkdir error branches in SSHKaos — the
// "path already exists but is a file" and "parents=true with a final
// directory already present under existOk=false" cases. All driven via
// fake SFTP wrappers so no live server is required.
describe('SSHKaos mkdir existOk edge cases', () => {
  function makeFakeKaos(sftp: unknown): SSHKaos {
    const instance = Object.create(SSHKaos.prototype) as SSHKaos;
    const internal = instance as unknown as { _sftp: unknown; _cwd: string };
    internal._sftp = sftp;
    internal._cwd = '/';
    return instance;
  }

  function makeFileStats(): unknown {
    return {
      mode: 0o100644,
      size: 0,
      uid: 0,
      gid: 0,
      atime: 0,
      mtime: 0,
      isDirectory: (): boolean => false,
      isFile: (): boolean => true,
      isSymbolicLink: (): boolean => false,
      isSocket: (): boolean => false,
      isCharacterDevice: (): boolean => false,
      isBlockDevice: (): boolean => false,
      isFIFO: (): boolean => false,
    };
  }

  function makeDirStats(): unknown {
    return {
      mode: 0o040755,
      size: 0,
      uid: 0,
      gid: 0,
      atime: 0,
      mtime: 0,
      isDirectory: (): boolean => true,
      isFile: (): boolean => false,
      isSymbolicLink: (): boolean => false,
      isSocket: (): boolean => false,
      isCharacterDevice: (): boolean => false,
      isBlockDevice: (): boolean => false,
      isFIFO: (): boolean => false,
    };
  }

  it('mkdir (non-parents) rejects when existOk=true but path is a file', async () => {
    // simple mkdir branch: exists=true + existOk=true + not a directory
    // must throw instead of silently accepting the file collision.
    const sftp = {
      realpath(p: string, cb: (err: Error | null, abs: string) => void): void {
        cb(null, p);
      },
      exists(_p: string, cb: (exists: boolean) => void): void {
        cb(true);
      },
      stat(_p: string, cb: (err: Error | null, stats: unknown) => void): void {
        cb(null, makeFileStats());
      },
    };
    const kaos = makeFakeKaos(sftp);
    await expect(kaos.mkdir('/existing-file', { existOk: true })).rejects.toBeInstanceOf(
      KaosFileExistsError,
    );
  });

  it('mkdir(parents=true) rejects when the final path exists and existOk=false', async () => {
    // Recursive branch: walks to the final component, finds it already
    // exists (as a directory, even), and since existOk=false the call
    // must surface a KaosFileExistsError instead of silently succeeding.
    const sftp = {
      realpath(p: string, cb: (err: Error | null, abs: string) => void): void {
        cb(null, p);
      },
      exists(_p: string, cb: (exists: boolean) => void): void {
        cb(true);
      },
      stat(_p: string, cb: (err: Error | null, stats: unknown) => void): void {
        cb(null, makeDirStats());
      },
    };
    const kaos = makeFakeKaos(sftp);
    await expect(kaos.mkdir('/a/b/c', { parents: true, existOk: false })).rejects.toBeInstanceOf(
      KaosFileExistsError,
    );
  });

  it('mkdir(parents=true) rejects when an intermediate path is a regular file', async () => {
    // Recursive branch: during the walk, an intermediate component
    // already exists but is a regular file (not a directory). That must
    // be a hard failure regardless of existOk, because the next sftpMkdir
    // would otherwise fail with a confusing ENOTDIR.
    const sftp = {
      realpath(p: string, cb: (err: Error | null, abs: string) => void): void {
        cb(null, p);
      },
      exists(_p: string, cb: (exists: boolean) => void): void {
        cb(true);
      },
      stat(_p: string, cb: (err: Error | null, stats: unknown) => void): void {
        cb(null, makeFileStats());
      },
    };
    const kaos = makeFakeKaos(sftp);
    await expect(kaos.mkdir('/a/b/c', { parents: true, existOk: true })).rejects.toBeInstanceOf(
      KaosFileExistsError,
    );
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
