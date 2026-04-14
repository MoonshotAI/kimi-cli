import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import type {
  AnyAuthMethod,
  Client,
  ClientChannel,
  ConnectConfig,
  SFTPWrapper,
  Stats as SFTPStats,
} from 'ssh2';

import { KaosError, KaosFileExistsError, KaosValueError } from './errors.js';
import { BufferedReadable, decodeTextWithErrors, globPatternToRegex } from './internal.js';
import type { Kaos } from './kaos.js';
import type { KaosProcess } from './process.js';
import type { StatResult } from './types.js';

// ── stat mode constants ────────────────────────────────────────────────
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;
const S_IFCHR = 0o020000;
const S_IFBLK = 0o060000;
const S_IFIFO = 0o010000;

const DEFAULT_SFTP_STATUS_CODE = {
  BAD_MESSAGE: 5,
  CONNECTION_LOST: 7,
  FAILURE: 4,
  NO_CONNECTION: 6,
  NO_SUCH_FILE: 2,
  OP_UNSUPPORTED: 8,
  PERMISSION_DENIED: 3,
} as const;

// ── SSH options ────────────────────────────────────────────────────────

/**
 * Advanced ssh2 connect options that may be passed through `SSHKaosOptions.extraOptions`.
 *
 * Excludes fields that SSHKaos manages itself (`host`, `port`, `username`,
 * `password`, `privateKey`, `authHandler`, `hostVerifier`) — those are derived
 * from the top-level `SSHKaosOptions` fields and cannot be overridden here.
 */
export type SSHKaosExtraOptions = Omit<
  ConnectConfig,
  'host' | 'port' | 'username' | 'password' | 'privateKey' | 'authHandler' | 'hostVerifier'
>;

export interface SSHKaosOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  keyPaths?: string[];
  keyContents?: string[];
  cwd?: string;
  /**
   * Pass-through for advanced ssh2 `ConnectConfig` fields such as `algorithms`,
   * `keepaliveInterval`, `readyTimeout`, `debug`, `tryKeyboard`, `agent`, etc.
   *
   * Managed fields (`host`, `port`, `username`, `password`, `privateKey`,
   * `authHandler`, `hostVerifier`) are excluded from this type and will take
   * precedence over anything set here.
   */
  extraOptions?: SSHKaosExtraOptions;
}

// ── SSH error types ───────────────────────────────────────────────────

export class KaosSSHError extends KaosError {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'KaosSSHError';
    this.code = code;
  }
}

export class KaosFileNotFoundError extends KaosSSHError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = 'KaosFileNotFoundError';
  }
}

export class KaosPermissionError extends KaosSSHError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = 'KaosPermissionError';
  }
}

export class KaosConnectionError extends KaosSSHError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = 'KaosConnectionError';
  }
}

// ── shell quoting ──────────────────────────────────────────────────────

/**
 * Shell-escape a single argument (POSIX sh compatible).
 * Mirrors Python's shlex.quote().
 */
function shellQuote(arg: string): string {
  if (arg === '') return "''";
  // If the string is safe (only contains safe chars), return as-is
  if (/^[A-Za-z0-9_./:=@%^,+-]+$/.test(arg)) return arg;
  // Otherwise wrap in single quotes, escaping any embedded single quotes
  return "'" + arg.replaceAll("'", "'\"'\"'") + "'";
}

// ── stat mode builder ──────────────────────────────────────────────────

/**
 * Build a POSIX st_mode from SFTP Stats.
 * ssh2's Stats has .mode which already includes both file-type bits and
 * permission bits, but we also check the boolean helpers as a fallback.
 */
function buildStMode(attrs: SFTPStats): number {
  const raw = attrs.mode;
  // If mode already contains file-type bits, return as-is
  if ((raw & S_IFMT) !== 0) return raw;

  // Derive file-type bits from the is* helpers
  let typeBits = 0;
  if (attrs.isDirectory()) typeBits = S_IFDIR;
  else if (attrs.isFile()) typeBits = S_IFREG;
  else if (attrs.isSymbolicLink()) typeBits = S_IFLNK;
  else if (attrs.isSocket()) typeBits = S_IFSOCK;
  else if (attrs.isCharacterDevice()) typeBits = S_IFCHR;
  else if (attrs.isBlockDevice()) typeBits = S_IFBLK;
  else if (attrs.isFIFO()) typeBits = S_IFIFO;

  return (raw & ~S_IFMT) | typeBits;
}

