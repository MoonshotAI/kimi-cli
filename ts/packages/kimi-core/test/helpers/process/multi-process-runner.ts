/**
 * Multi-process test runner — Phase 9 §5.
 *
 * Mirrors Python `tests/auth/test_oauth_cross_process.py:27-58`. Spawns
 * N child `node` processes concurrently, each with a stable `id`
 * argument, pools their stdout/stderr, and returns a structured
 * summary when they all exit.
 *
 * Two shapes:
 *   - `spawnWorkers({scriptPath, count})` — script lives on disk
 *   - `spawnInlineWorkers({inlineScript, tmpDir})` — script body is a
 *     string the runner writes into `tmpDir` before spawning
 *
 * Timeout semantics (Review M7): when any worker exceeds `timeoutMs`
 * every live worker is `SIGKILL`ed and `spawnWorkers` rejects with
 * `TimeoutError`. Callers should `await expect(spawnWorkers(...)).
 * rejects.toBeInstanceOf(TimeoutError)` to assert the timeout path —
 * the old "attach error to the result row and still resolve" shape is
 * gone.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
  readonly workerId: number;
  readonly timeoutMs: number;
  constructor(workerId: number, timeoutMs: number) {
    super(`spawnWorkers: worker ${workerId} timed out after ${timeoutMs}ms`);
    this.workerId = workerId;
    this.timeoutMs = timeoutMs;
  }
}

export interface SpawnedWorker {
  readonly id: number;
  readonly pid: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly error?: unknown;
}

export interface SpawnWorkersOptions {
  readonly count: number;
  readonly scriptPath: string;
  readonly shareDir: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly args?: (i: number) => readonly string[];
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

interface RunningWorker {
  readonly id: number;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: string;
  stderr: string;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: unknown }>;
}

function startWorker(
  id: number,
  scriptPath: string,
  opts: SpawnWorkersOptions,
): RunningWorker {
  const extraArgs = opts.args !== undefined ? opts.args(id) : [];
  const child = spawn(process.execPath, [scriptPath, String(id), ...extraArgs], {
    env: {
      ...process.env,
      KIMI_SHARE_DIR: opts.shareDir,
      KIMI_WORKER_ID: String(id),
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const running: RunningWorker = {
    id,
    child,
    stdout: '',
    stderr: '',
    exit: new Promise((resolve) => {
      child.on('error', (err) =>{  resolve({ code: null, signal: null, error: err }); });
      child.on('exit', (code, signal) =>{  resolve({ code, signal }); });
    }),
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    running.stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    running.stderr += chunk;
  });
  return running;
}

export async function spawnWorkers(
  opts: SpawnWorkersOptions,
): Promise<readonly SpawnedWorker[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const running: RunningWorker[] = [];
  for (let i = 0; i < opts.count; i += 1) {
    running.push(startWorker(i, opts.scriptPath, opts));
  }

  let timeoutWorkerId: number | null = null;
  const timer = setTimeout(() => {
    timeoutWorkerId = running.find((w) => w.child.exitCode === null)?.id ?? 0;
    for (const w of running) {
      if (w.child.exitCode === null) w.child.kill('SIGKILL');
    }
  }, timeoutMs);

  try {
    const results = await Promise.all(
      running.map(async (w): Promise<SpawnedWorker> => {
        const exit = await w.exit;
        return {
          id: w.id,
          pid: w.child.pid ?? -1,
          stdout: w.stdout,
          stderr: w.stderr,
          exitCode: exit.code ?? -1,
          signal: exit.signal,
          ...(exit.error !== undefined ? { error: exit.error } : {}),
        };
      }),
    );
    if (timeoutWorkerId !== null) {
      throw new TimeoutError(timeoutWorkerId, timeoutMs);
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

export interface SpawnInlineWorkersOptions extends Omit<SpawnWorkersOptions, 'scriptPath'> {
  readonly inlineScript: string;
  readonly tmpDir: string;
  readonly scriptName?: string;
}

export async function spawnInlineWorkers(
  opts: SpawnInlineWorkersOptions,
): Promise<readonly SpawnedWorker[]> {
  await mkdir(opts.tmpDir, { recursive: true });
  const scriptName = opts.scriptName ?? 'worker.mjs';
  const scriptPath = join(opts.tmpDir, scriptName);
  await writeFile(scriptPath, opts.inlineScript, 'utf8');
  return spawnWorkers({ ...opts, scriptPath });
}
