/**
 * Phase 25 Stage K0 — slice 25c-4b: WiredContextState degraded/broken state.
 *
 * When a `JournalWriter` drain fails, the session enters "degraded"
 * (铁律 L17: WAL faults are fatal for the producer). SoulPlus observes the
 * failure through `JournalWriterConfig.onPersistError` and must mark the
 * `ContextState` broken so that every *subsequent* write is immediately
 * rejected — no silent in-memory drift that a future flush-retry can't
 * close the gap on.
 *
 * This suite pins the two new behaviours that slice 25c-4b adds to
 * `BaseContextState` (the shared super-class of `WiredContextState` and
 * `InMemoryContextState`):
 *
 *   - `markBroken(error: Error): void` — latches the broken flag and
 *     stashes the originating error as `cause` on the thrown error. Must
 *     be idempotent: repeated calls do not replace the first `cause` and
 *     do not throw themselves.
 *
 *   - Every `append*` / `clear` / `applyConfigChange` / `resetToSummary`
 *     / `addUserMessages` entry-point asserts `notBroken` at its head and
 *     throws `ContextStateBrokenError` when broken. Read paths
 *     (`buildMessages` / `drainSteerMessages` / `getHistory`) stay open so
 *     the UI can still render the transcript after the crash.
 */

import { describe, expect, it } from 'vitest';

import {
  InMemoryContextState,
  WiredContextState,
  type ConfigChangeEvent,
  type FullContextState,
} from '../../src/storage/context-state.js';
import {
  ContextStateBrokenError,
} from '../../src/storage/errors.js';
import {
  type AppendInput,
  type JournalWriter,
} from '../../src/storage/journal-writer.js';
import type { WireRecord } from '../../src/storage/wire-record.js';

// ── Fake JournalWriter — records appends, no failure injection here ────

class FakeJournalWriter implements JournalWriter {
  readonly appended: AppendInput[] = [];
  readonly pendingRecords: ReadonlyArray<WireRecord> = [];
  private seq = 0;

  async append(input: AppendInput): Promise<WireRecord> {
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

// Narrow the degraded-state helpers onto the FullContextState surface. The
// type extension mirrors how slice 25c-1 introduced atomic writers: the
// Implementer lands `markBroken` on BaseContextState; until then the cast
// lets us call it through the public interface.
interface BrokenCtx {
  markBroken(error: Error): void;
}
type BrokenContextState = FullContextState & BrokenCtx;

function makeWired(): { state: BrokenContextState; writer: FakeJournalWriter } {
  const writer = new FakeJournalWriter();
  const state = new WiredContextState({
    journalWriter: writer,
    initialModel: 'moonshot-v1',
    initialSystemPrompt: '',
    currentTurnId: () => 't1',
  });
  return { state: state as unknown as BrokenContextState, writer };
}

function makeInMemory(): InMemoryContextState & BrokenCtx {
  return new InMemoryContextState({
    initialModel: 'moonshot-v1',
    initialSystemPrompt: '',
  }) as unknown as InMemoryContextState & BrokenCtx;
}

// A minimal valid payload for every append* entry point we want to test.
function validAssistantMessage() {
  return {
    text: 'hi',
    think: null,
    toolCalls: [],
    model: 'moonshot-v1',
  };
}

// ── 1. Pre-brokenness: nothing throws on the write path ────────────────

describe('WiredContextState degraded state — pre-broken baseline', () => {
  it('initial state: appendStepBegin succeeds and the WAL row is written', async () => {
    const { state, writer } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });
    expect(writer.appended).toHaveLength(1);
    expect(writer.appended[0]!.type).toBe('step_begin');
  });
});

// ── 2. markBroken latches the flag on every append entry point ─────────

