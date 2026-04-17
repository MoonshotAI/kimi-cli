/**
 * Low-level POSIX durability primitives shared between the append path
 * (`WiredJournalWriter`) and the rotate path (`rotateJournal`).
 *
 * Two concerns that every durable write must handle:
 *   1. file *contents* — solved by `fh.sync()` after the write
 *   2. directory *entries* — solved by opening the parent directory and
 *      calling `fh.sync()` on the directory handle
 *
 * `fh.sync()` on a file does NOT guarantee that the directory entry
 * pointing at that file has been committed. On POSIX a crash between
 * the file-content fsync and the parent-directory fsync can leave the
 * file's bytes on disk with no visible name. v2 is POSIX-only by
 * design (§14.3), so we don't guard against Windows semantics here.
 */

import { closeSync, fsyncSync, openSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Open a directory read-only and fsync it, then close. Used to make a
 * freshly-created or renamed file's directory entry durable.
 */
export async function syncDir(dirPath: string): Promise<void> {
  const dirFh = await open(dirPath, 'r');
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}

/**
 * Synchronous variant of `syncDir`. Used by the batched drain path so a
 * single timer fire is an atomic event-loop step (see
 * `WiredJournalWriter.writeBatchAndSync` for the rationale).
 */
export function syncDirSync(dirPath: string): void {
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write `content` to `filePath` atomically and durably:
 *   1. Write content to `<filePath>.tmp`, fsync it, close it.
 *   2. Rename `<filePath>.tmp` → `filePath` (atomic on POSIX).
 *   3. fsync the parent directory so the rename is durable.
 *
 * On any failure before the rename the `.tmp` file is removed so the
 * caller's directory is not left with a half-written leftover. A
 * failure *after* the rename (i.e. in the parent-directory fsync) is
 * surfaced to the caller — the content is already in place, but
 * durability is not guaranteed.
 */
export async function writeFileAtomicDurable(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const tmpPath = filePath + '.tmp';
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, filePath);
    renamed = true;
    await syncDir(dirname(filePath));
  } finally {
    if (!renamed) {
      // Best-effort cleanup of the `.tmp` file if we never got to the
      // rename. Swallow ENOENT because the file may not exist (open
      // itself failed) or may already have been unlinked.
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }
}
