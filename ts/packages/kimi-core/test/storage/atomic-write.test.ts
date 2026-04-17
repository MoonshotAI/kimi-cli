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

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
