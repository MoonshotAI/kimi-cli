/**
 * Self-test — spawnWorkers / spawnInlineWorkers (Phase 9 §5).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempWorkDir,
  spawnInlineWorkers,
  spawnWorkers,
  TimeoutError,
  type TempDirHandle,
} from '../helpers/index.js';

const tmp: TempDirHandle[] = [];
afterEach(async () => {
  while (tmp.length > 0) {
    await tmp.pop()!.cleanup();
  }
});

describe('spawnInlineWorkers', () => {
  it('runs N workers concurrently and collects stdout', async () => {
    const dir = await createTempWorkDir();
    tmp.push(dir);
    const script = `
      const id = process.argv[2];
      const share = process.env.KIMI_SHARE_DIR;
      const workerId = process.env.KIMI_WORKER_ID;
      console.log(\`worker=\${id} shared=\${share} env=\${workerId}\`);
    `;
    const workers = await spawnInlineWorkers({
      count: 3,
      inlineScript: script,
      tmpDir: dir.path,
      shareDir: '/tmp/kimi-share-test',
    });
    expect(workers.length).toBe(3);
    for (const w of workers) {
      expect(w.exitCode).toBe(0);
      expect(w.stdout).toContain(`worker=${w.id}`);
      expect(w.stdout).toContain('/tmp/kimi-share-test');
    }
  }, 15_000);

  it('reports non-zero exit code on failure', async () => {
    const dir = await createTempWorkDir();
    tmp.push(dir);
    const workers = await spawnInlineWorkers({
      count: 1,
      inlineScript: `process.exit(42);`,
      tmpDir: dir.path,
      shareDir: '/tmp/kimi-share-test',
    });
    expect(workers[0]?.exitCode).toBe(42);
  });

  it('propagates KIMI_WORKER_ID to each worker', async () => {
    const dir = await createTempWorkDir();
    tmp.push(dir);
    const workers = await spawnInlineWorkers({
      count: 2,
      inlineScript: `process.stdout.write(process.env.KIMI_WORKER_ID);`,
      tmpDir: dir.path,
      shareDir: '/tmp/kimi-share-test',
    });
    expect(workers.map((w) => w.stdout).toSorted()).toEqual(['0', '1']);
  });
});

describe('spawnWorkers', () => {
  it('rejects with TimeoutError and SIGKILLs hanging workers', async () => {
    const dir = await createTempWorkDir();
    tmp.push(dir);
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const scriptPath = join(dir.path, 'hang.mjs');
    await writeFile(scriptPath, `setInterval(() => {}, 1000);`);
    await expect(
      spawnWorkers({
        count: 2,
        scriptPath,
        shareDir: dir.path,
        timeoutMs: 250,
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
  }, 10_000);
});
