/**
 * atomicWrite — cross-platform atomic file replacement (Decision #104).
 *
 * Guarantees that readers never observe a half-written file:
 *   1. Write content to a uniquely-named temp file in the same directory.
 *   2. fsync the temp file so the bytes are durable.
 *   3. rename(tmp, target) — atomic on POSIX.
 *   4. On any failure before the rename, unlink the temp file (best effort).
 *
 * This function does NOT fsync the parent directory. For full POSIX crash
 * durability (new directory entry survives power loss), use
 * `writeFileAtomicDurable` from `./fs-durability.ts` instead.
 *
 * NOT suitable for append-only paths (wire.jsonl). Those use
 * `JournalWriter.append()` which writes at the current file position.
 */

import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';

/**
 * fsync a file descriptor using the callback-based `fs.fsync`. We go
 * through the module namespace (`nodeFs.fsync`) rather than
 * `FileHandle.sync()` so vitest's `vi.spyOn(fs, 'fsync')` can
 * intercept the call for fault-injection tests.
 */
function syncFd(fd: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    nodeFs.fsync(fd, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Atomically write `content` to `filePath`. If the target already exists
 * it is replaced; if it does not exist it is created.
 *
 * @param filePath — absolute or relative path to the target file.
 * @param content  — string or binary payload to write.
 * @param _syncOverride — test seam: override the fsync implementation for
 *   fault injection. Production callers must never supply this.
 */
export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
  _syncOverride?: (fd: number) => Promise<void>,
): Promise<void> {
  const hex = randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${hex}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await (_syncOverride ?? syncFd)(fh.fd);
    } finally {
      await fh.close();
    }
    // Phase 14 §2.2 — Windows `fs.rename` maps to MoveFileEx and fails
    // with EPERM if the target is held by another handle. Pre-unlinking
    // before the rename turns this into the POSIX-style "replace" case.
    if (process.platform === 'win32') {
      try {
        await unlink(filePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw err;
      }
    }
    await rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore — file may not exist if open itself failed */
      }
    }
  }
}
