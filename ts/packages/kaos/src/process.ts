import type { Readable, Writable } from 'node:stream';

/**
 * A running process spawned by a {@link Kaos} environment.
 *
 * Provides access to standard I/O streams, the process ID, and lifecycle
 * management (wait / kill). The interface is intentionally minimal so it
 * can be backed by local child processes, SSH sessions, or container runtimes.
 */
export interface KaosProcess {
  /** Writable stream connected to the process's standard input. */
  readonly stdin: Writable;
  /** Readable stream for the process's standard output. */
  readonly stdout: Readable;
  /** Readable stream for the process's standard error. */
  readonly stderr: Readable;
  /** Operating-system process ID. */
  readonly pid: number;
  /** Exit code if the process has already terminated, otherwise `null`. */
  readonly exitCode: number | null;
  /** Wait for the process to exit and return its exit code. */
  wait(): Promise<number>;
  /** Send a signal to the process (defaults to `SIGTERM`). */
  kill(signal?: NodeJS.Signals): Promise<void>;
}
