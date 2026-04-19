/**
 * Slice 20-A — `ContextState.clear()` WAL-then-mirror behaviour.
 *
 * These tests are RED-BAR by design: they drive the new `clear()` method
 * that `FullContextState` will expose and the new `context_cleared` wire
 * record that BaseContextState will write.
 *
 * Invariants exercised:
 *   - 铁律 4 双通道 + §4.5.3 WAL-then-mirror: `clear()` must `await
 *     journalWriter.append({type: 'context_cleared'})` FIRST, then flip
 *     in-memory state; if the append throws, the in-memory projection
 *     must be unchanged.
 *   - 铁律 5 EventSink: clearing must write a durable `context_cleared`
 *     record to `wire.jsonl` (event-sink-only is not acceptable).
 *   - 保留字段: clear() must NOT touch model / systemPrompt / activeTools
 *     — those are driven by their own `_changed` records.
 *   - 幂等: two successive clears do not crash and produce two
 *     context_cleared records.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  InMemoryContextState,
  WiredContextState,
  type FullContextState,
} from '../../src/storage/context-state.js';
import {
  type AppendInput,
  type JournalWriter,
  type LifecycleGate,
  type LifecycleState,
  WiredJournalWriter,
} from '../../src/storage/journal-writer.js';
import type { WireRecord } from '../../src/storage/wire-record.js';

// ── Helpers ──────────────────────────────────────────────────────────────

class StubGate implements LifecycleGate {
  state: LifecycleState = 'active';
}

async function readWireRecords(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-cs-clear-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeWiredState(): { state: WiredContextState; filePath: string } {
  const filePath = join(workDir, 'wire.jsonl');
  const writer = new WiredJournalWriter({
    filePath,
    lifecycle: new StubGate(),
    config: { fsyncMode: 'per-record' },
  });
  const state = new WiredContextState({
    journalWriter: writer,
    initialModel: 'moonshot-v1',
    initialSystemPrompt: 'you are helpful',
    initialActiveTools: new Set(['Read', 'Write']),
    currentTurnId: () => 't1',
  });
  return { state, filePath };
}

/**
 * A FakeJournalWriter that records every append for assertions and
 * optionally throws on the first `context_cleared` append. Used to
 * verify WAL-then-mirror atomicity for the new clear path.
 */
class FakeJournalWriter implements JournalWriter {
  readonly appended: AppendInput[] = [];
  readonly pendingRecords: ReadonlyArray<WireRecord> = [];
  private seq = 0;
  failOn: 'context_cleared' | undefined;

