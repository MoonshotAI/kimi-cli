import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { JournalGatedError } from './errors.js';
import { syncDir } from './fs-durability.js';
import { getProducerInfo } from './producer-info.js';
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
 * inside `TurnManager.executeCompaction` (Phase 2; previously
 * `runCompaction`) belong here. Any future compaction-path record
 * must be added explicitly.
 */
const COMPACTION_OWN_WRITE_TYPES: ReadonlySet<WireRecordType> = new Set<WireRecordType>([
  'compaction',
  // Phase 23 — the compaction orchestrator copies `session_initialized`
  // into the post-rotate wire (L2) via `appendBoundary`, which routes
  // through the writer while the lifecycle gate is in 'compacting'.
  'session_initialized',
]);

/**
 * Record types that must be durable on disk before `append()` resolves
 * (§4.5.4 — force-flush kinds). Recovery-critical boundary markers live
 * here: their absence at replay time breaks the contracts §9.x relies on.
 *
 * Declared as `ReadonlySet<string>` so we can include future union-member
 * strings (e.g. `subagent_completed` / `subagent_failed` from the
 * subagent slice) without forcing an out-of-slice edit to `WireRecord`.
 */
export const FORCE_FLUSH_KINDS: ReadonlySet<string> = new Set<string>([
  'approval_response',
  'turn_end',
  'subagent_completed',
  'subagent_failed',
  // Phase 23 — `session_initialized` is the SIGKILL-resistant baseline.
  // Without it the wire can't be resumed, so we block the first createSession
  // return on a real fsync (v2 §4.5.4 + phase-23 §Step 5.2).
  'session_initialized',
  // Phase 20 Codex review — `/clear` is an explicit user-intent operation
  // ("this context is gone now"). Without fsync, the 50ms batched-drain
  // window between `ContextState.clear()` return and the next force-flush
  // record can swallow the `context_cleared` entry on crash, so replay
  // resurrects the pre-clear history. Same durability contract as
  // `approval_response`: the moment we return success to the user, the
  // record must be on disk.
  'context_cleared',
]);

/** Default drain timer cadence for `fsyncMode: 'batched'`. */
export const DEFAULT_DRAIN_INTERVAL_MS = 50;
/** Default maximum records per drain batch. */
export const DEFAULT_MAX_BATCH_RECORDS = 64;
/** Default byte budget per drain batch. */
export const DEFAULT_MAX_BATCH_BYTES = 1_000_000;

/**
 * Tunables for `WiredJournalWriter` (§4.5.4).
 *
 * All fields are optional; unspecified values fall back to
 * `DEFAULT_*` constants exported alongside.
 */
export interface JournalWriterConfig {
  /** Drain interval in milliseconds. Default: 50. */
  readonly drainIntervalMs?: number;
  /** Maximum number of records flushed in one drain. Default: 64. */
  readonly maxBatchRecords?: number;
  /** Byte budget for a single drain batch. Default: 1_000_000. */
  readonly maxBatchBytes?: number;
  /**
   * Write path selection.
   * - `'batched'` (default): in-memory pending buffer drained on a
   *   timer; `FORCE_FLUSH_KINDS` trigger an immediate drain and only
   *   resolve after fsync.
   * - `'per-record'`: every append writes + fsyncs synchronously,
   *   preserving the pre-Phase-3 behaviour. Intended for SDK embedders.
   */
  readonly fsyncMode?: 'batched' | 'per-record';
  /**
   * Invoked once, with `(error, failedBatch)`, when a drain throws.
   * After this fires, the disk queue is frozen — subsequent appends
   * still land in `pendingRecords` but no further drain is scheduled.
   * Callers (SoulPlus) are expected to mark the session `broken` in
   * response.
   */
  readonly onPersistError?: (error: Error, records: WireRecord[]) => void;
}

