/**
 * WiredJournalCapability — real JournalCapability backed by physical
 * wire.jsonl rotation (Slice 3.3 / M05).
 *
 * Replaces `createStubJournalCapability()` from Slice 3 for production
 * use. Wraps `rotateJournal()` from `src/storage/compaction.ts` and
 * coordinates with `WiredJournalWriter.resetForRotation()` so the
 * journal's monotonic seq counter restarts at 0 in the new file.
 */

import { basename } from 'node:path';

import type { CompactionBoundaryRecord, JournalCapability, RotateResult } from '../soul/index.js';
import { rotateJournal } from '../storage/compaction.js';
import type { WiredJournalWriter } from '../storage/journal-writer.js';

export interface WiredJournalCapabilityDeps {
  /** Absolute path to the session directory containing wire.jsonl. */
  readonly sessionDir: string;
  /**
   * The JournalWriter that is actively writing to `wire.jsonl`. After
   * rotation, its seq counter is reset so the compaction record written
   * via `resetToSummary` gets seq=1 in the new file.
   */
  readonly journalWriter: WiredJournalWriter;
}

export class WiredJournalCapability implements JournalCapability {
  private readonly sessionDir: string;
  private readonly journalWriter: WiredJournalWriter;

  constructor(deps: WiredJournalCapabilityDeps) {
    this.sessionDir = deps.sessionDir;
    this.journalWriter = deps.journalWriter;
  }

  async rotate(_boundaryRecord: CompactionBoundaryRecord): Promise<RotateResult> {
    const result = await rotateJournal(this.sessionDir);

    // Reset the writer so the compaction record written by
    // `resetToSummary` gets seq=1 in the new wire.jsonl. The new file
    // already has a metadata header (written by rotateJournal), so
    // `resetForRotation` marks metadata as written to avoid a duplicate.
    this.journalWriter.resetForRotation();

    return { archiveFile: basename(result.archivePath) };
  }
}

export function createWiredJournalCapability(
  deps: WiredJournalCapabilityDeps,
): WiredJournalCapability {
  return new WiredJournalCapability(deps);
}
