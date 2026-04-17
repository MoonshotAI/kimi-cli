// Phase 3 (Slice 3) — WiredJournalWriter async-batch contract tests.
//
// These tests pin the NEW contract described in v2 §4.5.3–4.5.4:
//   - Default `fsyncMode: 'batched'` buffers records in memory and drains
//     asynchronously on a 50 ms timer (configurable).
//   - `FORCE_FLUSH_KINDS` — approval_response, turn_end, subagent_completed,
//     subagent_failed — trigger an immediate `flush()` and only resolve
//     after the disk fsync completes.
//   - `pendingRecords` is a readonly view over records that have been
//     pushed to memory but not yet drained to disk.
//   - `flush()` drains everything currently pending to disk + fsync.
//   - `close()` stops the drain timer and flushes any pending records.
//   - `fsyncMode: 'per-record'` preserves the pre-Phase-3 "every append
//     fsyncs" behaviour (SDK embedder mode).
//   - `onPersistError` is called with `(error, failedRecords)` when a
//     batch drain throws; pendingRecords is NOT rolled back.
//   - Batch slicing is governed by `maxBatchRecords` and `maxBatchBytes`.
//   - Lifecycle gating (`compacting` / `completing`) is unchanged.
//
// All tests run against real disk under `mkdtemp(tmpdir())` and use
// `vi.useFakeTimers()` to control drain timing deterministically.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JournalGatedError } from '../../src/storage/errors.js';
import {
  FORCE_FLUSH_KINDS,
  type LifecycleGate,
  type LifecycleState,
  WiredJournalWriter,
} from '../../src/storage/journal-writer.js';

class StubGate implements LifecycleGate {
  state: LifecycleState = 'active';
}

type AnyJsonRecord = Record<string, unknown> & { type: string };

async function readAllLines(path: string): Promise<AnyJsonRecord[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AnyJsonRecord);
}

async function readBodyRecords(path: string): Promise<AnyJsonRecord[]> {
  const all = await readAllLines(path);
  return all.filter((r) => r.type !== 'metadata');
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-journal-async-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 1. Batched drain behaviour ────────────────────────────────────────

describe('WiredJournalWriter async-batch — batched drain behaviour', () => {
  it('10 non-force-flush records stay in memory until the drain timer fires', async () => {
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50 },
    });

    for (let i = 0; i < 10; i++) {
      // await resolves at microtask level — non-force-flush records do NOT
      // block on fsync, so this loop finishes before any drain tick.
      await writer.append({ type: 'user_message', turn_id: 't1', content: `m-${i}` });
    }

    // Contract: before the drain timer, the body of wire.jsonl is empty.
    // (The metadata header is allowed to hit disk synchronously on the
    // first append — that's a one-shot bootstrap concern, not a batched
    // write, so we filter it out.)
    expect(await readBodyRecords(filePath)).toEqual([]);
    expect(writer.pendingRecords.length).toBe(10);

    // Advance past the drain interval — drain fires, flushes the batch.
    await vi.advanceTimersByTimeAsync(50);

    const body = await readBodyRecords(filePath);
    expect(body.length).toBe(10);
    expect(body.map((r) => r['content'])).toEqual([
      'm-0',
      'm-1',
      'm-2',
      'm-3',
      'm-4',
      'm-5',
      'm-6',
      'm-7',
      'm-8',
      'm-9',
    ]);
    expect(writer.pendingRecords.length).toBe(0);
  });

  it('a full batch translates into a single writeBatchAndSync / fsync call', async () => {
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50 },
    });
    const writeSpy = vi.spyOn(
      writer as unknown as { writeBatchAndSync(lines: string[]): Promise<void> },
      'writeBatchAndSync',
    );

    for (let i = 0; i < 10; i++) {
      await writer.append({ type: 'user_message', turn_id: 't1', content: `m-${i}` });
    }
    await vi.advanceTimersByTimeAsync(50);

    // A single drain tick must batch all 10 records into one disk write.
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});

// ── 2. FORCE_FLUSH_KINDS ──────────────────────────────────────────────

