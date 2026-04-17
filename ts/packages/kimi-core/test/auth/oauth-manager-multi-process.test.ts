/**
 * Phase 15 B.2 C2 — OAuthManager cross-process refresh lock.
 *
 * Python parity: `tests/auth/test_oauth_cross_process.py:27-58` spawns
 * N Node worker processes that each call `ensureFresh(force=true)` on
 * the same OAuth provider. With a proper cross-process lock, only one
 * worker actually hits the refresh endpoint (the `refreshImpl`); the
 * others re-read storage and see the rotated token produced by the
 * winner.
 *
 * Current TS implementation (`src/auth/oauth-manager.ts:142-150`) has a
 * FIXME — only best-effort "re-read storage before refresh" protects
 * against duplicate refreshes; there is no actual cross-process mutex.
 * These tests are the red-bar contract for B.2's `proper-lockfile`
 * wrap: once Implementer wires `acquire({stale:5_000ms, retries:3,
 * minTimeout:200ms})` around `doEnsureFresh`, exactly one refresh fires
 * across all 5 workers.
 *
 * Workers run as inline `.mjs` scripts via `spawnInlineWorkers`. Each
 * worker:
 *   1. Dynamically imports `OAuthManager` from `@moonshot-ai/core`.
 *   2. Constructs it with a file-backed TokenStorage pointing at
 *      `{shareDir}/token.json` and a `refreshTokenImpl` that increments
 *      `{shareDir}/refresh-count.txt` atomically before returning a
 *      rotated token (refreshToken changes every refresh).
 *   3. Calls `ensureFresh({force:true})` and exits.
 *
 * Oracle: after all workers exit, `refresh-count.txt` contains exactly
 * `1` (when the lock is in place); `N` (when it is not).
 *
 * **Platform**: macOS / Linux only. Windows path quirks for
 * `proper-lockfile` land in Phase 14 + a `KIMI_DISABLE_OAUTH_LOCK=1`
 * env-var escape hatch; this test skips on `process.platform === 'win32'`.
 */

import { execSync } from 'node:child_process';
import { mkdir, readFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createTempWorkDir,
  spawnInlineWorkers,
  type TempDirHandle,
} from '../helpers/index.js';

// ─────────────────────────────────────────────────────────────────────
// Workers spawn from a temp dir, so Node's package resolver cannot find
// `@moonshot-ai/core` — node_modules is outside the spawned script's
// tree. Phase 15 B.2 plumbing: resolve the package's built ESM dist
// from the repo tree and inject its file URL via env so the worker
// imports via dynamic specifier.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_DIST = join(PACKAGE_ROOT, 'dist', 'index.mjs');

function ensureCoreDist(): string {
  if (!existsSync(CORE_DIST)) {
    execSync('pnpm build', { cwd: PACKAGE_ROOT, stdio: 'inherit' });
  }
  return pathToFileURL(CORE_DIST).href;
}

const skipOnWindows = process.platform === 'win32';

// ─────────────────────────────────────────────────────────────────────
// Worker body — dedicated inline .mjs script.
// ─────────────────────────────────────────────────────────────────────
//
// One worker = one ensureFresh(force=true) invocation. All workers race
// against the same on-disk lock file and the same refresh-count.txt.
//
// `refresh-count.txt` starts empty (or missing). Workers atomically
// append a single byte per observed refresh using O_APPEND semantics;
// the final byte count equals the number of refreshes that took place.

