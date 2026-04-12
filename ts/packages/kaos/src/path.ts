import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import { getCurrentKaos } from './current.js';
import { KaosValueError } from './errors.js';
import type { StatResult } from './types.js';

// S_IFMT mask and S_IFDIR/S_IFREG constants for mode checking
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/**
 * Return the path module matching the current Kaos path class.
 */
function getPathMod(): typeof posixPath {
  const kaos = getCurrentKaos();
  return kaos.pathClass() === 'win32' ? win32Path : posixPath;
}

function splitPathLexically(
  pathMod: typeof posixPath,
  path: string,
): { root: string; parts: string[] } {
  const root = pathMod.parse(path).root;
  const tail = root.length > 0 ? path.slice(root.length) : path;
  return {
    root,
    parts: tail.split(pathMod.sep).filter((part) => part.length > 0),
  };
}

/**
 * A path wrapper class that delegates all I/O operations to the current Kaos instance.
 * Mirrors Python's kaos/path.py KaosPath.
 */
export class KaosPath {
  private readonly _path: string;

  constructor(...args: string[]) {
    if (args.length === 0) {
      this._path = '.';
    } else {
      this._path = getPathMod().join(...(args as [string, ...string[]]));
    }
  }

  // --- Properties ---

  /** The final component of this path (like Python's Path.name). */
  get name(): string {
    return getPathMod().basename(this._path);
  }

  /** The logical parent of this path (like Python's Path.parent). */
  get parent(): KaosPath {
    const dir = getPathMod().dirname(this._path);
    return new KaosPath(dir);
  }

  // --- Path operations (sync, no I/O) ---

  /** Whether this path is absolute. */
  isAbsolute(): boolean {
    return getPathMod().isAbsolute(this._path);
  }

  /** Join this path with other segments, returning a new KaosPath. */
  joinpath(...other: string[]): KaosPath {
    return new KaosPath(this._path, ...other);
  }

  /** Division operator equivalent: join with another path segment. */
  div(other: string | KaosPath): KaosPath {
    const otherStr = other instanceof KaosPath ? other.toString() : other;
    return new KaosPath(this._path, otherStr);
  }

  /**
   * Canonicalize the path without touching the filesystem.
   * Makes the path absolute (relative to cwd) and resolves '..' segments.
   */
  canonical(): KaosPath {
    const kaos = getCurrentKaos();
    const pathMod = kaos.pathClass() === 'win32' ? win32Path : posixPath;

    if (pathMod.isAbsolute(this._path)) {
      return new KaosPath(pathMod.normalize(this._path));
    }
    const cwd = kaos.getcwd();
    const abs = pathMod.resolve(cwd, this._path);
    return new KaosPath(pathMod.normalize(abs));
  }

  /** Compute a relative path from `other` to this path. */
  relativeTo(other: KaosPath): KaosPath {
    const pathMod = getPathMod();
    const target = splitPathLexically(pathMod, this._path);
    const base = splitPathLexically(pathMod, other.toString());

    if (target.root !== base.root) {
      throw new KaosValueError(`${this._path} is not within ${other.toString()}`);
    }
    if (base.parts.length > target.parts.length) {
      throw new KaosValueError(`${this._path} is not within ${other.toString()}`);
    }
    for (let i = 0; i < base.parts.length; i++) {
      if (target.parts[i] !== base.parts[i]) {
        throw new KaosValueError(`${this._path} is not within ${other.toString()}`);
      }
    }

    const relParts = target.parts.slice(base.parts.length);
    return new KaosPath(relParts.length === 0 ? '.' : relParts.join(pathMod.sep));
  }

  /** Expand leading ~ to the home directory. */
  expanduser(): KaosPath {
    if (this._path === '~' || this._path.startsWith('~/') || this._path.startsWith('~\\')) {
      const kaos = getCurrentKaos();
      const home = kaos.gethome();
      if (this._path === '~') {
        return new KaosPath(home);
      }
      const rest = this._path.slice(2); // strip "~/" or "~\"
      return new KaosPath(home + '/' + rest);
    }
    return new KaosPath(this._path);
  }

  // --- Static methods ---

  /** Return the home directory as a KaosPath (delegating to getCurrentKaos). */
  static home(): KaosPath {
    const kaos = getCurrentKaos();
    return new KaosPath(kaos.gethome());
  }