/**
 * The sole physical write gateway to wire.jsonl.
 *
 * Guarantees (per §4.5.4):
 *   - serialises concurrent calls via an internal AsyncSerialQueue
 *   - allocates monotonic `seq`
 *   - for `fsyncMode: 'per-record'` or records in `FORCE_FLUSH_KINDS`,
 *     each resolved Promise implies fsync has completed
 *   - for non-force-flush records in `fsyncMode: 'batched'`, the
 *     Promise resolves once the record is in the in-memory pending
 *     buffer; the drain timer catches up asynchronously
 *   - rejects with JournalGatedError when LifecycleGate.state === 'compacting'
 *     for any record type that is not part of the compaction path's own
 *     writes (see `COMPACTION_OWN_WRITE_TYPES`)
 *   - rejects with JournalGatedError for all record types when
 *     LifecycleGate.state === 'completing'
 *   - rejects when called after `close()`
 */
export interface JournalWriter {
  append(input: AppendInput): Promise<WireRecord>;
  /** Drain every record currently buffered in memory to disk + fsync. */
  flush(): Promise<void>;
  /** Stop background drain + flush pending + refuse further appends. */
  close(): Promise<void>;
  /** Read-only view of records queued but not yet drained to disk. */
  readonly pendingRecords: ReadonlyArray<WireRecord>;
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
  /** Phase 3 (Slice 3) — double-buffered async drain tunables. */
  readonly config?: JournalWriterConfig | undefined;
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
   * successful write, and never again for the lifetime of this writer.
   */
  private directorySynced = false;