const WORKER_SCRIPT = `
  import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
  import { join } from 'node:path';
  // Phase 15 B.2 plumbing: @moonshot-ai/core cannot resolve from
  // the tmp working dir where this worker lives, so the spawning test
  // injects the package's built ESM entrypoint via env and we
  // dynamic-import it here.
  const { OAuthManager } = await import(process.env.KIMI_CORE_MODULE_URL);

  const shareDir = process.env.KIMI_SHARE_DIR;
  const tokenPath = join(shareDir, 'token.json');
  const counterPath = join(shareDir, 'refresh-count.txt');
  const lockDir = join(shareDir, 'oauth');
  await mkdir(lockDir, { recursive: true });

  const config = {
    name: 'test-provider',
    oauthHost: 'https://unused.test',
    clientId: 'test',
  };

  /** File-backed TokenStorage keyed on the single provider 'test-provider'. */
  const storage = {
    async load(name) {
      try {
        const raw = await readFile(tokenPath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed[name];
      } catch {
        return undefined;
      }
    },
    async save(name, token) {
      // Read-modify-write. Good enough for the test oracle; the real
      // cross-process correctness comes from the lock, not the storage.
      let bag = {};
      try {
        bag = JSON.parse(await readFile(tokenPath, 'utf8'));
      } catch {
        bag = {};
      }
      bag[name] = token;
      await writeFile(tokenPath, JSON.stringify(bag), 'utf8');
    },
    async remove(name) {},
    async list() { return ['test-provider']; },
  };

  /** refreshImpl increments the oracle file and hands back a rotated token. */
  const refreshImpl = async () => {
    // One byte per observed refresh; O_APPEND is atomic on POSIX.
    await appendFile(counterPath, '.');
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      accessToken: 'at-refreshed-' + String(nowSec),
      refreshToken: 'rt-rotated-' + String(nowSec),
      expiresAt: nowSec + 3600,
      scope: '',
      tokenType: 'Bearer',
      expiresIn: 3600,
    };
  };

  const manager = new OAuthManager({
    config,
    storage,
    refreshTokenImpl: refreshImpl,
    // minimal stubs — unused on ensureFresh
    requestDeviceImpl: async () => { throw new Error('unused'); },
    pollDeviceImpl: async () => { throw new Error('unused'); },
    now: () => Math.floor(Date.now() / 1000),
  });

  // Every worker attempts a forced refresh. With a cross-process lock
  // in place, only one worker's refreshImpl runs; the others read the
  // rotated storage and return its accessToken without calling
  // refreshImpl.
  try {
    const token = await manager.ensureFresh({ force: true });
    process.stdout.write('ok:' + token + '\\n');
  } catch (err) {
    process.stdout.write('err:' + (err && err.message ? err.message : String(err)) + '\\n');
  }
  // Debug trace so the test oracle can diagnose mis-locking.
  if (process.env.DEBUG_OAUTH_WORKER === '1') {
    process.stderr.write('[worker ' + process.env.KIMI_WORKER_ID + '] done\\n');
  }
`;

async function seedInitialToken(shareDir: string): Promise<void> {
  const tokenPath = join(shareDir, 'token.json');
  const nowSec = Math.floor(Date.now() / 1000);
  const token = {
    'test-provider': {
      accessToken: 'at-initial',
      refreshToken: 'rt-initial',
      expiresAt: nowSec + 60, // inside refresh threshold → force refresh hits
      scope: '',
      tokenType: 'Bearer',
      expiresIn: 3600,
    },
  };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(tokenPath, JSON.stringify(token), 'utf8');
}

async function readRefreshCount(shareDir: string): Promise<number> {
  const counterPath = join(shareDir, 'refresh-count.txt');
  try {
    const s = await stat(counterPath);
    return s.size;
  } catch {
    return 0;
  }
}

const tmpHandles: TempDirHandle[] = [];

afterEach(async () => {
  while (tmpHandles.length > 0) {
    await tmpHandles.pop()!.cleanup();
  }
});