  async append(input: AppendInput): Promise<WireRecord> {
    if (this.failOn !== undefined && input.type === this.failOn) {
      throw new Error(`simulated append failure for ${input.type}`);
    }
    this.appended.push(input);
    this.seq += 1;
    return { ...input, seq: this.seq, time: 0 } as WireRecord;
  }
  async flush(): Promise<void> {
    /* no-op */
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

// ── 1. WiredContextState — happy path ────────────────────────────────────

describe('ContextState.clear — WiredContextState happy path', () => {
  it('drops all in-memory history after a clear', async () => {
    const { state } = makeWiredState();
    await state.appendUserMessage({ text: 'hi' });
    await state.appendAssistantMessage({
      text: 'hello',
      think: null,
      toolCalls: [],
      model: 'moonshot-v1',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(state.buildMessages().length).toBeGreaterThan(0);
    expect(state.getHistory().length).toBeGreaterThan(0);
    expect(state.tokenCountWithPending).toBeGreaterThan(0);

    await (state as FullContextState & { clear(): Promise<void> }).clear();

    expect(state.buildMessages()).toEqual([]);
    expect(state.getHistory()).toEqual([]);
    expect(state.tokenCountWithPending).toBe(0);
  });

  it('persists a context_cleared wire record', async () => {
    const { state, filePath } = makeWiredState();
    await state.appendUserMessage({ text: 'hi' });

    await (state as FullContextState & { clear(): Promise<void> }).clear();

    const records = await readWireRecords(filePath);
    const cleared = records.filter((r) => r['type'] === 'context_cleared');
    expect(cleared.length).toBe(1);
  });

  it('preserves model, systemPrompt, activeTools across a clear', async () => {
    const { state } = makeWiredState();
    await state.appendUserMessage({ text: 'hi' });

    await (state as FullContextState & { clear(): Promise<void> }).clear();

    expect(state.model).toBe('moonshot-v1');
    expect(state.systemPrompt).toBe('you are helpful');
    expect(new Set(state.activeTools)).toEqual(new Set(['Read', 'Write']));
  });

  it('is idempotent — two successive clears do not crash', async () => {
    const { state, filePath } = makeWiredState();
    await state.appendUserMessage({ text: 'q1' });

    const clearable = state as FullContextState & { clear(): Promise<void> };
    await clearable.clear();
    await clearable.clear();

    expect(state.buildMessages()).toEqual([]);
    const records = await readWireRecords(filePath);
    const cleared = records.filter((r) => r['type'] === 'context_cleared');
    // Each call writes its own record — replay needs the second one to
    // reset anything written between the two clears.
    expect(cleared.length).toBe(2);
  });

  it('does not drop pending steer buffer (steers belong to the next turn, not history)', async () => {
    const { state } = makeWiredState();
    state.pushSteer({ text: 'follow-up hint' });

    await (state as FullContextState & { clear(): Promise<void> }).clear();

    // A steer queued for the in-flight turn is not "history" — it is a
    // yet-to-be-delivered user input. Clearing must not silently drop it.
    const drained = state.drainSteerMessages();
    expect(drained.map((s) => s.text)).toEqual(['follow-up hint']);
  });
});

// ── 2. WAL-then-mirror atomicity ─────────────────────────────────────────

describe('ContextState.clear — WAL-then-mirror atomicity', () => {
  it('rejects and leaves in-memory state untouched when the journal append throws', async () => {
    const writer = new FakeJournalWriter();
    writer.failOn = 'context_cleared';
    const state = new WiredContextState({
      journalWriter: writer,
      initialModel: 'moonshot-v1',
      initialSystemPrompt: 'sp',
      currentTurnId: () => 't1',
    });
    await state.appendUserMessage({ text: 'pre-clear' });
    await state.appendAssistantMessage({
      text: 'a',
      think: null,
      toolCalls: [],
      model: 'moonshot-v1',
      usage: { input_tokens: 4, output_tokens: 2 },
    });
    const historyBefore = state.getHistory().length;
    const tokensBefore = state.tokenCountWithPending;

    await expect(
      (state as FullContextState & { clear(): Promise<void> }).clear(),
    ).rejects.toThrow(/simulated append failure/);

    // Mirror must be unchanged — the WAL write failed.
    expect(state.getHistory().length).toBe(historyBefore);
    expect(state.tokenCountWithPending).toBe(tokensBefore);
    expect(state.buildMessages().length).toBe(historyBefore);
  });

  it('appends the context_cleared record BEFORE it touches the in-memory projection', async () => {
    const writer = new FakeJournalWriter();
    const state = new WiredContextState({
      journalWriter: writer,
      initialModel: 'moonshot-v1',
      initialSystemPrompt: 'sp',
      currentTurnId: () => 't1',
    });
    await state.appendUserMessage({ text: 'first' });

    // Spy the append so the call order vs. the in-memory read below is
    // observable. Concretely, the last append must be `context_cleared`,
    // and AFTER clear() resolves, `getHistory()` must be empty.
    const spy = vi.spyOn(writer, 'append');

    await (state as FullContextState & { clear(): Promise<void> }).clear();

    const lastCall = spy.mock.calls.at(-1)?.[0];
    expect(lastCall?.type).toBe('context_cleared');
    expect(state.getHistory()).toEqual([]);
  });
});

// ── 3. InMemoryContextState parity ───────────────────────────────────────

describe('ContextState.clear — InMemoryContextState parity', () => {
  it('clear empties history but preserves config fields', async () => {
    const state = new InMemoryContextState({
      initialModel: 'moonshot-v1',
      initialSystemPrompt: 'sp',
      initialActiveTools: new Set(['Bash']),
    });
    await state.appendUserMessage({ text: 'hi' });
    await state.appendAssistantMessage({
      text: 'hello',
      think: null,
      toolCalls: [],
      model: 'moonshot-v1',
      usage: { input_tokens: 3, output_tokens: 2 },
    });

    await (state as FullContextState & { clear(): Promise<void> }).clear();

    expect(state.buildMessages()).toEqual([]);
    expect(state.tokenCountWithPending).toBe(0);
    expect(state.model).toBe('moonshot-v1');
    expect(state.systemPrompt).toBe('sp');
    expect(new Set(state.activeTools)).toEqual(new Set(['Bash']));
  });
});

// ── 4. Durability under production batched writer (Phase 20 round-5) ────
//
// The happy-path tests above use `fsyncMode: 'per-record'`, which masks
// production's batched default where non-force-flush records only land in
// the in-memory pending buffer until the next drain tick (≤50 ms). A
// `context_cleared` without force-flush can disappear on crash and
// replay restores the "cleared" history — the exact surprise round-5
// review flagged. These tests pin the fix (context_cleared joins
// FORCE_FLUSH_KINDS) by verifying the WAL file on disk observably
// contains the record BEFORE `clear()` resolves.

describe('ContextState.clear — durable under batched fsyncMode (production default)', () => {
  function makeBatchedState(): { state: WiredContextState; filePath: string } {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      // No `config` → defaults to fsyncMode: 'batched', matching
      // SessionManager.createSession / resumeSession in production.
    });
    const state = new WiredContextState({
      journalWriter: writer,
      initialModel: 'moonshot-v1',
      initialSystemPrompt: 'you are helpful',
      initialActiveTools: new Set(['Read']),
      currentTurnId: () => 't1',
    });
    return { state, filePath };
  }

  it('context_cleared is on disk before clear() resolves (force-flush)', async () => {
    const { state, filePath } = makeBatchedState();
    await state.appendUserMessage({ text: 'pre-clear' });
    // Non-force user_message is still batched — expect the file NOT to
    // contain the user line yet. This doubles as a tripwire: if
    // `user_message` is ever added to FORCE_FLUSH_KINDS the assertion
    // below flips to a failure, flagging that this test's setup is no
    // longer discriminating the batched vs force-flush behaviour it
    // claims to test.
    const beforeClear = await readFile(filePath, 'utf8').catch(() => '');
    expect(beforeClear).not.toContain('"user_message"');

    await (state as FullContextState & { clear(): Promise<void> }).clear();

    // After clear() resolves, context_cleared MUST be observable on
    // disk — not merely in the writer's pending buffer. This is the
    // round-5 "crash window" regression test: without
    // FORCE_FLUSH_KINDS.context_cleared, this line would be empty
    // until the next drain tick.
    const afterClear = await readFile(filePath, 'utf8');
    expect(afterClear).toContain('"type":"context_cleared"');
  });

  it('a force-flushed context_cleared also drains earlier batched records in the same flush', async () => {
    // FORCE_FLUSH triggers immediate drain of the entire pending
    // buffer, so the user_message appended just before the clear
    // should also land on disk once clear() resolves.
    const { state, filePath } = makeBatchedState();
    await state.appendUserMessage({ text: 'pre-clear' });

    await (state as FullContextState & { clear(): Promise<void> }).clear();

    const contents = await readFile(filePath, 'utf8');
    expect(contents).toContain('"type":"user_message"');
    expect(contents).toContain('"type":"context_cleared"');
    // Order check: user_message must precede context_cleared in the
    // file so replay can reconstruct `cleared-right-after-that-turn`
    // rather than the other way around.
    const userIdx = contents.indexOf('"type":"user_message"');
    const clearIdx = contents.indexOf('"type":"context_cleared"');
    expect(userIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(userIdx);
  });
});
