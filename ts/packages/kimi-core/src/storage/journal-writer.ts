import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { JournalGatedError } from './errors.js';
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
 * The sole physical write gateway to wire.jsonl.
 *
 * Guarantees (per §4.5.4):
 *   - serialises concurrent calls via an internal AsyncSerialQueue
 *   - allocates monotonic `seq`
 *   - each resolved Promise implies fsync has completed
 *   - rejects with JournalGatedError when LifecycleGate.state === 'compacting'
 *     (and the caller is not the compaction path itself)
 */
export interface JournalWriter {
  append(input: AppendInput): Promise<WireRecord>;
}

export interface WiredJournalWriterOptions {
  readonly filePath: string;
  readonly lifecycle: LifecycleGate;
  readonly protocolVersion?: string;
  readonly kimiVersion?: string;
  /** Override clock for tests. Returns Unix milliseconds. */
  readonly now?: () => number;
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

  constructor(opts: WiredJournalWriterOptions) {
    this.filePath = opts.filePath;
    this.lifecycle = opts.lifecycle;
    this.protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.kimiVersion = opts.kimiVersion;
    this.now = opts.now ?? (() => Date.now());
  }

  append(input: AppendInput): Promise<WireRecord> {
    return this.queue.run(async () => {
      if (this.lifecycle.state === 'compacting' || this.lifecycle.state === 'completing') {
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