  /** Return the current working directory as a KaosPath (delegating to getCurrentKaos). */
  static cwd(): KaosPath {
    const kaos = getCurrentKaos();
    return new KaosPath(kaos.getcwd());
  }

  // --- Conversion ---

  /** Create a KaosPath from a local filesystem path string. */
  static fromLocalPath(localPath: string): KaosPath {
    return new KaosPath(localPath);
  }

  /** Return the underlying path string for local filesystem use. */
  toLocalPath(): string {
    return this._path;
  }

  /** Return the path as a string. */
  toString(): string {
    return this._path;
  }

  /** Check equality with another KaosPath by comparing string representations. */
  equals(other: KaosPath): boolean {
    return this._path === other.toString();
  }

  // --- File operations (async, delegate to getCurrentKaos) ---

  /** Get stat information for this path. */
  async stat(options?: { followSymlinks?: boolean }): Promise<StatResult> {
    const kaos = getCurrentKaos();
    return kaos.stat(this._path, options);
  }

  /** Check if this path exists on the filesystem. */
  async exists(options?: { followSymlinks?: boolean }): Promise<boolean> {
    try {
      await this.stat(options);
      return true;
    } catch {
      return false;
    }
  }

  /** Check if this path points to a regular file. */
  async isFile(options?: { followSymlinks?: boolean }): Promise<boolean> {
    try {
      const s = await this.stat(options);
      return (s.stMode & S_IFMT) === S_IFREG;
    } catch {
      return false;
    }
  }

  /** Check if this path points to a directory. */
  async isDir(options?: { followSymlinks?: boolean }): Promise<boolean> {
    try {
      const s = await this.stat(options);
      return (s.stMode & S_IFMT) === S_IFDIR;
    } catch {
      return false;
    }
  }

  /** Iterate over entries in this directory. */
  async *iterdir(): AsyncGenerator<KaosPath> {
    const kaos = getCurrentKaos();
    for await (const entry of kaos.iterdir(this._path)) {
      yield new KaosPath(entry);
    }
  }

  /** Glob for entries matching a pattern under this path. */
  async *glob(pattern: string, options?: { caseSensitive?: boolean }): AsyncGenerator<KaosPath> {
    const kaos = getCurrentKaos();
    for await (const match of kaos.glob(this._path, pattern, options)) {
      yield new KaosPath(match);
    }
  }

  /** Read the file content as a Buffer. */
  async readBytes(n?: number): Promise<Buffer> {
    const kaos = getCurrentKaos();
    return kaos.readBytes(this._path, n);
  }

  /** Read the file content as a string. */
  async readText(options?: {
    encoding?: BufferEncoding;
    errors?: 'strict' | 'replace' | 'ignore';
  }): Promise<string> {
    const kaos = getCurrentKaos();
    return kaos.readText(this._path, options);
  }

  /** Yield lines from the file one by one. */
  async *readLines(options?: {
    encoding?: BufferEncoding;
    errors?: 'strict' | 'replace' | 'ignore';
  }): AsyncGenerator<string> {
    const kaos = getCurrentKaos();
    for await (const line of kaos.readLines(this._path, options)) {
      yield line;
    }
  }

  /** Write binary data to this path, return the number of bytes written. */
  async writeBytes(data: Buffer): Promise<number> {
    const kaos = getCurrentKaos();
    return kaos.writeBytes(this._path, data);
  }

  /** Write text to this path, return the number of characters written. */
  async writeText(
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const kaos = getCurrentKaos();
    return kaos.writeText(this._path, data, options);
  }

  /** Append text to this path, return the number of characters written. */
  async appendText(data: string, options?: { encoding?: BufferEncoding }): Promise<number> {
    const kaos = getCurrentKaos();
    const writeOpts: { mode: 'a'; encoding?: BufferEncoding } = { mode: 'a' };
    if (options?.encoding !== undefined) {
      writeOpts.encoding = options.encoding;
    }
    return kaos.writeText(this._path, data, writeOpts);
  }

  /** Create this path as a directory. */
  async mkdir(options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const kaos = getCurrentKaos();
    await kaos.mkdir(this._path, options);
  }
}
