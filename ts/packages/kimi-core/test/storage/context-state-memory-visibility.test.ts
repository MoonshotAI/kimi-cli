// Phase 3 (Slice 3) — ContextState "memory-visible + WAL-enqueued" contract.
//
// v2 §4.5.3 tightens the ContextState write-method invariant:
//
//   After `await contextState.append*()` resolves, the record is **guaranteed
//   to be in the in-memory projection** (so the next `buildMessages()` sees
//   it). Disk durability for non-force-flush records lags behind — the
//   drain timer catches up asynchronously, typically within
//   `drainIntervalMs` (50 ms by default).
//
// Before Phase 3 the write sequence was `append → fsync → mirror`, which
// coupled memory visibility to fsync latency. Phase 3 decouples them: the
// in-memory mirror is updated once the `JournalWriter.append()` returns,
// and `append()` returns before the disk fsync (for non-force-flush).
//
// These tests pin the new invariant: `buildMessages()` immediately reflects
// the record even when the drain timer has not fired yet.

import type { Message } from '@moonshot-ai/kosong';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WiredContextState } from '../../src/storage/context-state.js';
import {
  type LifecycleGate,
  type LifecycleState,
  WiredJournalWriter,
} from '../../src/storage/journal-writer.js';

class StubGate implements LifecycleGate {
  state: LifecycleState = 'active';
}

function concatText(msg: Message): string {
  return msg.content
    .map((c) => (c.type === 'text' ? c.text : c.type === 'think' ? c.think : ''))
    .join('');
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-ctxstate-mv-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeWriterAndState(drainIntervalMs = 50): {
  writer: WiredJournalWriter;
  state: WiredContextState;
} {
  const writer = new WiredJournalWriter({
    filePath: join(workDir, 'wire.jsonl'),
    lifecycle: new StubGate(),
    config: { drainIntervalMs },
  });
  const state = new WiredContextState({
    journalWriter: writer,
    initialModel: 'test-model',
    currentTurnId: () => 't1',
  });
  return { writer, state };
}

describe('ContextState memory visibility — append resolves before disk drain', () => {
  it('appendAssistantMessage is visible via buildMessages before the drain timer fires', async () => {
    vi.useFakeTimers();
    const { writer, state } = makeWriterAndState();

    await state.appendAssistantMessage({
      text: 'hello from memory',
      think: null,
      toolCalls: [],
      model: 'test-model',
    });

    // No timer advance — the record is still in pendingRecords, but the
    // in-memory projection must already expose it.
    const msgs = state.buildMessages();
    const last = msgs[msgs.length - 1];
    expect(last).toBeDefined();
    expect(last?.role).toBe('assistant');
    expect(concatText(last!)).toContain('hello from memory');

    // And the journal has it in memory, not yet on disk.
    expect(writer.pendingRecords.length).toBe(1);
    expect(writer.pendingRecords[0]?.type).toBe('assistant_message');
  });

  it('appendToolResult is visible via buildMessages before the drain timer fires', async () => {
    vi.useFakeTimers();
    const { writer, state } = makeWriterAndState();

    await state.appendToolResult(undefined, 'tc-1', { output: 'tool-output' });

    const msgs = state.buildMessages();
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThan(0);
    expect(writer.pendingRecords.length).toBe(1);
    expect(writer.pendingRecords[0]?.type).toBe('tool_result');
  });

  it('appendUserMessage is visible via buildMessages before the drain timer fires', async () => {
    vi.useFakeTimers();
    const { writer, state } = makeWriterAndState();

    await state.appendUserMessage({ text: 'user-input-early' }, 't1');

    const msgs = state.buildMessages();
    const hasUser = msgs.some((m) => m.role === 'user' && concatText(m).includes('user-input-early'));
    expect(hasUser).toBe(true);
    expect(writer.pendingRecords.length).toBe(1);
    expect(writer.pendingRecords[0]?.type).toBe('user_message');
  });

  it('pendingRecords accumulates across successive ContextState writes in call order', async () => {
    vi.useFakeTimers();
    const { writer, state } = makeWriterAndState();

    await state.appendUserMessage({ text: 'one' }, 't1');
    await state.appendAssistantMessage({
      text: 'two',
      think: null,
      toolCalls: [],
      model: 'test-model',
    });
    await state.appendToolResult(undefined, 'tc-1', { output: 'three' });

    // All three records in memory, in call order — no drain yet.
    expect(writer.pendingRecords.length).toBe(3);
    expect(writer.pendingRecords.map((r) => r.type)).toEqual([
      'user_message',
      'assistant_message',
      'tool_result',
    ]);
    // seq is allocated at push time.
    expect(writer.pendingRecords.map((r) => r.seq)).toEqual([1, 2, 3]);

    // buildMessages sees all three.
    const msgs = state.buildMessages();
    const kinds = msgs.map((m) => m.role);
    expect(kinds).toContain('user');
    expect(kinds).toContain('assistant');
    expect(kinds).toContain('tool');
  });

  it('appendAssistantMessage with usage updates tokenCountWithPending before drain', async () => {
    vi.useFakeTimers();
    const { writer, state } = makeWriterAndState();

    expect(state.tokenCountWithPending).toBe(0);
    await state.appendAssistantMessage({
      text: 'hi',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 10, output_tokens: 7 },
    });

    // tokenCount must be updated as part of the in-memory mirror — not
    // gated on the disk drain.
    expect(state.tokenCountWithPending).toBe(17);
    expect(writer.pendingRecords.length).toBe(1);
  });
});