function loadSsh2(): {
  Client: new () => Client;
  utils?: {
    sftp?: {
      STATUS_CODE?: Partial<typeof DEFAULT_SFTP_STATUS_CODE>;
    };
  };
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('ssh2') as {
    Client: new () => Client;
    utils?: {
      sftp?: {
        STATUS_CODE?: Partial<typeof DEFAULT_SFTP_STATUS_CODE>;
      };
    };
  };
}

function getSftpStatusCode(): typeof DEFAULT_SFTP_STATUS_CODE {
  const ssh2 = loadSsh2();
  return {
    ...DEFAULT_SFTP_STATUS_CODE,
    ...ssh2.utils?.sftp?.STATUS_CODE,
  };
}

function getErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === 'number' ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function mapSftpError(operation: string, error: unknown): KaosSSHError {
  const code = getErrorCode(error);
  const message = `${operation} failed: ${getErrorMessage(error)}`;
  const statusCode = getSftpStatusCode();

  if (code === statusCode.NO_SUCH_FILE) {
    return new KaosFileNotFoundError(message, code);
  }
  if (code === statusCode.PERMISSION_DENIED) {
    return new KaosPermissionError(message, code);
  }
  if (code === statusCode.NO_CONNECTION || code === statusCode.CONNECTION_LOST) {
    return new KaosConnectionError(message, code);
  }
  return new KaosSSHError(message, code);
}

function buildAuthHandler(
  username: string,
  privateKeys: readonly (Buffer | string)[],
  password?: string,
): ConnectConfig['authHandler'] {
  const authQueue: AnyAuthMethod[] = privateKeys.map((key) => ({
    key,
    type: 'publickey',
    username,
  }));
  if (password !== undefined) {
    authQueue.push({
      password,
      type: 'password',
      username,
    });
  }

  let index = 0;
  return (_authsLeft, _partialSuccess, next) => {
    const nextAuth = authQueue[index];
    index += 1;
    const nextWithFalse = next as (auth: AnyAuthMethod | false) => void;
    nextWithFalse(nextAuth ?? false);
  };
}

// ── SSH process ────────────────────────────────────────────────────────

/** Exported for unit tests only. Do not use directly. */
export class SSHProcess implements KaosProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number = -1;

  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;
  private readonly _channel: ClientChannel;

  constructor(channel: ClientChannel) {
    this._channel = channel;
    this.stdin = channel;
    this.stdout = new BufferedReadable(channel as unknown as Readable);
    this.stderr = new BufferedReadable(channel.stderr);

    this._exitPromise = new Promise<number>((resolve) => {
      // Listen to 'close' on the channel, not 'exit', to ensure all
      // buffered output is flushed before we resolve.
      channel.on('close', (code: number | null) => {
        // Some ssh2 backends surface the exit status only on 'close'.
        this._exitCode ??= code ?? 1;
        resolve(this._exitCode);
      });
      channel.on('exit', (code: number | null) => {
        this._exitCode = code ?? 1;
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  async wait(): Promise<number> {
    return this._exitPromise;
  }

  kill(signal?: NodeJS.Signals): Promise<void> {
    // SSH signals must be stripped of the "SIG" prefix (RFC 4254 §6.9):
    // e.g. 'SIGTERM' → 'TERM', 'SIGKILL' → 'KILL', 'SIGINT' → 'INT'.
    // Honor the caller's requested signal so that remote processes can
    // perform graceful shutdown on SIGTERM/SIGINT (Codex P2 fix).
    const rawSignal = signal ?? 'SIGTERM';
    const sshSignal = rawSignal.startsWith('SIG') ? rawSignal.slice(3) : rawSignal;
    this._channel.signal(sshSignal);
    return Promise.resolve();
  }
}

// ── Promisified SSH helpers ────────────────────────────────────────────

function connectClient(config: ConnectConfig): Promise<Client> {
  const ssh2 = loadSsh2();
  const client = new ssh2.Client();
  return new Promise<Client>((resolve, reject) => {
    client.on('ready', () => {
      resolve(client);
    });
    client.on('error', (err: Error) => {
      reject(err);
    });
    client.connect(config);
  });
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(err);
      } else {
        resolve(sftp);
      }
    });
  });
}