describe.skipIf(skipOnWindows)(
  'OAuthManager cross-process refresh lock (Phase 15 B.2 C2)',
  () => {
    let coreModuleUrl: string;
    beforeAll(() => {
      coreModuleUrl = ensureCoreDist();
    });

    it('5 workers concurrently force-refresh → exactly one refreshImpl fires', async () => {
      const dir = await createTempWorkDir();
      tmpHandles.push(dir);
      await seedInitialToken(dir.path);

      const workers = await spawnInlineWorkers({
        count: 5,
        inlineScript: WORKER_SCRIPT,
        tmpDir: dir.path,
        shareDir: dir.path,
        timeoutMs: 30_000,
        env: { KIMI_CORE_MODULE_URL: coreModuleUrl },
      });

      // All workers exit cleanly.
      for (const w of workers) {
        expect(w.exitCode, `worker ${String(w.id)} stderr: ${w.stderr}`).toBe(0);
        expect(w.stdout.startsWith('ok:')).toBe(true);
      }

      // Refresh count = 1 → exactly one refresh happened across the 5
      // processes. Without the lock the count equals N (or any value > 1).
      const count = await readRefreshCount(dir.path);
      expect(count).toBe(1);
    }, 45_000);

    it('stale lock (held by a killed worker) is reclaimed after stale timeout', async () => {
      // Scenario: worker A takes the lock and crashes without releasing
      // (SIGKILL). Worker B arrives 6+ seconds later and must reclaim
      // the stale lock via `proper-lockfile`'s `stale: 5_000ms` policy.
      //
      // BLK-2 fix: proper-lockfile represents the lock as a DIRECTORY
      // at `{target}.lock/`. The staleness probe is `stat().mtimeMs`
      // on that directory, so we must `mkdir` + `utimes` (not
      // `writeFile`, which would put a regular file where a dir is
      // expected — `proper-lockfile` would then blow up or
      // mis-interpret it).
      const dir = await createTempWorkDir();
      tmpHandles.push(dir);
      await seedInitialToken(dir.path);
      await mkdir(join(dir.path, 'oauth'), { recursive: true });

      const { utimes } = await import('node:fs/promises');
      const lockDir = join(dir.path, 'oauth', 'test-provider.lock');
      await mkdir(lockDir, { recursive: true });
      // 10 seconds ago — past the 5 s stale threshold.
      const tenSecondsAgo = (Date.now() - 10_000) / 1000;
      await utimes(lockDir, tenSecondsAgo, tenSecondsAgo);

      const workers = await spawnInlineWorkers({
        count: 1,
        inlineScript: WORKER_SCRIPT,
        tmpDir: dir.path,
        shareDir: dir.path,
        timeoutMs: 20_000,
        env: { KIMI_CORE_MODULE_URL: coreModuleUrl },
      });

      expect(workers[0]?.exitCode).toBe(0);
      expect(workers[0]?.stdout.startsWith('ok:')).toBe(true);
    }, 30_000);

    it('all workers finish with no leftover .lock directory', async () => {
      // Every worker releases the lock on exit — after the run, no
      // lockfile remnants survive. Pin the cleanup contract so an
      // Implementer refactor that stops releasing the lock is caught.
      const dir = await createTempWorkDir();
      tmpHandles.push(dir);
      await seedInitialToken(dir.path);

      const workers = await spawnInlineWorkers({
        count: 3,
        inlineScript: WORKER_SCRIPT,
        tmpDir: dir.path,
        shareDir: dir.path,
        timeoutMs: 30_000,
        env: { KIMI_CORE_MODULE_URL: coreModuleUrl },
      });
      for (const w of workers) {
        expect(w.exitCode, `worker ${String(w.id)} stderr: ${w.stderr}`).toBe(0);
      }

      // BLK-2 fix: proper-lockfile creates `{path}.lock` as a
      // DIRECTORY. Probe with `stat` (errors ENOENT when gone);
      // `readFile` on a directory throws EISDIR and would falsely
      // register "does not exist".
      const lockPath = join(dir.path, 'oauth', 'test-provider.lock');
      let lockExists = true;
      try {
        await stat(lockPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          lockExists = false;
        } else {
          throw err;
        }
      }
      expect(lockExists).toBe(false);
    }, 45_000);
  },
);

// Prevent "no tests in file" when running on Windows.
describe.skipIf(!skipOnWindows)(
  'OAuthManager cross-process refresh lock (Windows skip)',
  () => {
    it('skipped on Windows — covered by KIMI_DISABLE_OAUTH_LOCK=1 env escape hatch', () => {
      expect(skipOnWindows).toBe(true);
    });
  },
);

// Silence the rm import in case unused — some paths above read-only.
void rm;