describe('WiredJournalWriter async-batch — FORCE_FLUSH_KINDS', () => {
  it('pins exactly the four boundary record types (regression guard)', () => {
    // §9.x recovery matrix relies on these four "boundary evidence" record
    // types being durable at `append` resolve time. Pinning the set here
    // prevents a future drive-by edit from silently reclassifying one of
    // them into the async-batch path.
    const actual = [...FORCE_FLUSH_KINDS].sort();
    expect(actual).toEqual(
      ['approval_response', 'subagent_completed', 'subagent_failed', 'turn_end'].sort(),
    );
    expect(FORCE_FLUSH_KINDS.size).toBe(4);
  });

  it('turn_end is durable on disk before the drain timer fires', async () => {
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50 },
    });

    await writer.append({
      type: 'turn_end',
      turn_id: 't1',
      agent_type: 'main',
      success: true,
      reason: 'done',
    });

    // No timer advance — force-flush kinds must have hit disk inside append().
    const body = await readBodyRecords(filePath);
    expect(body.length).toBe(1);
    expect(body[0]?.['type']).toBe('turn_end');
    expect(writer.pendingRecords.length).toBe(0);
  });

  it('approval_response is durable on disk before the drain timer fires', async () => {
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50 },
    });

    await writer.append({
      type: 'approval_response',
      turn_id: 't1',
      step: 0,
      data: {
        request_id: 'r-1',
        response: 'approved',
      },
    });

    const body = await readBodyRecords(filePath);
    expect(body.length).toBe(1);
    expect(body[0]?.['type']).toBe('approval_response');
    expect(writer.pendingRecords.length).toBe(0);
  });

  it('mixing force-flush and non-force-flush: only the force-flush hits disk immediately', async () => {
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50 },
    });

    await writer.append({ type: 'user_message', turn_id: 't1', content: 'before' });
    // At this point: pending=[user_message], disk body=[]
    expect(await readBodyRecords(filePath)).toEqual([]);
    expect(writer.pendingRecords.length).toBe(1);

    // turn_end force-flushes the whole batch including the queued user_message,
    // because flush() drains the buffer in FIFO order.
    await writer.append({
      type: 'turn_end',
      turn_id: 't1',
      agent_type: 'main',
      success: true,
      reason: 'done',
    });
    const body = await readBodyRecords(filePath);
    expect(body.length).toBe(2);
    expect(body[0]?.['type']).toBe('user_message');
    expect(body[1]?.['type']).toBe('turn_end');
    expect(writer.pendingRecords.length).toBe(0);
  });
});

// ── 3. pendingRecords view ────────────────────────────────────────────

describe('WiredJournalWriter async-batch — pendingRecords view', () => {
  it('exposes a readonly view of not-yet-drained records in FIFO order', async () => {
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50 },
    });
    for (let i = 0; i < 5; i++) {
      await writer.append({ type: 'user_message', turn_id: 't1', content: `p-${i}` });
    }
    expect(writer.pendingRecords.length).toBe(5);
    expect(
      writer.pendingRecords.map((r) => (r as unknown as { content: string }).content),
    ).toEqual(['p-0', 'p-1', 'p-2', 'p-3', 'p-4']);
    // seq must be monotonically assigned at push time.
    expect(writer.pendingRecords.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);

    await vi.advanceTimersByTimeAsync(50);
    expect(writer.pendingRecords.length).toBe(0);
  });
});

// ── 4. flush() ────────────────────────────────────────────────────────

describe('WiredJournalWriter async-batch — flush()', () => {
  it('drains all pending records synchronously on demand', async () => {
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50 },
    });
    for (let i = 0; i < 5; i++) {
      await writer.append({ type: 'user_message', turn_id: 't1', content: `f-${i}` });
    }
    expect(await readBodyRecords(filePath)).toEqual([]);

    await writer.flush();

    const body = await readBodyRecords(filePath);
    expect(body.length).toBe(5);
    expect(body.map((r) => r['content'])).toEqual(['f-0', 'f-1', 'f-2', 'f-3', 'f-4']);
    expect(writer.pendingRecords.length).toBe(0);
  });

  it('flush() on an empty queue is a no-op and resolves', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50 },
    });
    await expect(writer.flush()).resolves.toBeUndefined();
  });
});

// ── 5. close() ────────────────────────────────────────────────────────

