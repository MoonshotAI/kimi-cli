// Phase 25 Stage C — Slice 25c-1: ContextState atomic-API behavioural contract.
//
// Scope: the four new append* methods added to the `SoulContextState` /
// `FullContextState` interface (plus the `BaseContextState` implementation):
//   - appendStepBegin(input: StepBeginInput)
//   - appendStepEnd(input: StepEndInput)
//   - appendContentPart(input: ContentPartInput)
//   - appendToolCall(input: ToolCallInput)
//
// These methods pair with the 4 new atomic wire records registered in slice
// 25b (`step_begin` / `step_end` / `content_part` / `tool_call`). This slice
// adds the producer seam on the ContextState side but does NOT switch any
// caller — the Soul / SoulPlus runOnce loops still use the legacy
// `appendAssistantMessage` / `appendToolResult` write path. Caller switch
// lives in slice 25c-2.
//
// Invariants pinned here:
//   - WAL-then-mirror (§4.5.3): each method writes the WAL record FIRST,
//     THEN mutates the in-memory projection. If the WAL write throws, the
//     projection is unchanged.
//   - Strict `stepUuid` anchoring (D-MSG-ID): `appendContentPart` and
//     `appendToolCall` must throw when the referenced `stepUuid` has no
//     matching open `step_begin`. Closing a step via `appendStepEnd` MUST
//     evict the uuid so late parts are rejected.
//   - Parallel steps coexist: two open `step_begin`s with different uuids
//     route their parts to distinct assistant Message mirrors.
//   - In-memory mirror shape matches kosong's `Message` shape
//     (ContentPart.type = 'text' | 'think'; ToolCall.type = 'function').

import { describe, expect, it } from 'vitest';

import {
  InMemoryContextState,
  WiredContextState,
  type FullContextState,
} from '../../src/storage/context-state.js';
import {
  type AppendInput,
  type JournalWriter,
} from '../../src/storage/journal-writer.js';
import type { WireRecord } from '../../src/storage/wire-record.js';

// ── FakeJournalWriter — records appends, optional fail-on hook ─────────

class FakeJournalWriter implements JournalWriter {
  readonly appended: AppendInput[] = [];
  readonly pendingRecords: ReadonlyArray<WireRecord> = [];
  private seq = 0;
  failOn: WireRecord['type'] | undefined;

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

// ── Type extensions — the 4 new Input types the Implementer will ship ──
//
// The test file does not import the Input interfaces from `context-state.ts`
// because at slice-25c-1 Stage 2 time they do not yet exist. Instead we
// describe the call shape via inline structural types; once the Implementer
// lands `StepBeginInput` / `StepEndInput` / `ContentPartInput` /
// `ToolCallInput`, TypeScript will narrow these call shapes through
// structural compatibility and the tests compile straight through.
//
// NOTE: the casts below (`as FullContextState & AtomicCtx`) are the
// single-point extension for the new methods. When the Implementer lands
// the interface update, the casts become no-ops (the methods are already
// on `FullContextState`).

interface StepBeginInput {
  uuid: string;
  turnId: string;
  step: number;
}

interface StepEndInput {
  uuid: string;
  turnId: string;
  step: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  finishReason?: string;
}

interface ContentPartInput {
  uuid: string;
  turnId: string;
  step: number;
  stepUuid: string;
  part:
    | { kind: 'text'; text: string }
    | { kind: 'think'; think: string; encrypted?: string };
}

interface ToolCallInput {
  uuid: string;
  turnId: string;
  step: number;
  stepUuid: string;
  data: {
    tool_call_id: string;
    tool_name: string;
    args: unknown;
    activity_description?: string;
    user_facing_name?: string;
  };
}

interface AtomicCtx {
  appendStepBegin(input: StepBeginInput): Promise<void>;
  appendStepEnd(input: StepEndInput): Promise<void>;
  appendContentPart(input: ContentPartInput): Promise<void>;
  appendToolCall(input: ToolCallInput): Promise<void>;
}

type AtomicContextState = FullContextState & AtomicCtx;

// ── Factories ────────────────────────────────────────────────────────

function makeWired(): { state: AtomicContextState; writer: FakeJournalWriter } {
  const writer = new FakeJournalWriter();
  const state = new WiredContextState({
    journalWriter: writer,
    initialModel: 'moonshot-v1',
    initialSystemPrompt: '',
    currentTurnId: () => 't-default',
  });
  return { state: state as AtomicContextState, writer };
}

function makeInMemory(): InMemoryContextState & AtomicCtx {
  return new InMemoryContextState({
    initialModel: 'moonshot-v1',
    initialSystemPrompt: '',
  }) as InMemoryContextState & AtomicCtx;
}

// ── 1. appendStepBegin ────────────────────────────────────────────────

describe('ContextState.appendStepBegin', () => {
  it('writes a step_begin WAL record and opens an empty assistant Message', async () => {
    const { state, writer } = makeWired();

    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });

    expect(writer.appended).toHaveLength(1);
    expect(writer.appended[0]).toMatchObject({
      type: 'step_begin',
      uuid: 'u-step-1',
      turn_id: 't1',
      step: 0,
    });

    const messages = state.buildMessages();
    expect(messages).toHaveLength(1);
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toEqual([]);
    expect(last.toolCalls).toEqual([]);
  });