// Every promisified SFTP helper funnels rejections through `mapSftpError` so
// callers see a KaosSSHError subclass (KaosFileNotFoundError / KaosPermissionError /
// KaosConnectionError / generic KaosSSHError) instead of the raw ssh2 error.
// The operation label is the underlying SFTP RPC name — it shows up in the
// error message for debugging and is the same label used by `stat()` before
// this was hoisted into the helpers.

function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    sftp.realpath(path, (err, absPath) => {
      if (err) {
        reject(mapSftpError('realpath', err));
      } else {
        resolve(absPath);
      }
    });
  });
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<SFTPStats> {
  return new Promise<SFTPStats>((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) {
        reject(mapSftpError('stat', err));
      } else {
        resolve(stats);
      }
    });
  });
}

function sftpLstat(sftp: SFTPWrapper, path: string): Promise<SFTPStats> {
  return new Promise<SFTPStats>((resolve, reject) => {
    sftp.lstat(path, (err, stats) => {
      if (err) {
        reject(mapSftpError('lstat', err));
      } else {
        resolve(stats);
      }
    });
  });
}

interface SFTPFileEntry {
  filename: string;
  attrs: SFTPStats;
}

function sftpReaddir(sftp: SFTPWrapper, path: string): Promise<SFTPFileEntry[]> {
  return new Promise<SFTPFileEntry[]>((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) {
        reject(mapSftpError('readdir', err));
      } else {
        resolve(list as SFTPFileEntry[]);
      }
    });
  });
}

function sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      if (err) {
        reject(mapSftpError('mkdir', err));
      } else {
        resolve();
      }
    });
  });
}

function sftpExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    sftp.exists(path, (exists) => {
      resolve(exists);
    });
  });
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    sftp.readFile(path, (err, data) => {
      if (err) {
        reject(mapSftpError('readFile', err));
      } else {
        resolve(data);
      }
    });
  });
}

function sftpWriteFile(sftp: SFTPWrapper, path: string, data: string | Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(path, data, (err) => {
      if (err) {
        reject(mapSftpError('writeFile', err));
      } else {
        resolve();
      }
    });
  });
}

function sftpAppendFile(sftp: SFTPWrapper, path: string, data: string | Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.appendFile(path, data, (err) => {
      if (err) {
        reject(mapSftpError('appendFile', err));
      } else {
        resolve();
      }
    });
  });
}

function clientExec(client: Client, command: string): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    client.exec(command, (err: Error | undefined, channel: ClientChannel) => {
      if (err) {
        reject(err);
      } else {
        resolve(channel);
      }
    });
  });
}

// ── SSHKaos ────────────────────────────────────────────────────────────

/**
 * A KAOS implementation that interacts with a remote machine via SSH and SFTP.
 */
export class SSHKaos implements Kaos {
  readonly name: string = 'ssh';

  private _client: Client;
  private _sftp: SFTPWrapper;
  private _home: string;
  private _cwd: string;

  private constructor(client: Client, sftp: SFTPWrapper, home: string, cwd: string) {
    this._client = client;
    this._sftp = sftp;
    this._home = home;
    this._cwd = cwd;
  }

  /**
   * Resolve a path against the current working directory.
   * If the path is already absolute, return it as-is.
   * Otherwise, join it with `_cwd` using POSIX path semantics
   * (SSH remote is always POSIX).
   */
  private _resolvePath(path: string): string {
    if (posix.isAbsolute(path)) return path;
    return posix.join(this._cwd, path);
  }

