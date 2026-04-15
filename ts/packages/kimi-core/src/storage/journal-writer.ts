import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { JournalGatedError } from './errors.js';
import { syncDir } from './fs-durability.js';
import type { WireFileMetadata, WireRecord, WireRecordType } from './wire-record.js';

/**
 * Lifecycle states observed by `JournalWriter`. The two non-`active` values
 * gate writes (see §5.8.2 / appendix D.7); SessionLifecycleStateMachine
 * (Slice 3) is the authoritative state owner — JournalWriter is purely a
 * "gated party".
 */
export type LifecycleState = 'active' | 'compacting' | 'completing';

/** Narrow read-side interface exposed to JournalWriter so it can gate writes. */
export interface LifecycleGate {
  readonly state: LifecycleState;
}

/**
 * Subset of a WireRecord that callers hand to `append` — `seq` and `time`
 * are allocated by the writer, not the caller.
 */
export type AppendInput = {
  [T in WireRecordType]: Omit<Extract<WireRecord, { type: T }>, 'seq' | 'time'>;
}[WireRecordType];

/**
 * Record types the compaction path itself is allowed to write while the
 * lifecycle gate is in `compacting` state (§5.1.7 / v2 L2663-L2690).
 *
 * Background (Slice 6 audit M02): every non-compaction write is drained
 * during `compacting` so the in-flight compaction is not racing against
 * new Soul output. But compaction still needs to persist its own
 * `CompactionRecord` via `context.resetToSummary()`, which goes through
 * the same `JournalWriter.append()` entry point. Blanket-rejecting all
 * writes in `compacting` would deadlock compaction against itself, so
 * this whitelist names the record types that are considered
 * "compaction's own writes" and allowed through the gate.
 *
 * Keep this list narrow: only record types that are *only* emitted from
 * inside `runCompaction` belong here. Any future compaction-path record
 * must be added explicitly.
 */
const COMPACTION_OWN_WRITE_TYPES: ReadonlySet<WireRecordType> = new Set<WireRecordType>([
  'compaction',
]);

/**
 * The sole physical write gateway to wire.jsonl.
 *
 * Guarantees (per §4.5.4):
 *   - serialises concurrent calls via an internal AsyncSerialQueue
 *   - allocates monotonic `seq`
 *   - each resolved Promise implies fsync has completed
 *   - rejects with JournalGatedError when LifecycleGate.state === 'compacting'
 *     for any record type that is not part of the compaction path's own
 *     writes (see `COMPACTION_OWN_WRITE_TYPES`)
 *   - rejects with JournalGatedError for all record types when
 *     LifecycleGate.state === 'completing'
 */
export interface JournalWriter {
  append(input: AppendInput): Promise<WireRecord>;
}

export interface WiredJournalWriterOptions {
  readonly filePath: string;
  readonly lifecycle: LifecycleGate;
  readonly protocolVersion?: string | undefined;
  readonly kimiVersion?: string | undefined;
  /** Override clock for tests. Returns Unix milliseconds. */
  readonly now?: (() => number) | undefined;
  /**
   * Resume state: highest `seq` already persisted to `wire.jsonl`.
   *
   * When a session is resumed, the caller (typically SessionManager) replays
   * the existing `wire.jsonl`, extracts `lastSeq` from the final record, and
   * passes it here so the new writer instance continues the monotonic
   * sequence instead of restarting from `1`.
   *
   * Must be paired with `metadataAlreadyWritten: true` to avoid appending a
   * duplicate metadata header to the existing file.
   */
  readonly initialSeq?: number | undefined;
  /**
   * Resume state: tells the writer that the on-disk `wire.jsonl` already
   * contains a valid metadata header, so the first `append()` must NOT
   * re-write one. Set this together with `initialSeq` on resume.
   */
  readonly metadataAlreadyWritten?: boolean | undefined;
}

const DEFAULT_PROTOCOL_VERSION = '2.1';

/**
 * Chains work onto a single promise so all callers are serialised in the
 * order `run` was invoked, regardless of when each task resolves.
 */
class AsyncSerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {
      /* swallow so a rejected task doesn't poison the chain */
    });
    return next;
  }
}