describe('WiredContextState.markBroken — rejects all write entry points', () => {
  it('throws ContextStateBrokenError from every append* / clear / applyConfigChange / resetToSummary after markBroken', async () => {
    const { state } = makeWired();
    const rootCause = new Error('disk full');
    state.markBroken(rootCause);

    // Every entry point must throw ContextStateBrokenError. The full list
    // below is the Phase-25 contract — if a new write entry point lands on
    // `FullContextState`, this test should grow to cover it.

    await expect(
      state.appendStepBegin({ uuid: 'u-x', turnId: 't1', step: 0 }),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);

    await expect(
      state.appendStepEnd({ uuid: 'u-x', turnId: 't1', step: 0 }),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);

    await expect(
      state.appendContentPart({
        uuid: 'u-p',
        turnId: 't1',
        step: 0,
        stepUuid: 'u-x',
        part: { kind: 'text', text: 'hi' },
      }),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);

    await expect(
      state.appendToolCall({
        uuid: 'u-tc',
        turnId: 't1',
        step: 0,
        stepUuid: 'u-x',
        data: { tool_call_id: 'tc-1', tool_name: 'Bash', args: {} },
      }),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);

    await expect(
      state.appendToolResult(undefined, 'tc-1', { output: 'ok' }),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);

    await expect(
      state.appendUserMessage({ text: 'hi' }),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);

    await expect(
      state.appendAssistantMessage(validAssistantMessage()),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);

    await expect(
      state.addUserMessages([{ text: 'hi' }]),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);

    await expect(
      state.appendNotification({
        id: 'n-1',
        category: 'system',
        type: 'test',
        source_kind: 'test',
        source_id: 'test',
        title: 't',
        body: 'b',
        severity: 'info',
        targets: ['llm'],
      }),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);

    await expect(
      state.appendSystemReminder({ content: 'ping' }),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);

    await expect(state.clear()).rejects.toBeInstanceOf(ContextStateBrokenError);

    const event: ConfigChangeEvent = {
      type: 'system_prompt_changed',
      new_prompt: 'x',
    };
    await expect(state.applyConfigChange(event)).rejects.toBeInstanceOf(
      ContextStateBrokenError,
    );

    await expect(
      state.resetToSummary({
        summary: 's',
        compactedRange: { fromTurn: 0, toTurn: 0, messageCount: 0 },
        preCompactTokens: 0,
        postCompactTokens: 0,
        trigger: 'manual',
      }),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);
  });

  it('does NOT write any WAL row for a rejected append — the writer stays untouched', async () => {
    const { state, writer } = makeWired();
    state.markBroken(new Error('disk full'));
    await expect(
      state.appendUserMessage({ text: 'blocked' }),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);
    expect(writer.appended).toHaveLength(0);
  });

  it('carries the originating error on ContextStateBrokenError.cause', async () => {
    const { state } = makeWired();
    const rootCause = new Error('disk full');
    state.markBroken(rootCause);
    try {
      await state.appendStepBegin({ uuid: 'u', turnId: 't1', step: 0 });
      throw new Error('expected ContextStateBrokenError');
    } catch (err) {
      expect(err).toBeInstanceOf(ContextStateBrokenError);
      expect((err as { cause?: unknown }).cause).toBe(rootCause);
    }
  });

  it('is idempotent — a second markBroken call is a no-op and does NOT replace the first cause', async () => {
    const { state } = makeWired();
    const first = new Error('disk full');
    const second = new Error('then fs read-only');
    state.markBroken(first);
    state.markBroken(second);
    try {
      await state.appendStepBegin({ uuid: 'u', turnId: 't1', step: 0 });
      throw new Error('expected throw');
    } catch (err) {
      // Contract: the FIRST cause is pinned. Second call must not clobber.
      expect((err as { cause?: unknown }).cause).toBe(first);
    }
  });

  it('markBroken itself never throws (safe to call at any time, including from an error handler)', () => {
    const { state } = makeWired();
    expect(() => state.markBroken(new Error('one'))).not.toThrow();
    expect(() => state.markBroken(new Error('two'))).not.toThrow();
  });

  it('leaves read paths (buildMessages / drainSteerMessages / getHistory) open after markBroken', async () => {
    const { state } = makeWired();
    await state.appendUserMessage({ text: 'pre-crash' });
    state.pushSteer({ text: 'steer' });
    const historyBefore = state.getHistory();
    const messagesBefore = state.buildMessages();
    expect(historyBefore).toHaveLength(1);
    expect(messagesBefore).toHaveLength(1);

    state.markBroken(new Error('disk full'));

    // Read paths must not throw — UI needs to render the transcript.
    const history = state.getHistory();
    expect(history).toHaveLength(1);
    const messages = state.buildMessages();
    expect(messages).toHaveLength(1);
    const drained = state.drainSteerMessages();
    expect(drained).toEqual([{ text: 'steer' }]);
  });

  it('InMemoryContextState also honours markBroken (BaseContextState shared implementation)', async () => {
    const state = makeInMemory();
    state.markBroken(new Error('embed disk full'));
    await expect(
      state.appendUserMessage({ text: 'blocked' }),
    ).rejects.toBeInstanceOf(ContextStateBrokenError);
  });
});

// ── 3. ContextStateBrokenError — class shape ───────────────────────────

describe('ContextStateBrokenError — class contract', () => {
  it('is a subclass of Error and carries .name === "ContextStateBrokenError"', () => {
    const err = new ContextStateBrokenError('ctx broken', new Error('root'));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ContextStateBrokenError');
  });

  it('accepts a `cause` via the constructor and exposes it as .cause', () => {
    const root = new Error('root');
    const err = new ContextStateBrokenError('ctx broken', root);
    expect((err as { cause?: unknown }).cause).toBe(root);
  });
});
