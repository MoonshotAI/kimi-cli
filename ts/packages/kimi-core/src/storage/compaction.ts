/**
 * Storage-layer compaction utilities — file rotation and cross-file replay
 * (§4.7 / §4.1.1).
 *
 * File rotation is the physical counterpart to Soul's `runCompaction`:
 *   1. Rename `wire.jsonl` → `wire.N.jsonl` (frozen archive)
 *   2. Create new `wire.jsonl` with metadata header + CompactionRecord
 *
 * Cross-file replay reads all wire files in a session directory
 * (wire.N.jsonl → ... → wire.1.jsonl → wire.jsonl) and produces a
 * unified record stream.
 *
 * Crash recovery detects "wire.jsonl missing but wire.N.jsonl exists"
 * and rolls back the lowest-numbered archive to `wire.jsonl`.
 */

import { readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { replayWire, type ReplayOptions, type ReplayResult } from './replay.js';

// ── Archive naming helpers ───────────────────────────────────────────

const ARCHIVE_PATTERN = /^wire\.(\d+)\.jsonl$/;

function extractArchiveNumber(name: string): number {
  const match = ARCHIVE_PATTERN.exec(name);
  const captured = match?.[1];
  return captured !== undefined ? Number.parseInt(captured, 10) : 0;
}

// ── Archive file naming ───────────────────────────────────────────────

/**
 * Given a session directory, list all wire files in age order
 * (oldest first → newest last). Convention: higher N = newer archive.
 *
 * Example: `['wire.1.jsonl', 'wire.2.jsonl', 'wire.3.jsonl', 'wire.jsonl']`
 *
 * §6 deviation: v2 spec says "编号越大越老" but Phase 1 uses "higher N =
 * newer" because `nextArchiveName` increments — simpler and internally
 * consistent. This is a private storage detail that does not affect users.
 */
export async function listWireFiles(sessionDir: string): Promise<string[]> {
  const entries = await readdir(sessionDir);
  const wireFiles: { path: string; n: number }[] = [];

  for (const entry of entries) {
    if (entry === 'wire.jsonl') {
      // Current file sorts last (use Infinity sentinel)
      wireFiles.push({ path: join(sessionDir, entry), n: Number.POSITIVE_INFINITY });
    } else if (ARCHIVE_PATTERN.test(entry)) {
      wireFiles.push({ path: join(sessionDir, entry), n: extractArchiveNumber(entry) });
    }
  }

  // Lowest N first (oldest), wire.jsonl last (current)
  wireFiles.sort((a, b) => a.n - b.n);

  return wireFiles.map((f) => f.path);
}

/**
 * Compute the next archive filename for a rotation:
 *   - No archives exist → `wire.1.jsonl`
 *   - Highest existing is `wire.3.jsonl` → `wire.4.jsonl`
 */
export function nextArchiveName(sessionDir: string, existingArchives: string[]): string {
  let maxN = 0;
  for (const archive of existingArchives) {
    const n = extractArchiveNumber(archive);
    if (n > maxN) maxN = n;
  }
  return join(sessionDir, `wire.${maxN + 1}.jsonl`);
}

// ── File rotation ─────────────────────────────────────────────────────

export interface RotateResult {
  /** Path of the frozen archive file (e.g. `wire.1.jsonl`). */
  readonly archivePath: string;
  /** Path of the new current wire.jsonl. */
  readonly newCurrentPath: string;
}

/**
 * Atomically rotate `wire.jsonl`:
 *   1. Rename current `wire.jsonl` → `wire.N.jsonl`
 *   2. Create new `wire.jsonl` with metadata header
 *
 * The caller (compaction path) writes the CompactionRecord into the new
 * file immediately after rotation completes.
 */
export async function rotateJournal(
  sessionDir: string,
  protocolVersion?: string,
): Promise<RotateResult> {
  const version = protocolVersion ?? '2.1';
  const currentPath = join(sessionDir, 'wire.jsonl');

  // Find existing archives to determine next number
  const entries = await readdir(sessionDir);
  const archiveNames = entries.filter((e) => ARCHIVE_PATTERN.test(e));
  const archivePath = nextArchiveName(sessionDir, archiveNames);

  // 1. Rename current → archive
  await rename(currentPath, archivePath);

  // 2. Create new wire.jsonl with metadata header
  const metadata = JSON.stringify({
    type: 'metadata',
    protocol_version: version,
    created_at: Date.now(),
  });
  await writeFile(currentPath, metadata + '\n', 'utf8');

  return { archivePath, newCurrentPath: currentPath };
}

// ── Cross-file replay (§4.1.1) ────────────────────────────────────────

/**
 * Replay all wire files in a session directory into a unified record
 * stream. Files are replayed oldest-first:
 *
 *   wire.N.jsonl → ... → wire.1.jsonl → wire.jsonl
 *
 * Records from older files precede records from newer files. Each file
 * is individually validated per `replayWire` (§4.1.1 error policy).
 */
export async function replayWireSession(
  sessionDir: string,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const files = await listWireFiles(sessionDir);

  if (files.length === 0) {
    return {
      records: [],
      protocolVersion: '2.1',
      health: 'ok',
      warnings: ['No wire files found in session directory'],
    };
  }

  const results: ReplayResult[] = [];
  for (const file of files) {
    results.push(await replayWire(file, options));
  }

  const records = results.flatMap((r) => [...r.records]);
  const warnings = results.flatMap((r) => [...r.warnings]);
  const health = results.some((r) => r.health === 'broken') ? 'broken' : 'ok';
  const lastResult = results.at(-1);
  const protocolVersion = lastResult?.protocolVersion ?? '2.1';

  const brokenReasons: string[] = [];
  for (const r of results) {
    if (r.brokenReason !== undefined) {
      brokenReasons.push(r.brokenReason);
    }
  }

  return {
    records,
    protocolVersion,
    health,
    ...(brokenReasons.length > 0 ? { brokenReason: brokenReasons.join('; ') } : {}),
    warnings,
  };
}

// ── Crash recovery (§4.7) ─────────────────────────────────────────────

/**
 * Detect and recover from a crash between file rotation steps.
 *
 * Scenario: `wire.jsonl` was renamed to `wire.N.jsonl` but the process
 * crashed before the new `wire.jsonl` was created. On resume, we detect
 * "wire.jsonl does not exist but wire.N.jsonl does" and roll back the
 * highest-numbered archive (most recently created) to `wire.jsonl`.
 *
 * Returns `true` if recovery was performed, `false` if no recovery was needed.
 */
export async function recoverRotation(sessionDir: string): Promise<boolean> {
  const entries = await readdir(sessionDir);

  // If wire.jsonl exists, no recovery needed
  if (entries.includes('wire.jsonl')) {
    return false;
  }

  // Find archives sorted by number ascending (lowest first)
  const archives = entries.filter((e) => ARCHIVE_PATTERN.test(e));

  // Find highest-numbered archive (most recently created per "higher N = newer")
  let highestN = 0;
  let toRollback: string | undefined;
  for (const name of archives) {
    const n = extractArchiveNumber(name);
    if (n > highestN) {
      highestN = n;
      toRollback = name;
    }
  }

  if (toRollback === undefined) {
    return false;
  }
  await rename(join(sessionDir, toRollback), join(sessionDir, 'wire.jsonl'));

  return true;
}
