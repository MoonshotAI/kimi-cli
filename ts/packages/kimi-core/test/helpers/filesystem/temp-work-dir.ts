/**
 * Temp directory helpers — Phase 9 §6.
 *
 * Mirrors Python `tests/conftest.py:75-95` `temp_work_dir` / `temp_share_dir`.
 * Each factory returns a `TempDirHandle` with a `cleanup()` that removes the
 * directory on disposal. Callers are expected to call `cleanup()` in an
 * `afterEach` block (or rely on `createTempEnv().cleanup()` for a batch).
 */

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempDirHandle {
  readonly path: string;
  cleanup(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

function attachDispose(path: string): TempDirHandle {
  let disposed = false;
  const cleanup = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(path, { recursive: true, force: true });
  };
  return {
    path,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}

async function mkTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function createTempWorkDir(): Promise<TempDirHandle> {
  const path = await mkTempDir('kimi-test-work-');
  return attachDispose(path);
}

export async function createTempShareDir(): Promise<TempDirHandle> {
  const path = await mkTempDir('kimi-test-share-');
  return attachDispose(path);
}

export async function createTempHomeDir(): Promise<TempDirHandle> {
  const path = await mkTempDir('kimi-test-home-');
  return attachDispose(path);
}

export interface TempEnvHandle {
  readonly workDir: TempDirHandle;
  readonly shareDir: TempDirHandle;
  readonly homeDir: TempDirHandle;
  cleanup(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export async function createTempEnv(): Promise<TempEnvHandle> {
  const [workDir, shareDir, homeDir] = await Promise.all([
    createTempWorkDir(),
    createTempShareDir(),
    createTempHomeDir(),
  ]);
  let disposed = false;
  const cleanup = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await Promise.all([workDir.cleanup(), shareDir.cleanup(), homeDir.cleanup()]);
  };
  return {
    workDir,
    shareDir,
    homeDir,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}

export interface SeedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Write each file under the given root. Accepts nested relative paths;
 * intermediate directories are created with `recursive: true`.
 */
export async function seedFiles(rootDir: string, files: readonly SeedFile[]): Promise<void> {
  for (const f of files) {
    const abs = join(rootDir, f.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, 'utf8');
  }
}