/** Real fs-backed JournalWriter. */
export class WiredJournalWriter implements JournalWriter {
  private readonly filePath: string;
  private readonly lifecycle: LifecycleGate;
  private readonly protocolVersion: string;
  private readonly kimiVersion: string | undefined;
  private readonly now: () => number;
  private readonly queue = new AsyncSerialQueue();
  private seq = 0;
  private metadataWritten = false;
  /**
   * Tracks whether the parent directory entry for `filePath` has been
   * fsynced. Under POSIX semantics, `fh.sync()` flushes file *contents* but
   * does not guarantee the directory entry for a freshly created file has
   * been durably committed — a crash between the first append and the next
   * parent-directory fsync can leave the file's contents on disk with no
   * visible dirent. We fsync the parent directory once, after the first
   * successful append, and never again for the lifetime of this writer.
   */
  private directorySynced = false;

  constructor(opts: WiredJournalWriterOptions) {
    this.filePath = opts.filePath;
    this.lifecycle = opts.lifecycle;
    this.protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.kimiVersion = opts.kimiVersion;
    this.now = opts.now ?? (() => Date.now());
    if (opts.initialSeq !== undefined) {
      if (!Number.isInteger(opts.initialSeq) || opts.initialSeq < 0) {
        throw new RangeError(
          `WiredJournalWriter.initialSeq must be a non-negative integer, got ${String(opts.initialSeq)}`,
        );
      }
      this.seq = opts.initialSeq;
    }
    if (opts.metadataAlreadyWritten === true) {
      this.metadataWritten = true;
      // If the caller is resuming from an existing file, its directory entry
      // is already durable from whichever process originally created it.
      this.directorySynced = true;
    }
  }

  append(input: AppendInput): Promise<WireRecord> {
    return this.queue.run(async () => {
      if (this.lifecycle.state === 'completing') {
        throw new JournalGatedError(this.lifecycle.state, input.type);
      }
      if (this.lifecycle.state === 'compacting' && !COMPACTION_OWN_WRITE_TYPES.has(input.type)) {
        throw new JournalGatedError(this.lifecycle.state, input.type);
      }

      if (!this.metadataWritten) {
        await this.ensureDir();
        const header: WireFileMetadata = {
          type: 'metadata',
          protocol_version: this.protocolVersion,
          created_at: this.now(),
          ...(this.kimiVersion !== undefined ? { kimi_version: this.kimiVersion } : {}),
        };
        await this.writeAndSync(JSON.stringify(header) + '\n');
        this.metadataWritten = true;
      }

      // Allocate the candidate seq locally; only commit it back to
      // `this.seq` once the durable write succeeds. If writeAndSync throws,
      // the next append starts from the last successfully-written seq.
      const candidateSeq = this.seq + 1;
      const record = {
        ...input,
        seq: candidateSeq,
        time: this.now(),
      } as WireRecord;

      await this.writeAndSync(JSON.stringify(record) + '\n');
      this.seq = candidateSeq;

      // Durability fix (Phase 2 Slice 2.0 / Slice 1 audit M4): fsync the
      // parent directory exactly once, right after the first successful
      // write, so a freshly-created wire.jsonl's dirent is guaranteed to be
      // durable before this `append()` promise resolves. `fh.sync()` only
      // covers file *contents*, not the directory entry pointing at them.
      if (!this.directorySynced) {
        await this.syncParentDir();
        this.directorySynced = true;
      }

      return record;
    });
  }

  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  private async writeAndSync(line: string): Promise<void> {
    const fh = await open(this.filePath, 'a');
    try {
      await fh.appendFile(line, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /**
   * Open the parent directory read-only and fsync it, then close.
   * Thin wrapper around the shared `syncDir` primitive so tests can
   * continue to spy on this method by name.
   */
  private async syncParentDir(): Promise<void> {
    await syncDir(dirname(this.filePath));
  }
}

/** No-op writer used by InMemory state implementations. */
export class NoopJournalWriter implements JournalWriter {
  private seq = 0;
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  async append(input: AppendInput): Promise<WireRecord> {
    this.seq += 1;
    return {
      ...input,
      seq: this.seq,
      time: this.now(),
    } as WireRecord;
  }
}
