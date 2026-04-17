/**
 * atomicWrite — Phase 0.1 (Decision #104).
 *
 * Tests for the cross-platform atomic file write utility. The function
 * writes to a temporary file in the same directory, fsyncs, then renames
 * atomically so readers never observe a half-written file.
 *
 * All tests FAIL until `atomicWrite` is implemented in
 * `src/storage/atomic-write.ts`.
 */

import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isWindows } from '../helpers/platform.js';
// This import will fail until the module is created — Phase 0.1 deliverable.
import { atomicWrite } from '../../src/storage/atomic-write.js';

describe('atomicWrite (Phase 0.1 — Decision #104)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-atomic-write-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true });
  });

  it('writes content that can be read back verbatim', async () => {
    const target = join(workDir, 'state.json');
    const payload = JSON.stringify({ version: 1, data: 'hello' });

    await atomicWrite(target, payload);

    const content = await readFile(target, 'utf-8');
    expect(content).toBe(payload);
  });

  it('atomically replaces an existing file', async () => {
    const target = join(workDir, 'config.json');
    await writeFile(target, 'original');

    await atomicWrite(target, 'replaced');

    expect(await readFile(target, 'utf-8')).toBe('replaced');
  });

  it('does not corrupt the target when fsync throws (simulated disk failure)', async () => {
    const target = join(workDir, 'protected.json');
    await writeFile(target, 'must survive');

    // Use the _syncOverride test seam to simulate a disk failure after
    // writing to the temp file but before the rename can happen.
    const failingSync = async (_fd: number): Promise<void> => {
      throw new Error('simulated disk failure');
    };

    await expect(
      atomicWrite(target, 'this content must NOT land', failingSync),
    ).rejects.toThrow('simulated disk failure');

    // Original content must be intact
    expect(await readFile(target, 'utf-8')).toBe('must survive');

    // No stale temp file should be left behind
    const entries = await readdir(workDir);
    expect(entries).toEqual(['protected.json']);
  });

  it('creates a new file when the target path does not exist', async () => {
    const target = join(workDir, 'brand-new.json');

    await atomicWrite(target, 'fresh content');

    expect(await readFile(target, 'utf-8')).toBe('fresh content');
    const s = await stat(target);
    expect(s.isFile()).toBe(true);
  });
});

// ── Phase 14 §2.3 — Windows hardening ────────────────────────────────

describe.skipIf(!isWindows)(
  'atomicWrite — Windows pre-unlink hardening (Phase 14 §2.3)',
  () => {
    let workDir: string;

    beforeEach(async () => {
      workDir = await mkdtemp(join(tmpdir(), 'kimi-atomic-write-win-'));
    });

    afterEach(async () => {
      await rm(workDir, { recursive: true, force: true });
    });

    it('replaces a file with a stale read handle held', async () => {
      // Windows `fs.rename` (MoveFileEx) fails with EPERM when the
      // target is open by another handle. Phase 14 §2.2 requires
      // atomicWrite to pre-unlink the target on Windows before the
      // rename. This test holds a read handle open during the write
      // and expects the payload to land despite the handle.
      const target = join(workDir, 'locked.json');
      await writeFile(target, 'before');
      const handle = await open(target, 'r');
      try {
        await atomicWrite(target, 'after');
        const content = await readFile(target, 'utf-8');
        expect(content).toBe('after');
      } finally {
        await handle.close();
      }
    });

    it('treats ENOENT during pre-unlink as success (fresh file path)', async () => {
      // Pre-unlink must swallow ENOENT — writing to a path where the
      // target does not yet exist is the common case.
      const target = join(workDir, 'brand-new-win.json');
      await atomicWrite(target, 'fresh');
      expect(await readFile(target, 'utf-8')).toBe('fresh');
    });

    it('does not break POSIX-style path: tmp + rename still atomic on Windows', async () => {
      // The post-rename state must be identical to POSIX — same content,
      // no stale .tmp sibling.
      const target = join(workDir, 'posix-shape.json');
      await writeFile(target, 'v1');
      await atomicWrite(target, 'v2');

      const entries = await readdir(workDir);
      expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
      expect(await readFile(target, 'utf-8')).toBe('v2');
    });
  },
);

// ── Phase 14 §2.3 — Python parity gaps (3 tests) ─────────────────────

describe('atomicWrite — Python parity (Phase 14 §2.3)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-atomic-parity-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('raises when the parent directory does not exist', async () => {
    // Python `test_write_to_nonexistent_parent_raises` asserts a
    // FileNotFoundError. Node equivalent: ENOENT from the initial
    // tmp-file open.
    const target = join(workDir, 'nonexistent', 'data.json');
    await expect(atomicWrite(target, '{"a":1}')).rejects.toThrow(/ENOENT|no such file/i);
  });

  it('preserves indentation / pretty-printed content as provided', async () => {
    // Python `test_indent_formatting` probes `json.dumps(..., indent=2)`
    // — the wrapper. TS-side `atomicWrite` writes bytes verbatim, so
    // we just assert a newline-containing payload round-trips without
    // whitespace stripping.
    const target = join(workDir, 'indented.json');
    const payload = '{\n  "a": 1,\n  "b": [2, 3]\n}';
    await atomicWrite(target, payload);

    const raw = await readFile(target, 'utf-8');
    expect(raw).toContain('\n');
    expect(raw).toContain('  "a": 1');
    expect(raw).toBe(payload);
  });

  it('written file is valid on disk immediately (durable flush, not just buffered)', async () => {
    // Python `test_written_file_is_valid_on_disk` opens the target
    // with a fresh fd via `os.open` to bypass any cached content. TS
    // mirrors that by re-opening through `fs/promises.open` + `read`.
    const target = join(workDir, 'durable.json');
    await atomicWrite(target, '{"key":"value"}');

    const handle = await open(target, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytesRead).toString('utf-8');
      expect(JSON.parse(text)).toEqual({ key: 'value' });
    } finally {
      await handle.close();
    }
  });
});

describe('atomicWrite — append-only paths stay unaffected', () => {
  it('JournalWriter.append uses file append (not atomicWrite) for WAL entries', async () => {
    // wire.jsonl is append-only; atomicWrite (write-tmp + rename) would
    // replace the entire file on every record, losing all previous entries.
    // This test verifies the wired journal writer preserves prior entries
    // when appending, confirming it does NOT use atomicWrite internally.
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-wal-check-'));
    try {
      const filePath = join(workDir, 'wire.jsonl');
      // Seed the file with a metadata line
      await writeFile(filePath, '{"type":"metadata","protocol_version":"2.1","created_at":1}\n');

      const { WiredJournalWriter } = await import('../../src/storage/journal-writer.js');
      const writer = new WiredJournalWriter({
        filePath,
        lifecycle: {
          get state() {
            return 'active' as const;
          },
        },
        initialSeq: 0,
        metadataAlreadyWritten: true,
      });

      await writer.append({
        type: 'user_message',
        turn_id: 'turn_1',
        content: 'hello',
      });
      // Phase 3: default fsyncMode is `batched`, so drain the pending
      // buffer before reading the file back.
      await writer.flush();

      const lines = (await readFile(filePath, 'utf-8')).trim().split('\n');
      // Both the seed metadata line AND the new record must be present.
      // If atomicWrite were mistakenly used, only the new record would
      // remain (the metadata line would be gone).
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines[0]).toContain('"metadata"');
      expect(lines[lines.length - 1]).toContain('"user_message"');
    } finally {
      await rm(workDir, { recursive: true });
    }
  });
});