  it('does not change tokenCountWithPending on step_begin', async () => {
    const { state } = makeWired();
    const before = state.tokenCountWithPending;
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });
    expect(state.tokenCountWithPending).toBe(before);
  });

  it('InMemoryContextState mirrors the open step without WAL writes', async () => {
    const state = makeInMemory();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });

    const messages = state.buildMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('assistant');
  });
});

// ── 2. appendContentPart ─────────────────────────────────────────────

describe('ContextState.appendContentPart — text branch', () => {
  it('persists a content_part WAL record and appends a text ContentPart to the open Message', async () => {
    const { state, writer } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });

    await state.appendContentPart({
      uuid: 'u-part-1',
      turnId: 't1',
      step: 0,
      stepUuid: 'u-step-1',
      part: { kind: 'text', text: 'hello' },
    });

    expect(writer.appended).toHaveLength(2);
    const partRow = writer.appended[1] as AppendInput & { type: 'content_part' };
    expect(partRow.type).toBe('content_part');
    expect(partRow.uuid).toBe('u-part-1');
    expect(partRow.turn_id).toBe('t1');
    expect(partRow.step).toBe(0);
    expect(partRow.step_uuid).toBe('u-step-1');
    expect(partRow.role).toBe('assistant');
    expect(partRow.part).toEqual({ kind: 'text', text: 'hello' });

    // Kosong's ContentPart discriminator is `type`, not `kind` — the
    // mirror must adapt `{kind:'text', text}` → `{type:'text', text}`.
    const messages = state.buildMessages();
    const last = messages[messages.length - 1]!;
    expect(last.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('appends each text part verbatim (no concatenation between parts)', async () => {
    const { state } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });
    await state.appendContentPart({
      uuid: 'u-part-a',
      turnId: 't1',
      step: 0,
      stepUuid: 'u-step-1',
      part: { kind: 'text', text: 'A' },
    });
    await state.appendContentPart({
      uuid: 'u-part-b',
      turnId: 't1',
      step: 0,
      stepUuid: 'u-step-1',
      part: { kind: 'text', text: 'B' },
    });

    const last = state.buildMessages().at(-1)!;
    // Concatenation is a replay-reconstruct concern (25c-3); the live
    // mirror MUST keep the atomic rows independent so replay matches.
    expect(last.content).toEqual([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
    ]);
  });
});

describe('ContextState.appendContentPart — think branch', () => {
  it('persists a think part without encrypted payload', async () => {
    const { state, writer } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });

    await state.appendContentPart({
      uuid: 'u-part-1',
      turnId: 't1',
      step: 0,
      stepUuid: 'u-step-1',
      part: { kind: 'think', think: 'let me think' },
    });

    const partRow = writer.appended[1] as AppendInput & { type: 'content_part' };
    expect(partRow.part).toEqual({ kind: 'think', think: 'let me think' });

    const last = state.buildMessages().at(-1)!;
    // Kosong's ThinkPart uses `think` field. `encrypted` is optional and
    // not present here; the mirror must omit it rather than stamp undefined.
    expect(last.content).toHaveLength(1);
    const thinkPart = last.content[0]! as { type: 'think'; think: string };
    expect(thinkPart.type).toBe('think');
    expect(thinkPart.think).toBe('let me think');
    expect((thinkPart as { encrypted?: string }).encrypted).toBeUndefined();
  });

  it('persists a think part with encrypted signature', async () => {
    const { state, writer } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });

    await state.appendContentPart({
      uuid: 'u-part-1',
      turnId: 't1',
      step: 0,
      stepUuid: 'u-step-1',
      part: { kind: 'think', think: 'private', encrypted: 'sig-xyz' },
    });

    const partRow = writer.appended[1] as AppendInput & { type: 'content_part' };
    expect(partRow.part).toEqual({ kind: 'think', think: 'private', encrypted: 'sig-xyz' });

    const last = state.buildMessages().at(-1)!;
    const thinkPart = last.content[0]! as { type: 'think'; think: string; encrypted?: string };
    expect(thinkPart.type).toBe('think');
    expect(thinkPart.think).toBe('private');
    expect(thinkPart.encrypted).toBe('sig-xyz');
  });
});

