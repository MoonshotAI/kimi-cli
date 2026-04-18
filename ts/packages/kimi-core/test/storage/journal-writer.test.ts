// Component: JournalWriter (§4.5.4)
// Covers: AsyncSerialQueue ordering, fsync semantics, LifecycleGate gating,
// seq allocation, wire.jsonl as the sole physical write site, metadata
// header bootstrap.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JournalGatedError } from '../../src/storage/errors.js';
import {
  type LifecycleGate,
  type LifecycleState,
  WiredJournalWriter,
} from '../../src/storage/journal-writer.js';
import { replayWire } from '../../src/storage/replay.js';
import type { SessionInitializedMainRecord } from '../../src/storage/wire-record.js';

const TEST_SESSION_INIT: Omit<SessionInitializedMainRecord, 'seq' | 'time'> = {
  type: 'session_initialized',
  agent_type: 'main',
  session_id: 'ses_test',
  system_prompt: '',
  model: 'm',
  active_tools: [],
  permission_mode: 'default',
  plan_mode: false,
  workspace_dir: '/tmp/ws',
};

class StubGate implements LifecycleGate {
  state: LifecycleState = 'active';
}

async function readWireLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter((l) => l.length > 0);
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-journal-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('WiredJournalWriter.append — basic writes', () => {
  it('writes metadata header on first append', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      protocolVersion: '2.1',
      now: () => 1712790000000,
    });

    await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'hello',
    });
    // Phase 3: default `fsyncMode: 'batched'` means a non-force-flush
    // record is only durable after `flush()` (or the drain timer ticks).
    // An explicit flush lets this pre-async-batch assertion stay valid.
    await writer.flush();

    const lines = await readWireLines(filePath);
    expect(lines.length).toBe(2);
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(header['type']).toBe('metadata');
    expect(header['protocol_version']).toBe('2.1');
    expect(typeof header['created_at']).toBe('number');
  });

  it('stamps monotonic seq and write-time on each record', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    let clock = 1000;
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      now: () => clock++,
    });

    const a = await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'a',
    });
    const b = await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'b',
    });

    expect(a.seq + 1).toBe(b.seq);
    expect(a.time).toBeLessThan(b.time);
  });

  it('persists the exact same record that is returned', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
    });

    const returned = await writer.append({
      type: 'assistant_message',
      turn_id: 't1',
      text: 'ok',
      think: null,
      tool_calls: [],
      model: 'moonshot-v1',
    });
    // Phase 3: force the async-batch queue to drain before reading disk.
    await writer.flush();

    const lines = await readWireLines(filePath);
    const lastLine = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(lastLine['seq']).toBe(returned.seq);
    expect(lastLine['time']).toBe(returned.time);
    expect(lastLine['type']).toBe('assistant_message');
  });
});

describe('WiredJournalWriter — serialisation', () => {
  it('processes concurrent appends in FIFO call order', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
    });

    const all = await Promise.all([
      writer.append({ type: 'user_message', turn_id: 't1', content: '1' }),
      writer.append({ type: 'user_message', turn_id: 't1', content: '2' }),
      writer.append({ type: 'user_message', turn_id: 't1', content: '3' }),
    ]);

    // Seq must reflect the order the calls were made in, not completion order.
    expect(all.map((r) => r.seq)).toEqual([all[0].seq, all[0].seq + 1, all[0].seq + 2]);

    // Phase 3: drain the async-batch buffer before inspecting disk.
    await writer.flush();

    const lines = await readWireLines(filePath);
    // 1 metadata header + 3 records.
    expect(lines.length).toBe(4);
    const contents = lines.slice(1).map((l) => (JSON.parse(l) as { content: string }).content);
    expect(contents).toEqual(['1', '2', '3']);
  });
});