describe('WiredJournalWriter async-batch — close()', () => {
  it('flushes pending records and stops the drain timer', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50 },
    });
    for (let i = 0; i < 3; i++) {
      await writer.append({ type: 'user_message', turn_id: 't1', content: `c-${i}` });
    }

    await writer.close();

    // close() drains pending to disk.
    const body = await readBodyRecords(filePath);
    expect(body.length).toBe(3);
    expect(writer.pendingRecords.length).toBe(0);

    // close() clears the drain timer.
    expect(clearSpy).toHaveBeenCalled();

    // Timer is dead — even advancing past the interval produces no more writes.
    const writeSpy = vi.spyOn(
      writer as unknown as { writeBatchAndSync(lines: string[]): Promise<void> },
      'writeBatchAndSync',
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('rejects append() after close() (chosen contract: reject, not silent drop)', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50 },
    });
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'pre-close' });
    await writer.close();

    // Contract pinned: append after close MUST reject. Silent drops are
    // not acceptable because callers expect `await append()` to mean
    // "record is now in memory and will eventually hit disk"; swallowing
    // the append after close breaks that invariant and hides bugs.
    await expect(
      writer.append({ type: 'user_message', turn_id: 't1', content: 'post-close' }),
    ).rejects.toThrow();
  });
});

// ── 6. per-record (fsyncMode: per-record) backwards compatibility ─────

describe('WiredJournalWriter async-batch — per-record mode backwards compat', () => {
  it('fsyncs each append synchronously — no drain timer required', async () => {
    // No fake timers on purpose — per-record mode must NOT depend on the
    // drain timer in any way.
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { fsyncMode: 'per-record' },
    });
    await writer.append({ type: 'user_message', turn_id: 't1', content: '1' });
    expect((await readBodyRecords(filePath)).length).toBe(1);
    await writer.append({ type: 'user_message', turn_id: 't1', content: '2' });
    expect((await readBodyRecords(filePath)).length).toBe(2);
    await writer.append({ type: 'user_message', turn_id: 't1', content: '3' });
    expect((await readBodyRecords(filePath)).length).toBe(3);
  });

  it('keeps pendingRecords empty in per-record mode (it bypasses the buffer)', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { fsyncMode: 'per-record' },
    });
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'x' });
    expect(writer.pendingRecords.length).toBe(0);
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'y' });
    expect(writer.pendingRecords.length).toBe(0);
  });

  it('still fsyncs the parent directory exactly once in per-record mode', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { fsyncMode: 'per-record' },
    });
    const spy = vi.spyOn(
      writer as unknown as { syncParentDir(): Promise<void> },
      'syncParentDir',
    );
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'a' });
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'b' });
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'c' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── 7. onPersistError hook ────────────────────────────────────────────