// ── 3. appendToolCall ────────────────────────────────────────────────

describe('ContextState.appendToolCall', () => {
  it('persists a tool_call WAL record and pushes a kosong ToolCall onto the open Message', async () => {
    const { state, writer } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });

    await state.appendToolCall({
      uuid: 'u-tc-1',
      turnId: 't1',
      step: 0,
      stepUuid: 'u-step-1',
      data: {
        tool_call_id: 'tc_1',
        tool_name: 'Bash',
        args: { cmd: 'ls' },
      },
    });

    const tcRow = writer.appended[1] as AppendInput & { type: 'tool_call' };
    expect(tcRow.type).toBe('tool_call');
    expect(tcRow.uuid).toBe('u-tc-1');
    expect(tcRow.step_uuid).toBe('u-step-1');
    expect(tcRow.data.tool_call_id).toBe('tc_1');
    expect(tcRow.data.tool_name).toBe('Bash');
    expect(tcRow.data.args).toEqual({ cmd: 'ls' });
    // Display hints omitted on input → must not materialise as
    // `undefined`-valued keys on the wire row (append helpers strip them).
    expect(tcRow.data.activity_description).toBeUndefined();
    expect(tcRow.data.user_facing_name).toBeUndefined();
    expect(tcRow.data.input_display).toBeUndefined();

    const last = state.buildMessages().at(-1)!;
    expect(last.toolCalls).toHaveLength(1);
    const [call] = last.toolCalls;
    expect(call!.type).toBe('function');
    expect(call!.id).toBe('tc_1');
    expect(call!.function.name).toBe('Bash');
    // kosong ToolCall.function.arguments is a string (JSON-serialised).
    expect(call!.function.arguments).toBe(JSON.stringify({ cmd: 'ls' }));
  });

  it('forwards optional display hints to the WAL record when provided', async () => {
    const { state, writer } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });

    await state.appendToolCall({
      uuid: 'u-tc-1',
      turnId: 't1',
      step: 0,
      stepUuid: 'u-step-1',
      data: {
        tool_call_id: 'tc_2',
        tool_name: 'Read',
        args: { file: '/tmp/x' },
        activity_description: 'Reading /tmp/x',
        user_facing_name: 'Read file',
      },
    });

    const tcRow = writer.appended[1] as AppendInput & { type: 'tool_call' };
    expect(tcRow.data.activity_description).toBe('Reading /tmp/x');
    expect(tcRow.data.user_facing_name).toBe('Read file');
  });

  it('JSON-serialises non-object args shapes into ToolCall.function.arguments', async () => {
    const { state } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });

    // null
    await state.appendToolCall({
      uuid: 'u-tc-a',
      turnId: 't1',
      step: 0,
      stepUuid: 'u-step-1',
      data: { tool_call_id: 'tc_a', tool_name: 'Null', args: null },
    });
    // primitive string — JSON-encoded string (double quotes included)
    await state.appendToolCall({
      uuid: 'u-tc-b',
      turnId: 't1',
      step: 0,
      stepUuid: 'u-step-1',
      data: { tool_call_id: 'tc_b', tool_name: 'Str', args: 'hello' },
    });
    // nested object
    await state.appendToolCall({
      uuid: 'u-tc-c',
      turnId: 't1',
      step: 0,
      stepUuid: 'u-step-1',
      data: { tool_call_id: 'tc_c', tool_name: 'Deep', args: { outer: { inner: 1 } } },
    });

    const last = state.buildMessages().at(-1)!;
    expect(last.toolCalls).toHaveLength(3);
    expect(last.toolCalls[0]!.function.arguments).toBe('null');
    expect(last.toolCalls[1]!.function.arguments).toBe('"hello"');
    expect(last.toolCalls[2]!.function.arguments).toBe(
      JSON.stringify({ outer: { inner: 1 } }),
    );
  });
});

// ── 4. appendStepEnd ─────────────────────────────────────────────────

