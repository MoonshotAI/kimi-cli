import { EventEmitter } from 'node:events';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';

import { resetCurrentKaos, setCurrentKaos } from '../src/current.js';
import type { KaosToken } from '../src/current.js';
import { KaosValueError } from '../src/errors.js';
import { KaosPath } from '../src/path.js';
import {
  KaosFileNotFoundError,
  KaosPermissionError,
  KaosSSHError,
  SSHKaos,
} from '../src/ssh.js';

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

  // NOTE: these execWithEnv tests require the remote sshd to accept the
  // injected variable names via its `AcceptEnv` directive (or an equivalent
  // mechanism). Stock OpenSSH only whitelists LANG/LC_*; if the test server
  // is not configured to accept KAOS_TEST_*, these tests will fail — which
  // is exactly the signal we want (it reveals the silent env-drop bug that
  // the Python version has).
  test('execWithEnv delivers a single env var to the remote process', async () => {
    const proc = await sshKaos.execWithEnv(
      ['sh', '-c', 'printf "%s" "${KAOS_TEST_MARKER}"'],
      { KAOS_TEST_MARKER: 'beacon42' },
    );
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
    const proc = await sshKaos.execWithEnv(
      ['sh', '-c', 'printf "%s" "${KAOS_TEST_VALUE}"'],
      { KAOS_TEST_VALUE: value },
    );
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
    await expect(
      kaos.stat('/missing', { followSymlinks: false }),
    ).rejects.toBeInstanceOf(KaosFileNotFoundError);
  });

  it('stat() wraps unmapped failures as the base KaosSSHError', async () => {
    // FAILURE=4 is not specifically mapped → generic KaosSSHError.
    const kaos = makeFakeKaos(makeFakeSftp(4, { stat: true }));
    await expect(kaos.stat('/x'))
      .rejects.toBeInstanceOf(KaosSSHError);
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
      _buildExecCommand: (
        args: string[],
        cwd: string,
        env?: Record<string, string>,
      ) => string;
    }
  )._buildExecCommand;

  it('cd prefix + bare command when no env is supplied', () => {
    expect(build(['ls', '-la'], '/home/user')).toBe("cd /home/user && ls -la");
  });

  it('injects inline assignments before the command', () => {
    expect(build(['echo', 'x'], '/home/user', { FOO: 'bar' })).toBe(
      "cd /home/user && FOO=bar echo x",
    );
  });

  it('injects multiple env vars in declaration order', () => {
    const out = build(['sh', '-c', 'echo $A $B'], '/home/user', { A: '1', B: '2' });
    expect(out).toBe("cd /home/user && A=1 B=2 sh -c 'echo $A $B'");
  });

  it('quotes values containing shell metacharacters', () => {
    // Single quote in value → shellQuote escapes via the '"'"' trick.
    expect(build(['cmd'], '/home/user', { V: "it's" })).toBe(
      `cd /home/user && V='it'"'"'s' cmd`,
    );
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
