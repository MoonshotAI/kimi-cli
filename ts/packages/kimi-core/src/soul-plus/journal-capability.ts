/**
 * WiredJournalCapability — real JournalCapability backed by physical
 * wire.jsonl rotation (Slice 3.3 / M05).
 *
 * Replaces `createStubJournalCapability()` from Slice 3 for production
 * use. Wraps `rotateJournal()` from `src/storage/compaction.ts` and
 * coordinates with `WiredJournalWriter.resetForRotation()` so the
 * journal's monotonic seq counter restarts at 0 in the new file.
 */

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { rotateJournal } from '../storage/compaction.js';
import type { WiredJournalWriter } from '../storage/journal-writer.js';
import {
  SessionInitializedRecordSchema,
  type SessionInitializedRecord,
} from '../storage/wire-record.js';
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
  /**
   * Phase 23 — read the `session_initialized` record (wire line 2) from
   * the CURRENT wire.jsonl, before rotate() renames it. Used by the
   * compaction orchestrator to copy the baseline into the post-rotate
   * wire so resume can still reconstruct ContextState from the truth
   * source (v2 §4.1.2 + C6).
   */
  readSessionInitialized(): Promise<SessionInitializedRecord>;
  /**
   * Phase 23 — append the copied `session_initialized` record as line 2
   * of the post-rotate wire.jsonl. Must be called AFTER rotate() and
   * BEFORE the compaction record write so the final layout is:
   *   L1 metadata → L2 session_initialized (copied) → L3 compaction.
   */
  appendBoundary(sessionInitialized: SessionInitializedRecord): Promise<void>;
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

  async readSessionInitialized(): Promise<SessionInitializedRecord> {
    const wirePath = join(this.sessionDir, 'wire.jsonl');
    const raw = await readFile(wirePath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length < 2) {
      throw new Error(
        `readSessionInitialized: wire.jsonl at ${wirePath} has fewer than 2 lines`,
      );
    }
    const parsed = JSON.parse(lines[1]!) as unknown;
    const result = SessionInitializedRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `readSessionInitialized: wire.jsonl line 2 at ${wirePath} is not a valid session_initialized record: ${result.error.message}`,
      );
    }
    return result.data;
  }

  async appendBoundary(sessionInitialized: SessionInitializedRecord): Promise<void> {
    // Strip seq/time — the writer re-stamps them so the copied record
    // lands at seq=1 in the fresh wire.jsonl (line 2, right after the
    // metadata header written by rotateJournal).
    const { seq: _seq, time: _time, ...input } = sessionInitialized;
    void _seq;
    void _time;
    await this.journalWriter.append(input);
  }
}

export function createWiredJournalCapability(
  deps: WiredJournalCapabilityDeps,
): WiredJournalCapability {
  return new WiredJournalCapability(deps);
}