  /**
   * Factory method to create an SSHKaos instance.
   * Establishes the SSH connection and SFTP session.
   */
  static async create(options: SSHKaosOptions): Promise<SSHKaos> {
    // Start from extraOptions (advanced ssh2 options) so our managed fields
    // below take precedence.
    const config: ConnectConfig = {
      ...options.extraOptions,
      host: options.host,
      port: options.port ?? 22,
      username: options.username,
    };

    if (options.password !== undefined) {
      config.password = options.password;
    }

    // Build private keys from keyContents and keyPaths
    const privateKeys: (Buffer | string)[] = [];
    if (options.keyContents) {
      for (const content of options.keyContents) {
        privateKeys.push(content);
      }
    }
    if (options.keyPaths) {
      const keyPromises = options.keyPaths.map((keyPath) => readFile(keyPath, 'utf-8'));
      const keyData = await Promise.all(keyPromises);
      for (const key of keyData) {
        privateKeys.push(key);
      }
    }
    if (privateKeys.length > 0) {
      const authHandler = buildAuthHandler(options.username, privateKeys, options.password);
      if (authHandler !== undefined) {
        config.authHandler = authHandler;
      }
    }

    // Disable host key verification (like asyncssh known_hosts=None)
    config.hostVerifier = () => true;

    const client = await connectClient(config);
    try {
      const sftp = await getSftp(client);

      // Determine home and cwd
      const home = await sftpRealpath(sftp, '.');
      let cwd: string;
      if (options.cwd === undefined) {
        cwd = home;
      } else {
        cwd = await sftpRealpath(sftp, options.cwd);
        const attrs = await sftpStat(sftp, cwd);
        if (!attrs.isDirectory()) {
          throw new KaosValueError(`${cwd} is not a directory`);
        }
      }

      return new SSHKaos(client, sftp, home, cwd);
    } catch (error) {
      client.end();
      throw error;
    }
  }

  // ── Path operations (sync) ─────────────────────────────────────────

  pathClass(): 'posix' | 'win32' {
    return 'posix';
  }

  normpath(path: string): string {
    return posix.normalize(path);
  }

  gethome(): string {
    return this._home;
  }

  getcwd(): string {
    return this._cwd;
  }

  // ── Directory operations (async) ───────────────────────────────────

  async chdir(path: string): Promise<void> {
    let target: string;
    if (posix.isAbsolute(path)) {
      target = path;
    } else {
      target = posix.resolve(this._cwd, path);
    }
    // Resolve to the real path via SFTP
    const resolved = await sftpRealpath(this._sftp, target);
    // Verify the resolved target is actually a directory. Without this
    // guard, `realpath` happily returns file paths, causing later relative
    // reads/writes/execs to treat a regular file as a working directory.
    const attrs = await sftpStat(this._sftp, resolved);
    if (!attrs.isDirectory()) {
      throw new KaosValueError(`${resolved} is not a directory`);
    }
    this._cwd = resolved;
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    const resolved = this._resolvePath(path);
    const followSymlinks = options?.followSymlinks ?? true;
    // sftpStat / sftpLstat already wrap errors via mapSftpError.
    const st = followSymlinks
      ? await sftpStat(this._sftp, resolved)
      : await sftpLstat(this._sftp, resolved);

    return {
      stMode: buildStMode(st),
      // SFTP does not provide inode
      stIno: 0,
      // SFTP does not provide device
      stDev: 0,
      // ssh2 Stats does not expose nlink
      stNlink: 0,
      stUid: st.uid,
      stGid: st.gid,
      stSize: st.size,
      stAtime: st.atime,
      stMtime: st.mtime,
      // SFTP v3 has no ctime, fallback to mtime
      stCtime: st.mtime,
    };
  }

