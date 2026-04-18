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

import { rotateJournal } from '../storage/compaction.js';
import type { WiredJournalWriter } from '../storage/journal-writer.js';
import type { SummaryMessage } from './compaction-provider.js';

// ── Journal types (moved here from src/soul/runtime.ts — Phase 20 §C.1 / R-3) ──

/**
 * Slice 2 placeholder for the CompactionBoundaryRecord shape. The real
 * WireRecord union lives in `src/storage/wire-record.ts`; we re-declare a
 * tiny structural shape here so Soul does not import the wire-record
 * implementation module (import whitelist, §5.0 rule 3). Slice 6
 * Compaction may swap this for a precise structural alias.
 */
export interface CompactionBoundaryRecord {
  type: 'compaction_boundary';
  summary: SummaryMessage;
  parent_file: string;
}

export interface RotateResult {
  /** Basename of the archive file created by rotation (e.g. `wire.1.jsonl`). */
  archiveFile: string;
}

export interface JournalCapability {
  rotate(boundaryRecord: CompactionBoundaryRecord): Promise<RotateResult>;
}

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