describe('WiredJournalWriter — lifecycle gate', () => {
  it('rejects non-compaction appends while gate is compacting', async () => {
    const gate = new StubGate();
    const writer = new WiredJournalWriter({
      filePath: join(workDir, 'wire.jsonl'),
      lifecycle: gate,
    });

    gate.state = 'compacting';

    await expect(
      writer.append({ type: 'user_message', turn_id: 't1', content: 'blocked' }),
    ).rejects.toBeInstanceOf(JournalGatedError);
  });

  it('the rejected JournalGatedError carries the gate state and record type', async () => {
    const gate = new StubGate();
    const writer = new WiredJournalWriter({
      filePath: join(workDir, 'wire.jsonl'),
      lifecycle: gate,
    });

    gate.state = 'compacting';

    let caught: unknown;
    try {
      await writer.append({ type: 'user_message', turn_id: 't1', content: 'blocked' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(JournalGatedError);
    const err = caught as JournalGatedError;
    expect(err.state).toBe('compacting');
    expect(err.recordType).toBe('user_message');
  });

  it('completing state rejects every record type, including compaction', async () => {
    const gate = new StubGate();
    const writer = new WiredJournalWriter({
      filePath: join(workDir, 'wire.jsonl'),
      lifecycle: gate,
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

  it('resumes accepting appends after gate returns to active', async () => {
    const gate = new StubGate();
    const writer = new WiredJournalWriter({
      filePath: join(workDir, 'wire.jsonl'),
      lifecycle: gate,
    });

    gate.state = 'compacting';
    await expect(
      writer.append({ type: 'user_message', turn_id: 't1', content: 'x' }),
    ).rejects.toBeInstanceOf(JournalGatedError);

    gate.state = 'active';
    const record = await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'y',
    });
    expect(record.type).toBe('user_message');
  });
});

// ── Slice 6 audit M02: compaction-own-write whitelist ─────────────────
//
// Regression coverage for `PHASE1_AUDIT_slice6.md` M02:
//   During `compacting`, the gate must still reject upstream Soul output
//   (turn_begin / assistant_message / etc.) to drain writes, but it must
//   let the compaction path's own CompactionRecord through — otherwise
//   `resetToSummary()` self-deadlocks against the gate and compaction
//   never completes.
describe('WiredJournalWriter — compaction whitelist (Slice 6 audit M02)', () => {
  it('accepts a compaction record while gate is compacting', async () => {
    const gate = new StubGate();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: gate,
      now: () => 2000,
    });

    gate.state = 'compacting';

    const record = await writer.append({
      type: 'compaction',
      summary: 'compact history',
      compacted_range: { from_turn: 1, to_turn: 3, message_count: 3 },
      pre_compact_tokens: 5000,
      post_compact_tokens: 500,
      trigger: 'auto',
    });

    expect(record.type).toBe('compaction');
    expect(record.seq).toBe(1);

    // Phase 3: a `compaction` record is not in FORCE_FLUSH_KINDS, so
    // under default batched mode we must flush before reading the file.
    await writer.flush();

    const lines = await readWireLines(filePath);
    // metadata header + compaction record
    expect(lines.length).toBe(2);
    const persisted = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(persisted['type']).toBe('compaction');
    expect(persisted['summary']).toBe('compact history');
  });

  it('still rejects non-compaction writes while gate is compacting', async () => {
    const gate = new StubGate();
    const writer = new WiredJournalWriter({
      filePath: join(workDir, 'wire.jsonl'),
      lifecycle: gate,
    });

    gate.state = 'compacting';

    for (const input of [
      { type: 'user_message' as const, turn_id: 't1', content: 'x' },
      {
        type: 'turn_begin' as const,
        turn_id: 't1',
        agent_type: 'main' as const,
        input_kind: 'user' as const,
      },
      {
        type: 'assistant_message' as const,
        turn_id: 't1',
        text: 'hi',
        think: null,
        tool_calls: [],
        model: 'm',
      },
    ]) {
      await expect(writer.append(input)).rejects.toBeInstanceOf(JournalGatedError);
    }
  });

  it('accepts all record types once the gate returns to active', async () => {
    const gate = new StubGate();
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: gate,
    });

    // First a compaction record while compacting (opens + seeds the file)
    gate.state = 'compacting';
    await writer.append({
      type: 'compaction',
      summary: 's',
      compacted_range: { from_turn: 1, to_turn: 1, message_count: 1 },
      pre_compact_tokens: 100,
      post_compact_tokens: 20,
      trigger: 'auto',
    });

    // Back to active — the ordinary append path must work again.
    gate.state = 'active';
    const user = await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'after compaction',
    });
    expect(user.type).toBe('user_message');
    expect(user.seq).toBe(2);
  });
});

describe('WiredJournalWriter — fsync semantics (per-record mode)', () => {
  it('per-record mode: append promise does not resolve until data is readable from disk', async () => {
    // Phase 3: in the new default `fsyncMode: 'batched'`, a non-force-flush
    // `user_message` append resolves BEFORE fsync (see
    // journal-writer-async-batch.test.ts for that contract). The original
    // "append resolve implies disk readability" invariant is still load-
    // bearing for SDK-embedded callers that opt into the legacy path via
    // `fsyncMode: 'per-record'` — pin that invariant here.
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { fsyncMode: 'per-record' },
    });

    await writer.append({
      type: 'user_message',
      turn_id: 't1',
      content: 'durable',
    });

    const text = await readFile(filePath, 'utf8');
    expect(text).toMatch(/durable/);
  });
});