describe('ContextState.appendStepEnd', () => {
  it('writes a step_end WAL record and updates tokenCountWithPending from usage', async () => {
    const { state, writer } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });

    await state.appendStepEnd({
      uuid: 'u-step-1',
      turnId: 't1',
      step: 0,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
      },
      finishReason: 'stop',
    });

    const endRow = writer.appended[1] as AppendInput & { type: 'step_end' };
    expect(endRow.type).toBe('step_end');
    expect(endRow.uuid).toBe('u-step-1');
    expect(endRow.turn_id).toBe('t1');
    expect(endRow.step).toBe(0);
    expect(endRow.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
    });
    expect(endRow.finish_reason).toBe('stop');

    // Token counter follows the same rule as the legacy
    // `appendAssistantMessage` path: input + output (cache counters are
    // audit-only and must NOT be double-billed).
    expect(state.tokenCountWithPending).toBe(120);
  });

  it('does not change tokenCountWithPending when usage is omitted', async () => {
    const { state } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });

    const before = state.tokenCountWithPending;
    await state.appendStepEnd({ uuid: 'u-step-1', turnId: 't1', step: 0 });
    expect(state.tokenCountWithPending).toBe(before);
  });

  it('closes the open step so a late content_part on the same stepUuid throws', async () => {
    const { state } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });
    await state.appendStepEnd({ uuid: 'u-step-1', turnId: 't1', step: 0 });

    await expect(
      state.appendContentPart({
        uuid: 'u-late',
        turnId: 't1',
        step: 0,
        stepUuid: 'u-step-1',
        part: { kind: 'text', text: 'late arrival' },
      }),
    ).rejects.toThrow();
  });
});

// ── 5. Strict stepUuid anchoring ────────────────────────────────────

describe('ContextState atomic-API — strict stepUuid check (D-MSG-ID)', () => {
  it('appendContentPart throws when stepUuid has no matching open step_begin', async () => {
    const { state } = makeWired();

    await expect(
      state.appendContentPart({
        uuid: 'u-part-1',
        turnId: 't1',
        step: 0,
        stepUuid: 'u-never-opened',
        part: { kind: 'text', text: 'orphan' },
      }),
    ).rejects.toThrow(/stepUuid/i);
  });

  it('appendToolCall throws when stepUuid has no matching open step_begin', async () => {
    const { state } = makeWired();

    await expect(
      state.appendToolCall({
        uuid: 'u-tc-1',
        turnId: 't1',
        step: 0,
        stepUuid: 'u-never-opened',
        data: { tool_call_id: 'tc_x', tool_name: 'Noop', args: {} },
      }),
    ).rejects.toThrow(/stepUuid/i);
  });

  it('strict check fires BEFORE the WAL write (no orphan content_part row lands on disk)', async () => {
    const { state, writer } = makeWired();

    await expect(
      state.appendContentPart({
        uuid: 'u-part-1',
        turnId: 't1',
        step: 0,
        stepUuid: 'u-not-open',
        part: { kind: 'text', text: 'orphan' },
      }),
    ).rejects.toThrow();

    // No WAL append at all — the orphan would corrupt replay if persisted.
    expect(writer.appended.filter((r) => r.type === 'content_part')).toHaveLength(0);
  });
});

// ── 6. Multi-step coexistence ───────────────────────────────────────

describe('ContextState atomic-API — multiple open steps coexist', () => {
  it('routes content parts to the correct open step by stepUuid', async () => {
    const { state } = makeWired();

    await state.appendStepBegin({ uuid: 'u-step-a', turnId: 't1', step: 0 });
    await state.appendStepBegin({ uuid: 'u-step-b', turnId: 't1', step: 1 });

    await state.appendContentPart({
      uuid: 'u-part-a1',
      turnId: 't1',
      step: 0,
      stepUuid: 'u-step-a',
      part: { kind: 'text', text: 'from-A' },
    });
    await state.appendContentPart({
      uuid: 'u-part-b1',
      turnId: 't1',
      step: 1,
      stepUuid: 'u-step-b',
      part: { kind: 'text', text: 'from-B' },
    });

    const messages = state.buildMessages();
    // Two distinct assistant messages — one per open step.
    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
    // Step-A was opened first so its Message is earlier in history.
    expect(assistantMsgs[0]!.content).toEqual([{ type: 'text', text: 'from-A' }]);
    expect(assistantMsgs[1]!.content).toEqual([{ type: 'text', text: 'from-B' }]);
  });

  it('closing one step leaves the other step open and still writable', async () => {
    const { state } = makeWired();
    await state.appendStepBegin({ uuid: 'u-step-a', turnId: 't1', step: 0 });
    await state.appendStepBegin({ uuid: 'u-step-b', turnId: 't1', step: 1 });

    await state.appendStepEnd({ uuid: 'u-step-a', turnId: 't1', step: 0 });

    // step-b is still open → part must land.
    await state.appendContentPart({
      uuid: 'u-part-b1',
      turnId: 't1',
      step: 1,
      stepUuid: 'u-step-b',
      part: { kind: 'text', text: 'b-after-a-ended' },
    });

    // step-a closed → its parts must be rejected.
    await expect(
      state.appendContentPart({
        uuid: 'u-late-a',
        turnId: 't1',
        step: 0,
        stepUuid: 'u-step-a',
        part: { kind: 'text', text: 'too late' },
      }),
    ).rejects.toThrow();

    const assistantMsgs = state.buildMessages().filter((m) => m.role === 'assistant');
    const stepBMsg = assistantMsgs.at(-1)!;
    expect(stepBMsg.content).toEqual([{ type: 'text', text: 'b-after-a-ended' }]);
  });
});

