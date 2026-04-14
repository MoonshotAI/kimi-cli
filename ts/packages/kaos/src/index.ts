import { getCurrentKaos } from './current.js';
import type { KaosProcess } from './process.js';
import type { StatResult } from './types.js';

export type { StatResult } from './types.js';
export type { KaosProcess } from './process.js';
export type { Kaos } from './kaos.js';
export type { KaosToken } from './current.js';
export { KaosError, KaosValueError, KaosFileExistsError } from './errors.js';
export { KaosPath } from './path.js';
export { LocalKaos, localKaos } from './local.js';
export { setCurrentKaos, resetCurrentKaos, runWithKaos } from './current.js';
export { SSHKaos } from './ssh.js';
export type { SSHKaosOptions, SSHKaosExtraOptions } from './ssh.js';
export { getCurrentKaos };

// ── Module-level convenience functions (delegate to getCurrentKaos) ──

/** Read a file as text, delegating to the current Kaos instance. */
export function readText(
  path: string,
  options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
): Promise<string> {
  return getCurrentKaos().readText(path, options);
}

/** Write text to a file, delegating to the current Kaos instance. */
export function writeText(
  path: string,
  data: string,
  options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
): Promise<number> {
  return getCurrentKaos().writeText(path, data, options);
}

/** Read a file line by line, delegating to the current Kaos instance. */
export function readLines(
  path: string,
  options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
): AsyncGenerator<string> {
  return getCurrentKaos().readLines(path, options);
}

/** Spawn a process, delegating to the current Kaos instance. */
export function exec(...args: string[]): Promise<KaosProcess> {
  return getCurrentKaos().exec(...args);
}

/** Read a file as bytes, delegating to the current Kaos instance. */
export function readBytes(path: string, n?: number): Promise<Buffer> {
  return getCurrentKaos().readBytes(path, n);
}

/** Write bytes to a file, delegating to the current Kaos instance. */
export function writeBytes(path: string, data: Buffer): Promise<number> {
  return getCurrentKaos().writeBytes(path, data);
}

/** Get stat information for a path, delegating to the current Kaos instance. */
export function stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
  return getCurrentKaos().stat(path, options);
}

/** Create a directory, delegating to the current Kaos instance. */
export function mkdir(
  path: string,
  options?: { parents?: boolean; existOk?: boolean },
): Promise<void> {
  return getCurrentKaos().mkdir(path, options);
}

/** Iterate over entries in a directory, delegating to the current Kaos instance. */
export function iterdir(path: string): AsyncGenerator<string> {
  return getCurrentKaos().iterdir(path);
}

/** Glob for entries matching a pattern, delegating to the current Kaos instance. */
export function glob(
  path: string,
  pattern: string,
  options?: { caseSensitive?: boolean },
): AsyncGenerator<string> {
  return getCurrentKaos().glob(path, pattern, options);
}

/** Change the working directory, delegating to the current Kaos instance. */
export function chdir(path: string): Promise<void> {
  return getCurrentKaos().chdir(path);
}

/** Return the current working directory from the current Kaos instance. */
export function getcwd(): string {
  return getCurrentKaos().getcwd();
}

/** Return the home directory from the current Kaos instance. */
export function gethome(): string {
  return getCurrentKaos().gethome();
}

/** Normalize a path using the current Kaos instance's path semantics. */
export function normpath(path: string): string {
  return getCurrentKaos().normpath(path);
}

/** Return the current Kaos instance's path class ('posix' or 'win32'). */
export function pathClass(): 'posix' | 'win32' {
  return getCurrentKaos().pathClass();
}

/** Spawn a process with a custom environment, delegating to the current Kaos instance. */
export function execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
  return getCurrentKaos().execWithEnv(args, env);
}