  // ── Phase 3 double-buffered state ──────────────────────────────────
  private readonly fsyncMode: 'batched' | 'per-record';
  private readonly drainIntervalMs: number;
  private readonly maxBatchRecords: number;
  private readonly maxBatchBytes: number;
  private readonly onPersistError:
    | ((error: Error, records: WireRecord[]) => void)
    | undefined;
  private readonly pending: WireRecord[] = [];
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /**
   * Disk queue frozen after a drain failure. `pendingRecords` can still
   * accept new pushes (per contract), but no further drains are scheduled
   * — SoulPlus is expected to mark the session `broken` through
   * `onPersistError` and stop new writes.
   */
  private degraded = false;

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
    const config = opts.config ?? {};
    this.fsyncMode = config.fsyncMode ?? 'batched';
    this.drainIntervalMs = config.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
    this.maxBatchRecords = config.maxBatchRecords ?? DEFAULT_MAX_BATCH_RECORDS;
    this.maxBatchBytes = config.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.onPersistError = config.onPersistError;
  }

  /** Phase 3 — read-only view of records buffered in memory. */
  get pendingRecords(): ReadonlyArray<WireRecord> {
    return this.pending;
  }

  /**
   * Reset writer state after a compaction rotation (Slice 3.3 / M04).
   *
   * After `rotateJournal` renames the old `wire.jsonl` → `wire.N.jsonl`
   * and creates a fresh `wire.jsonl` with a metadata header, the writer
   * must restart its monotonic seq from 0 (so the first record in the
   * new file gets seq=1). The metadata header is already on disk, so we
   * mark it as written. The new file's directory entry was durably
   * committed by `rotateJournal`'s `syncDir`, so `directorySynced` is
   * also set.
   *
   * Only the compaction path (via `WiredJournalCapability`) should call
   * this method — normal appends must never touch the seq counter.
   */
  resetForRotation(): void {
    this.seq = 0;
    this.metadataWritten = true;
    this.directorySynced = true;
  }

  async append(input: AppendInput): Promise<WireRecord> {
    if (this.closed) {
      throw new Error('JournalWriter: append on closed writer');
    }
    if (this.fsyncMode === 'per-record') {
      return this.appendPerRecord(input);
    }
    return this.appendBatched(input);
  }

  private appendPerRecord(input: AppendInput): Promise<WireRecord> {
    return this.queue.run(async () => {
      if (this.closed) throw new Error('JournalWriter: append on closed writer');
      this.checkGating(input);
      await this.ensureMetadataInit();

      // Allocate the candidate seq locally; only commit it back to
      // `this.seq` once the durable write succeeds.
      const candidateSeq = this.seq + 1;
      const record = {
        ...input,
        seq: candidateSeq,
        time: this.now(),
      } as WireRecord;

      await this.writeAndSync(JSON.stringify(record) + '\n');
      this.seq = candidateSeq;

      if (!this.directorySynced) {
        await this.syncParentDir();
        this.directorySynced = true;
      }
      return record;
    });
  }

  private async appendBatched(input: AppendInput): Promise<WireRecord> {
    const record = await this.queue.run(async () => {
      if (this.closed) throw new Error('JournalWriter: append on closed writer');
      this.checkGating(input);
      await this.ensureMetadataInit();

      const candidateSeq = this.seq + 1;
      const rec = {
        ...input,
        seq: candidateSeq,
        time: this.now(),
      } as WireRecord;
      // Allocate seq + push to pending in a single synchronous step so
      // concurrent appends see strictly monotonic FIFO seq assignment.
      this.seq = candidateSeq;
      this.pending.push(rec);
      this.ensureDrainTimer();
      return rec;
    });

    if (FORCE_FLUSH_KINDS.has(record.type)) {
      // Drain until this record (and everything ahead of it in FIFO) is
      // on disk. `flush()` hops through the queue so it can't race with
      // concurrent appends that slid in after the push above.
      await this.flush();
    }
    return record;
  }

  async flush(): Promise<void> {
    await this.queue.run(async () => {
      while (this.pending.length > 0 && !this.degraded) {
        await this.drainBatch();
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.stopDrainTimer();
    try {
      await this.flush();
    } finally {
      this.closed = true;
    }
  }

  private checkGating(input: AppendInput): void {
    if (this.lifecycle.state === 'completing') {
      throw new JournalGatedError(this.lifecycle.state, input.type);
    }
    if (
      this.lifecycle.state === 'compacting' &&
      !COMPACTION_OWN_WRITE_TYPES.has(input.type)
    ) {
      throw new JournalGatedError(this.lifecycle.state, input.type);
    }
  }

  private async ensureMetadataInit(): Promise<void> {
    if (this.metadataWritten) return;
    await this.ensureDir();
    const producer = getProducerInfo();
    const header: WireFileMetadata = {
      type: 'metadata',
      protocol_version: this.protocolVersion,
      created_at: this.now(),
      producer,
      // kimi_version is a deprecated compat field. If the host passes one
      // explicitly it wins (an embedder may want to stamp its own SDK
      // version); otherwise mirror producer.version so older readers still
      // see something meaningful.
      kimi_version: this.kimiVersion ?? producer.version,
    };
    await this.writeAndSync(JSON.stringify(header) + '\n');
    this.metadataWritten = true;
  }

  private ensureDrainTimer(): void {
    if (this.fsyncMode !== 'batched') return;
    if (this.drainTimer !== null) return;
    if (this.closed || this.degraded) return;
    // Async callback is load-bearing: sinon's `tickAsync` awaits the
    // callback's returned promise before firing the next timer, so we
    // need to expose the drain's completion as the callback's return
    // value (otherwise fake-timer tests race real fs I/O and see only
    // the first drain land on disk).
    const timer = setInterval(() => {
      if (this.closed || this.degraded) return;
      if (this.pending.length === 0) return;
      // Serialise the drain against concurrent appends via the queue.
      // drainBatch is pseudo-async (one microtask yield for a real sync
      // fs path, or an awaited test mock); one yield per tick stays
      // inside fake-timer budget.
      void this.queue
        .run(async () => {
          await this.drainBatch();
        })
        .catch(() => {
          // Surfaced via onPersistError + degraded flag inside drainBatch.
        });
    }, this.drainIntervalMs);
    // Don't pin the Node event loop just because a writer is idle.
    const refable = timer as unknown as { unref?: () => void };
    refable.unref?.();
    this.drainTimer = timer;
  }

  private stopDrainTimer(): void {
    if (this.drainTimer !== null) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /**
   * Drain one batch of buffered records to disk (respecting the
   * record-count and byte budgets). Each invocation translates into
   * exactly one `writeBatchAndSync` / fsync call — callers (the drain
   * timer, `flush`) are expected to loop when more records remain.
   * On failure the batch is handed to `onPersistError` and the queue
   * freezes; no further drains will be scheduled.
   */
  private async drainBatch(): Promise<void> {
    if (this.degraded || this.pending.length === 0) return;

    const batch: WireRecord[] = [];
    const lines: string[] = [];
    let totalBytes = 0;
    while (batch.length < this.maxBatchRecords && this.pending.length > 0) {
      const next = this.pending[0]!;
      const line = JSON.stringify(next) + '\n';
      const lineBytes = Buffer.byteLength(line, 'utf8');
      // `batch.length > 0` 这个前置保证了首条 record 一定被纳入 batch：
      // 如果单条序列化大小就超过 maxBatchBytes，也不能永久卡在 pending 里。
      // 该 record 会独占一次 drain（batch = 1 条，可能超 bytes budget）。
      if (batch.length > 0 && totalBytes + lineBytes > this.maxBatchBytes) {
        break;
      }
      this.pending.shift();
      batch.push(next);
      lines.push(line);
      totalBytes += lineBytes;
    }
    if (batch.length === 0) return;

    try {
      await this.writeBatchAndSync(lines);
      if (!this.directorySynced) {
        await this.syncParentDir();
        this.directorySynced = true;
      }
    } catch (error) {
      // Per team-lead 2026-04-17: splice already moved `batch` out of
      // `this.pending`; we DO NOT re-queue it. The failed batch lives
      // in the onPersistError callback; the disk queue freezes.
      //
      // Order (see L17 铁律): degraded → stopDrainTimer → onPersistError.
      this.degraded = true;
      this.stopDrainTimer();
      try {
        this.onPersistError?.(error as Error, batch);
      } catch {
        // Never let a user handler poison the drain path.
      }
      throw error;
    }
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
   * Phase 3 batched drain path — Phase 15 B.1 rewrite: append the joined
   * lines in a single `appendFile` + `sync()` call using the promise-
   * based fs API. The drain stays inside the AsyncSerialQueue, so
   * concurrent appends still see FIFO ordering and the force-flush
   * contract (L17): when `append(force)` awaits `flush`, every
   * previously-queued record is both on disk and fsynced before
   * resolution.
   *
   * Fake-timer tests now use `advanceTimersByTimeAsync` so the promise
   * microtask queue drains between ticks.
   */
  private async writeBatchAndSync(lines: string[]): Promise<void> {
    const fh = await open(this.filePath, 'a');
    try {
      await fh.appendFile(lines.join(''), 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /** Async parent-directory fsync. Tests may spy on this method by name. */
  private async syncParentDir(): Promise<void> {
    await syncDir(dirname(this.filePath));
  }
}

/** No-op writer used by InMemory state implementations. */
export class NoopJournalWriter implements JournalWriter {
  private seq = 0;
  private closed = false;
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  /** Always empty — NoopJournalWriter never buffers. */
  readonly pendingRecords: ReadonlyArray<WireRecord> = Object.freeze([]);

  async append(input: AppendInput): Promise<WireRecord> {
    // Match WiredJournalWriter: `append` after `close` rejects rather
    // than silently succeeding. Embedders / test scenarios are the only
    // users of Noop; a silent post-close append could hide real bugs.
    if (this.closed) {
      throw new Error('NoopJournalWriter: append on closed writer');
    }
    this.seq += 1;
    return {
      ...input,
      seq: this.seq,
      time: this.now(),
    } as WireRecord;
  }

  async flush(): Promise<void> {
    /* no pending state to drain */
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