describe('WiredJournalWriter async-batch — onPersistError hook', () => {
  it('fires with (error, failedRecords) when a drain throws', async () => {
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const onPersistError = vi.fn();
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50, onPersistError },
    });

    // Bootstrap — seed a successful drain so metadata + dir fsync are done
    // before we poison the disk path.
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'seed' });
    await vi.advanceTimersByTimeAsync(50);
    expect((await readBodyRecords(filePath)).length).toBe(1);

    const enoSpc = Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    const writeSpy = vi
      .spyOn(
        writer as unknown as { writeBatchAndSync(lines: string[]): Promise<void> },
        'writeBatchAndSync',
      )
      .mockRejectedValue(enoSpc);

    await writer.append({ type: 'user_message', turn_id: 't1', content: 'doomed-a' });
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'doomed-b' });
    await vi.advanceTimersByTimeAsync(50);

    expect(onPersistError).toHaveBeenCalledTimes(1);
    const [err, records] = onPersistError.mock.calls[0] as [unknown, unknown];
    expect(err).toBe(enoSpc);
    expect(Array.isArray(records)).toBe(true);
    const failed = records as Array<{ type: string; content?: string }>;
    expect(failed).toHaveLength(2);
    expect(failed.map((r) => r.content)).toEqual(['doomed-a', 'doomed-b']);

    writeSpy.mockRestore();
  });

  it('onPersistError receives the failed batch; pendingRecords does NOT re-include them after splice', async () => {
    // Team-lead decision (2026-04-17): "不回滚" is a TWO-layer statement —
    //   - `ContextState.history` (conversation projection) is NOT rolled
    //     back; `broken` marker handles the memory↔disk inconsistency.
    //   - `pendingRecords` is drained via `splice()`; on write failure,
    //     the failed batch is already out of pendingRecords and handed
    //     off to onPersistError via `(err, failedBatch)`.
    // So after a failed drain, pendingRecords must NOT retain the
    // failed entries — they live in the onPersistError callback only.
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const onPersistError = vi.fn();
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50, onPersistError },
    });

    // Bootstrap success so metadata is on disk.
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'seed' });
    await vi.advanceTimersByTimeAsync(50);

    // Poison subsequent drains.
    vi.spyOn(
      writer as unknown as { writeBatchAndSync(lines: string[]): Promise<void> },
      'writeBatchAndSync',
    ).mockRejectedValue(new Error('EIO'));

    await writer.append({ type: 'user_message', turn_id: 't1', content: 'a' });
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'b' });
    await vi.advanceTimersByTimeAsync(50);

    // The failed batch is handed off to onPersistError in full…
    expect(onPersistError).toHaveBeenCalledTimes(1);
    const [, records] = onPersistError.mock.calls[0] as [unknown, unknown];
    const failed = records as Array<{ content?: string }>;
    expect(failed).toHaveLength(2);
    expect(failed.map((r) => r.content)).toEqual(['a', 'b']);

    // …and pendingRecords is empty — the splice already moved them out
    // before the write was attempted, so they live in the callback, not
    // in the buffer. (No new pushes have landed yet, so length must be 0.)
    expect(writer.pendingRecords.length).toBe(0);
  });

  it('queue is frozen after a drain failure — no further drains are scheduled', async () => {
    // Team-lead decision (2026-04-17): a drain failure is treated as
    // unrecoverable (ENOSPC / EIO / EROFS). The disk queue freezes —
    // `writeBatchAndSync` is NOT invoked again after the failing call.
    // New `append` calls may still push to memory (consistency with the
    // append contract), but they won't trigger additional drain attempts;
    // SoulPlus is expected to mark the session `broken` via
    // `onPersistError` instead.
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const onPersistError = vi.fn();
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50, onPersistError },
    });

    // Bootstrap success (real write). We set the spy up BEFORE poisoning
    // so it captures every writeBatchAndSync invocation including the
    // one that will fail.
    const writeSpy = vi.spyOn(
      writer as unknown as { writeBatchAndSync(lines: string[]): Promise<void> },
      'writeBatchAndSync',
    );
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'seed' });
    await vi.advanceTimersByTimeAsync(50);
    const callsAfterBootstrap = writeSpy.mock.calls.length;
    expect(callsAfterBootstrap).toBe(1);

    // Now poison the next drain.
    writeSpy.mockRejectedValue(new Error('EIO'));

    await writer.append({ type: 'user_message', turn_id: 't1', content: 'a' });
    await vi.advanceTimersByTimeAsync(50);
    // One failed drain attempt happened.
    expect(writeSpy.mock.calls.length).toBe(callsAfterBootstrap + 1);
    expect(onPersistError).toHaveBeenCalledTimes(1);

    // Subsequent append still reaches memory (append contract).
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'b' });
    expect(writer.pendingRecords.length).toBeGreaterThanOrEqual(1);
    expect(
      writer.pendingRecords.map((r) => (r as unknown as { content: string }).content),
    ).toContain('b');

    // …but the queue is frozen: advancing past many drain intervals
    // must NOT trigger any further writeBatchAndSync call.
    await vi.advanceTimersByTimeAsync(500);
    expect(writeSpy.mock.calls.length).toBe(callsAfterBootstrap + 1);
    // onPersistError is NOT re-fired either — one failure, one notification.
    expect(onPersistError).toHaveBeenCalledTimes(1);
  });
});

// ── 8. Batch slicing (maxBatchRecords / maxBatchBytes) ────────────────

