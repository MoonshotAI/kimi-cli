/**
 * compaction.ts — Windows-only EPERM retry on journal rotate.
 *
 * Phase 14 §2.2: `rotateJournal` (`src/storage/compaction.ts:105-141`)
 * calls `rename(currentPath, archivePath)`. On Windows, if a stale
 * reader still holds a handle to `wire.jsonl` the rename surfaces as
 * `EPERM`. Phase 14 adds a single 500 ms retry before re-raising.
 *
 * This test FAILS on Windows until the retry lands. On POSIX the
 * whole describe block is skipped.
 *
 * `rotateJournal`'s current signature is `(sessionDir, protocolVersion?)`
 * (see compaction.ts:105). Phase 14 §2.2 adds an optional `deps` bag:
 *
 *     rotateJournal(
 *       sessionDir: string,
 *       protocolVersion?: string,
 *       deps?: {
 *         renameFn?: (a: string, b: string) => Promise<void>;
 *         retryDelayMs?: number;
 *       },
 *     )
 *
 * The test uses the deps bag to inject a rename seam that throws EPERM
 * on the first attempt and succeeds on the second. The implementation
 * is expected to retry exactly once before propagating.
 */

import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isWindows } from '../helpers/platform.js';

describe.skipIf(!isWindows)(
  'rotateJournal — Windows EPERM retry (Phase 14 §2.2)',
  () => {
    let sessionDir: string;

    beforeEach(async () => {
      sessionDir = await mkdtemp(join(tmpdir(), 'kimi-compaction-win-'));
      await writeFile(join(sessionDir, 'wire.jsonl'), '{"type":"metadata"}\n');
    });

    afterEach(async () => {
      await rm(sessionDir, { recursive: true, force: true });
    });

    it('retries once on EPERM before propagating the archive rename', async () => {
      // eslint-disable-next-line import/no-unresolved
      const mod = await import('../../src/storage/compaction.js');
      const rotateJournal = (mod as unknown as {
        rotateJournal: (
          sessionDir: string,
          protocolVersion?: string,
          deps?: {
            renameFn?: (a: string, b: string) => Promise<void>;
            retryDelayMs?: number;
          },
        ) => Promise<{ archivePath: string; newCurrentPath: string }>;
      }).rotateJournal;

      let renameAttempts = 0;
      const fakeRename = async (a: string, b: string): Promise<void> => {
        renameAttempts += 1;
        if (renameAttempts === 1) {
          const err = Object.assign(new Error('EPERM'), {
            code: 'EPERM',
          });
          throw err;
        }
        const { rename } = await import('node:fs/promises');
        await rename(a, b);
      };

      const result = await rotateJournal(sessionDir, '2.1', {
        renameFn: fakeRename,
        retryDelayMs: 50,
      });

      expect(renameAttempts).toBe(2);
      // The archive file must contain the seed metadata we wrote.
      expect(await readFile(result.archivePath, 'utf-8')).toContain('metadata');
      // A fresh wire.jsonl must be in place.
      const entries = await readdir(sessionDir);
      expect(entries).toContain('wire.jsonl');
    });
  },
);