// ── Slice 1 audit M1: resume bootstrap ──────────────────────────────
//
// Regression coverage for `PHASE1_AUDIT_slice1.md` M1:
//   Before the fix, a second `new WiredJournalWriter(...)` pointed at an
//   existing `wire.jsonl` would re-write the metadata header and reset
//   `seq` to 1, producing a file with two `metadata` rows and colliding
//   seq numbers. The resume-bootstrap options now let callers carry
//   `lastSeq + metadataAlreadyWritten` across the instance boundary.
describe('WiredJournalWriter — resume bootstrap (Slice 1 audit M1)', () => {
  it('does not re-write metadata and continues seq from initialSeq on resume', async () => {
    const filePath = join(workDir, 'wire.jsonl');

    // Pass 1: simulate an original writer that creates the file and lays
    // down metadata + session_initialized + three body records.
    const first = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      protocolVersion: '2.1',
      now: () => 1_000,
    });
    // Phase 23 — line 2 must be session_initialized.
    await first.append(TEST_SESSION_INIT);
    await first.append({ type: 'user_message', turn_id: 't1', content: 'a' });
    await first.append({ type: 'user_message', turn_id: 't1', content: 'b' });
    const last = await first.append({ type: 'user_message', turn_id: 't1', content: 'c' });
    expect(last.seq).toBe(4);
    // Phase 3: drain the first writer's async-batch buffer so its records
    // are on disk before a second writer tries to resume from the file.
    await first.flush();

    // Pass 2: simulate process restart. A fresh writer that knows the
    // on-disk state (lastSeq = 4, metadata already written) must NOT emit
    // a second metadata row and must allocate seq=5 for the next record.
    const resumed = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      protocolVersion: '2.1',
      now: () => 2_000,
      initialSeq: last.seq,
      metadataAlreadyWritten: true,
    });
    const d = await resumed.append({ type: 'user_message', turn_id: 't2', content: 'd' });
    const e = await resumed.append({ type: 'user_message', turn_id: 't2', content: 'e' });
    expect(d.seq).toBe(5);
    expect(e.seq).toBe(6);
    // Phase 3: drain the resumed writer's batch queue before replay.
    await resumed.flush();

    // Whole-file replay must see exactly one metadata header and
    // contiguous seq 2..6 in call order (session_initialized seq=1 is
    // extracted out of records[] per Phase 23).
    const result = await replayWire(filePath, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.records.map((r) => r.seq)).toEqual([2, 3, 4, 5, 6]);
    // Only one metadata header in the raw file (replayWire strips it,
    // so check the raw text too for extra safety).
    const rawLines = (await readFile(filePath, 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string });
    const metadataCount = rawLines.filter((l) => l.type === 'metadata').length;
    expect(metadataCount).toBe(1);
  });

  it('rejects a negative initialSeq', () => {
    expect(
      () =>
        new WiredJournalWriter({
          filePath: join(workDir, 'wire.jsonl'),
          lifecycle: new StubGate(),
          initialSeq: -1,
          metadataAlreadyWritten: true,
        }),
    ).toThrow(RangeError);
  });
});

// ── Slice 1 audit M4: parent directory fsync ─────────────────────────
//
// Regression coverage for `PHASE1_AUDIT_slice1.md` M4:
//   POSIX durability: `fh.sync()` only flushes file *contents*. A fresh
//   file's directory entry is not guaranteed durable until the parent
//   directory itself is fsynced. The writer must do this exactly once,
//   on the first successful append, and never again.
describe('WiredJournalWriter — parent directory fsync (Slice 1 audit M4)', () => {
  it('fsyncs the parent directory exactly once, on the first successful append', async () => {
    // Phase 3: pin the invariant against the legacy per-record path so
    // the once-only guarantee is checked deterministically without being
    // coupled to the async-batch drain timer. The batched path's own
    // once-only guarantee is covered separately in
    // journal-writer-async-batch.test.ts.
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { fsyncMode: 'per-record' },
    });

    // `syncParentDir` is a private method at the TS level but a regular
    // function at runtime — spy on it via the instance.
    const writerAny = writer as unknown as { syncParentDir: () => Promise<void> };
    const spy = vi.spyOn(writerAny, 'syncParentDir');

    await writer.append({ type: 'user_message', turn_id: 't1', content: 'first' });
    expect(spy).toHaveBeenCalledTimes(1);

    // Subsequent appends must NOT re-fsync the directory — it's only
    // needed once to make the freshly-created dirent durable.
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'second' });
    await writer.append({ type: 'user_message', turn_id: 't1', content: 'third' });
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it('skips the parent directory fsync when resuming from an existing file', async () => {
    // Phase 3: pin the once-only guarantee against per-record mode on
    // both ends (seed + resume) — same rationale as the previous test.
    const filePath = join(workDir, 'wire.jsonl');
    const seeder = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      config: { fsyncMode: 'per-record' },
    });
    const first = await seeder.append({ type: 'user_message', turn_id: 't0', content: 'seed' });

    // Resume: the dirent is already durable, so we must NOT fsync again.
    const resumed = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      initialSeq: first.seq,
      metadataAlreadyWritten: true,
      config: { fsyncMode: 'per-record' },
    });
    const resumedAny = resumed as unknown as { syncParentDir: () => Promise<void> };
    const spy = vi.spyOn(resumedAny, 'syncParentDir');

    await resumed.append({ type: 'user_message', turn_id: 't1', content: 'resumed' });
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});