describe('WiredJournalWriter async-batch — batch size / byte limits', () => {
  it('splits into multiple drains when maxBatchRecords is exceeded', async () => {
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50, maxBatchRecords: 3 },
    });
    const writeSpy = vi.spyOn(
      writer as unknown as { writeBatchAndSync(lines: string[]): Promise<void> },
      'writeBatchAndSync',
    );

    for (let i = 0; i < 10; i++) {
      await writer.append({ type: 'user_message', turn_id: 't1', content: `r-${i}` });
    }
    // Keep advancing timers until the queue is empty — at 3 per batch,
    // 10 records require 4 drain invocations (3 + 3 + 3 + 1).
    await vi.advanceTimersByTimeAsync(500);

    const body = await readBodyRecords(filePath);
    expect(body.length).toBe(10);
    expect(writeSpy.mock.calls.length).toBe(4);
    expect(writer.pendingRecords.length).toBe(0);
  });

  it('splits by byte budget when maxBatchBytes is exceeded', async () => {
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    // Each serialised user_message is ~950 bytes (900B payload + overhead).
    // A 1024B batch budget therefore fits at most one record per drain,
    // with margin against tighter serialisers (e.g. no whitespace).
    const big = 'x'.repeat(900);
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50, maxBatchBytes: 1024 },
    });
    const writeSpy = vi.spyOn(
      writer as unknown as { writeBatchAndSync(lines: string[]): Promise<void> },
      'writeBatchAndSync',
    );

    for (let i = 0; i < 4; i++) {
      await writer.append({ type: 'user_message', turn_id: 't1', content: `${big}-${i}` });
    }
    await vi.advanceTimersByTimeAsync(500);

    // At least 2 drain invocations — a single 1024B batch can't hold two
    // records of this size.
    expect(writeSpy.mock.calls.length).toBeGreaterThan(1);
    const body = await readBodyRecords(filePath);
    expect(body.length).toBe(4);
  });
});

// ── 9. Lifecycle gating (unchanged by async refactor) ─────────────────

describe('WiredJournalWriter async-batch — lifecycle gating (unchanged)', () => {
  it('rejects non-compaction appends while gate is compacting', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const gate = new StubGate();
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: gate,
      config: { fsyncMode: 'per-record' },
    });
    gate.state = 'compacting';
    await expect(
      writer.append({ type: 'user_message', turn_id: 't1', content: 'blocked' }),
    ).rejects.toBeInstanceOf(JournalGatedError);
  });

  it('allows compaction records while gate is compacting', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const gate = new StubGate();
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: gate,
      config: { fsyncMode: 'per-record' },
    });
    gate.state = 'compacting';
    const rec = await writer.append({
      type: 'compaction',
      summary: 's',
      compacted_range: { from_turn: 1, to_turn: 1, message_count: 1 },
      pre_compact_tokens: 100,
      post_compact_tokens: 20,
      trigger: 'auto',
    });
    expect(rec.type).toBe('compaction');
  });

  it('completing state rejects every record type — including compaction', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const gate = new StubGate();
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: gate,
      config: { fsyncMode: 'per-record' },
    });
    gate.state = 'completing';
    await expect(
      writer.append({ type: 'user_message', turn_id: 't1', content: 'x' }),
    ).rejects.toBeInstanceOf(JournalGatedError);
    await expect(
      writer.append({
        type: 'compaction',
        summary: 's',
        compacted_range: { from_turn: 1, to_turn: 1, message_count: 1 },
        pre_compact_tokens: 100,
        post_compact_tokens: 20,
        trigger: 'auto',
      }),
    ).rejects.toBeInstanceOf(JournalGatedError);
  });
});

// ── 10. seq monotonicity + FIFO ───────────────────────────────────────

describe('WiredJournalWriter async-batch — seq monotonicity + FIFO', () => {
  it('20 concurrent appends produce strictly monotonic seq 1..20 in call order', async () => {
    vi.useFakeTimers();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { drainIntervalMs: 50 },
    });
    const promises: Array<ReturnType<typeof writer.append>> = [];
    for (let i = 0; i < 20; i++) {
      promises.push(
        writer.append({ type: 'user_message', turn_id: 't1', content: `seq-${i}` }),
      );
    }
    const records = await Promise.all(promises);
    expect(records.map((r) => r.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );

    await writer.flush();
    const body = await readBodyRecords(filePath);
    expect(body.map((r) => r['content'])).toEqual(
      Array.from({ length: 20 }, (_, i) => `seq-${i}`),
    );
    expect(body.map((r) => r['seq'])).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});