// ── 7. WAL-then-mirror atomicity (per method) ───────────────────────

describe('ContextState atomic-API — WAL-then-mirror atomicity', () => {
  it('appendStepBegin leaves history unchanged when the journal write throws', async () => {
    const writer = new FakeJournalWriter();
    writer.failOn = 'step_begin';
    const state = new WiredContextState({
      journalWriter: writer,
      initialModel: 'moonshot-v1',
      initialSystemPrompt: '',
      currentTurnId: () => 't1',
    }) as AtomicContextState;

    const before = state.buildMessages().length;
    await expect(
      state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 }),
    ).rejects.toThrow();
    expect(state.buildMessages().length).toBe(before);
  });

  it('appendContentPart leaves history unchanged when the journal write throws', async () => {
    const writer = new FakeJournalWriter();
    const state = new WiredContextState({
      journalWriter: writer,
      initialModel: 'moonshot-v1',
      initialSystemPrompt: '',
      currentTurnId: () => 't1',
    }) as AtomicContextState;

    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });
    // Snapshot the projection after the (successful) step_begin.
    const snapshotLen = state.buildMessages().at(-1)!.content.length;

    writer.failOn = 'content_part';
    await expect(
      state.appendContentPart({
        uuid: 'u-part-1',
        turnId: 't1',
        step: 0,
        stepUuid: 'u-step-1',
        part: { kind: 'text', text: 'should not land' },
      }),
    ).rejects.toThrow();

    const postFailLen = state.buildMessages().at(-1)!.content.length;
    expect(postFailLen).toBe(snapshotLen);
  });

  it('appendToolCall leaves history unchanged when the journal write throws', async () => {
    const writer = new FakeJournalWriter();
    const state = new WiredContextState({
      journalWriter: writer,
      initialModel: 'moonshot-v1',
      initialSystemPrompt: '',
      currentTurnId: () => 't1',
    }) as AtomicContextState;

    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });
    const snapshotToolCalls = state.buildMessages().at(-1)!.toolCalls.length;

    writer.failOn = 'tool_call';
    await expect(
      state.appendToolCall({
        uuid: 'u-tc-1',
        turnId: 't1',
        step: 0,
        stepUuid: 'u-step-1',
        data: { tool_call_id: 'tc_1', tool_name: 'Bash', args: {} },
      }),
    ).rejects.toThrow();

    expect(state.buildMessages().at(-1)!.toolCalls.length).toBe(snapshotToolCalls);
  });

  it('appendStepEnd leaves tokenCountWithPending + openSteps unchanged when the journal write throws', async () => {
    const writer = new FakeJournalWriter();
    const state = new WiredContextState({
      journalWriter: writer,
      initialModel: 'moonshot-v1',
      initialSystemPrompt: '',
      currentTurnId: () => 't1',
    }) as AtomicContextState;

    await state.appendStepBegin({ uuid: 'u-step-1', turnId: 't1', step: 0 });
    const beforeTokens = state.tokenCountWithPending;

    writer.failOn = 'step_end';
    await expect(
      state.appendStepEnd({
        uuid: 'u-step-1',
        turnId: 't1',
        step: 0,
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
    ).rejects.toThrow();

    // Token counter must NOT advance when the WAL write failed — the
    // "accounting in memory" is load-bearing for compaction trigger logic.
    expect(state.tokenCountWithPending).toBe(beforeTokens);

    // The open step must STILL be open — a failed step_end cannot silently
    // close the step; a retry has to be able to land the same stepEnd
    // without the second `appendContentPart` blowing up on a stale uuid.
    writer.failOn = undefined;
    await expect(
      state.appendContentPart({
        uuid: 'u-part-retry',
        turnId: 't1',
        step: 0,
        stepUuid: 'u-step-1',
        part: { kind: 'text', text: 'still-open' },
      }),
    ).resolves.toBeUndefined();
  });
});