  async *iterdir(path: string): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const entries = await sftpReaddir(this._sftp, resolved);
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue;
      yield posix.join(resolved, entry.filename);
    }
  }

  async *glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const caseSensitive = options?.caseSensitive ?? true;
    if (!caseSensitive) {
      throw new KaosValueError('Case insensitive glob is not supported in current environment');
    }
    // Use local glob implementation over SFTP readdir
    const patternParts = pattern.split('/');
    yield* this._globWalk(resolved, patternParts, caseSensitive);
  }

  private async *_globWalk(
    basePath: string,
    patternParts: string[],
    caseSensitive: boolean,
  ): AsyncGenerator<string> {
    if (patternParts.length === 0) return;

    const [currentPattern, ...remainingParts] = patternParts;

    if (currentPattern === '**') {
      // `**` matches zero or more directory components.
      //
      // Two cases to handle:
      //   (a) `**` matches zero directories → continue at basePath with
      //       the remaining pattern parts (or yield basePath when `**` is
      //       the final segment).
      //   (b) `**` matches one or more directories → recurse into each
      //       subdirectory, keeping `**` (the full patternParts) at the
      //       front. The "zero directories" case is re-evaluated at the
      //       subdirectory level by that recursive call.
      //
      // Do NOT additionally recurse with `remainingParts` on subdirectories
      // — that would double-count matches at depth ≥ 1 because case (a)
      // inside the child recursion already yields those results.
      if (remainingParts.length > 0) {
        yield* this._globWalk(basePath, remainingParts, caseSensitive);
      } else {
        // Pattern ends with `**`: yield basePath itself (zero-dir match).
        yield basePath;
      }

      let entries: SFTPFileEntry[];
      try {
        entries = await sftpReaddir(this._sftp, basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        const fullPath = posix.join(basePath, entry.filename);
        if (entry.attrs.isDirectory()) {
          yield* this._globWalk(fullPath, patternParts, caseSensitive);
        } else if (remainingParts.length === 0) {
          // Pattern ends with `**`: non-directory entries match too.
          yield fullPath;
        }
      }
    } else {
      const regex = globPatternToRegex(currentPattern ?? '', caseSensitive);

      let entries: SFTPFileEntry[];
      try {
        entries = await sftpReaddir(this._sftp, basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        if (!regex.test(entry.filename)) continue;

        const fullPath = posix.join(basePath, entry.filename);

        if (remainingParts.length === 0) {
          yield fullPath;
        } else if (entry.attrs.isDirectory()) {
          yield* this._globWalk(fullPath, remainingParts, caseSensitive);
        }
      }
    }
  }

  // ── File operations (async) ────────────────────────────────────────

  async readBytes(path: string, n?: number): Promise<Buffer> {
    const data = await sftpReadFile(this._sftp, this._resolvePath(path));
    if (n === undefined) return data;
    return data.subarray(0, n);
  }

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const data = await sftpReadFile(this._sftp, this._resolvePath(path));
    return decodeTextWithErrors(data, encoding, errors);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    // SFTP does not support streaming line reads; read all then split.
    // Match Python's splitlines() semantics: returned lines do NOT include
    // the line terminator, and a trailing newline does not create an extra
    // empty line.
    const text = await this.readText(this._resolvePath(path), options);
    if (text === '') {
      return;
    }

    const lines = text.split(/\r\n|[\n\r]/u);
    if (/(?:\r\n|[\n\r])$/u.test(text)) {
      lines.pop();
    }
    for (const line of lines) {
      yield line ?? '';
    }
  }

  async writeBytes(path: string, data: Buffer): Promise<number> {
    await sftpWriteFile(this._sftp, this._resolvePath(path), data);
    return data.length;
  }

  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const resolved = this._resolvePath(path);
    const mode = options?.mode ?? 'w';
    const encoding = options?.encoding ?? 'utf-8';
    const buf = Buffer.from(data, encoding);
    if (mode === 'a') {
      await sftpAppendFile(this._sftp, resolved, buf);
    } else {
      await sftpWriteFile(this._sftp, resolved, buf);
    }
    return data.length;
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const resolved = this._resolvePath(path);
    const parents = options?.parents ?? false;
    const existOk = options?.existOk ?? false;

    if (parents) {
      await this._mkdirRecursive(resolved, existOk);
    } else {
      const exists = await sftpExists(this._sftp, resolved);
      if (exists) {
        if (!existOk) {
          throw new KaosFileExistsError(`${resolved} already exists`);
        }
        // `existOk` only applies when the conflicting path is itself a
        // directory. A regular file sitting at the target path is still
        // a conflict — we must not pretend mkdir succeeded.
        const st = await sftpStat(this._sftp, resolved);
        if (!st.isDirectory()) {
          throw new KaosFileExistsError(`${resolved} already exists but is not a directory`);
        }
        return;
      }
      await sftpMkdir(this._sftp, resolved);
    }
  }

  private async _mkdirRecursive(path: string, existOk: boolean): Promise<void> {
    // Split path into components and create each level.
    const parts = path.split('/').filter(Boolean);
    let current = path.startsWith('/') ? '/' : '';
    const lastIndex = parts.length - 1;
    for (const [i, part] of parts.entries()) {
      current = current ? posix.join(current, part) : part;

      const isFinal = i === lastIndex;

      // eslint-disable-next-line no-await-in-loop
      const exists = await sftpExists(this._sftp, current);
      if (exists) {
        // For intermediate components, it's fine (and expected) for the
        // path to already exist. For the final target, honor `existOk`.
        if (isFinal && !existOk) {
          throw new KaosFileExistsError(`${current} already exists`);
        }
        // Regardless of whether this is an intermediate or the final
        // component, an existing path must actually be a directory.
        // An intermediate non-directory would cause the next `sftpMkdir`
        // to fail with a confusing error; a final non-directory would
        // otherwise be silently accepted when `existOk` is true, which
        // is the original bug (Codex Round 9 P2).
        // eslint-disable-next-line no-await-in-loop
        const st = await sftpStat(this._sftp, current);
        if (!st.isDirectory()) {
          throw new KaosFileExistsError(`${current} already exists but is not a directory`);
        }
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await sftpMkdir(this._sftp, current);
      } catch (error) {
        // Race condition: another process may have created it.
        // eslint-disable-next-line no-await-in-loop
        const nowExists = await sftpExists(this._sftp, current);
        if (!nowExists) throw new Error(`Failed to create directory: ${current}`, { cause: error });
        // A raced path must still be a directory. Another process may have
        // created a regular file at the same pathname after our exists()
        // check but before mkdir(), which must remain a hard conflict.
        // eslint-disable-next-line no-await-in-loop
        const st = await sftpStat(this._sftp, current);
        if (!st.isDirectory()) {
          throw new KaosFileExistsError(`${current} already exists but is not a directory`);
        }
        // If the final component lost a race and existOk=false, surface the
        // conflict to match the non-race path above.
        if (isFinal && !existOk) {
          throw new KaosFileExistsError(`${current} already exists`);
        }
      }
    }
  }

  // ── Process execution ──────────────────────────────────────────────

  exec(...args: string[]): Promise<KaosProcess> {
    if (args.length === 0) {
      throw new KaosValueError(
        'SSHKaos.exec(): at least one argument (the command to run) is required.',
      );
    }
    return this._execInternal(args);
  }

  execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    if (args.length === 0) {
      throw new KaosValueError(
        'SSHKaos.execWithEnv(): at least one argument (the command to run) is required.',
      );
    }
    return this._execInternal(args, env);
  }

  /**
   * Build the full remote shell command string that will be handed to
   * `client.exec`. Exposed as a static so it can be unit-tested without
   * needing a live SSH connection — see `ssh.test.ts`.
   *
   * Shape: `cd '<cwd>' && KEY1='v1' KEY2='v2' <cmd> <arg1> <arg2> ...`
   *
   * Environment variables are injected as POSIX inline assignments instead
   * of being passed through ssh2's `ExecOptions.env`. The env-request path
   * silently drops anything not whitelisted by sshd's `AcceptEnv` directive
   * (stock OpenSSH only allows LANG/LC_*), which is a well-known footgun
   * inherited from the Python / asyncssh implementation. Inline assignments
   * run inside the remote shell itself, so they bypass AcceptEnv entirely
   * and reach the command regardless of server configuration.
   */
  private static _buildExecCommand(
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ): string {
    let command = args.map((arg) => shellQuote(arg)).join(' ');

    if (env !== undefined) {
      const assignments: string[] = [];
      for (const [key, value] of Object.entries(env)) {
        // Reject anything that isn't a POSIX-valid shell variable name so
        // the injected prefix can never become a shell-injection vector.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new KaosValueError(
            `SSHKaos.execWithEnv(): invalid env variable name ${JSON.stringify(key)}`,
          );
        }
        assignments.push(`${key}=${shellQuote(value)}`);
      }
      if (assignments.length > 0) {
        command = `${assignments.join(' ')} ${command}`;
      }
    }

    if (cwd !== '') {
      command = `cd ${shellQuote(cwd)} && ${command}`;
    }

    return command;
  }

  private async _execInternal(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    const command = SSHKaos._buildExecCommand(args, this._cwd, env);
    const channel = await clientExec(this._client, command);
    return new SSHProcess(channel);
  }

  // ── SSH lifecycle ──────────────────────────────────────────────────

  /**
   * Close the SSH connection. After this, the SSHKaos instance is unusable.
   */
  close(): Promise<void> {
    this._sftp.end();
    return new Promise<void>((resolve) => {
      this._client.once('close', () => {
        resolve();
      });
      this._client.end();
    });
  }
}
