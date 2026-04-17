// Component: WiredContextState (§4.5.2-4.5.5)
// Covers: FullContextState interface, atomic write → mirror invariant,
// buildMessages() sync read, drainSteerMessages() side effect, config
// change application.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ConfigChangeEvent,
  InMemoryContextState,
  WiredContextState,
} from '../../src/storage/context-state.js';
import {
  type LifecycleGate,
  type LifecycleState,
  WiredJournalWriter,
} from '../../src/storage/journal-writer.js';
import { replayWire } from '../../src/storage/replay.js';

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
  workDir = await mkdtemp(join(tmpdir(), 'kimi-wired-cs-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeState(): {
  state: WiredContextState;
  filePath: string;
} {
  const filePath = join(workDir, 'wire.jsonl');
  const writer = new WiredJournalWriter({
    filePath,
    lifecycle: new StubGate(),
    // Phase 3: lock this suite to the legacy per-record fsync so its
    // "append → read file back" assertions keep observing synchronous
    // disk state. The batched-drain semantics are covered by the
    // Phase 3 async-batch suites.
    config: { fsyncMode: 'per-record' },
  });
  const state = new WiredContextState({
    journalWriter: writer,
    initialModel: 'moonshot-v1',
    // Baseline state uses an empty system prompt so tests about history
    // length aren't thrown off by a leading system Message. System prompt
    // projection semantics are exercised in their own describe block below.
    initialSystemPrompt: '',
    currentTurnId: () => 't1',
  });
  return { state, filePath };
}

describe('WiredContextState — initial state', () => {
  it('exposes the constructor-provided defaults synchronously', () => {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
    });
    const state = new WiredContextState({
      journalWriter: writer,
      initialModel: 'moonshot-v1',
      initialSystemPrompt: 'you are helpful',
      currentTurnId: () => 't1',
    });
    expect(state.model).toBe('moonshot-v1');
    expect(state.systemPrompt).toBe('you are helpful');
    expect(state.tokenCountWithPending).toBe(0);
    // Slice 2.0 方案 B: projector no longer injects system message into
    // buildMessages(). System prompt is forwarded via ChatParams.systemPrompt.
    const messages = state.buildMessages();
    expect(messages.length).toBe(0);
  });
});

describe('WiredContextState — appendUserMessage', () => {
  it('persists the record and mirrors it into buildMessages', async () => {
    const { state, filePath } = makeState();

    await state.appendUserMessage({ text: 'hi' });

    const records = await readWireRecords(filePath);
    const userRecords = records.filter((r) => r['type'] === 'user_message');
    expect(userRecords.length).toBe(1);
    expect(userRecords[0]?.['content']).toBe('hi');

    const messages = state.buildMessages();
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe('user');
  });
});

describe('WiredContextState — appendAssistantMessage', () => {
  it('writes an assistant_message record and surfaces it in buildMessages', async () => {
    const { state, filePath } = makeState();

    await state.appendUserMessage({ text: 'what is 2+2?' });
    await state.appendAssistantMessage({
      text: '4',
      think: null,
      toolCalls: [],
      model: 'moonshot-v1',
    });

    const records = await readWireRecords(filePath);
    expect(records.filter((r) => r['type'] === 'assistant_message').length).toBe(1);

    const messages = state.buildMessages();
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('updates tokenCountWithPending when usage is included', async () => {
    const { state } = makeState();

    await state.appendAssistantMessage({
      text: 'ok',
      think: null,
      toolCalls: [],
      model: 'moonshot-v1',
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    // Implementation is free to use either cumulative count from usage or
    // an internal estimator — but it MUST move off zero after a real
    // assistant turn with reported usage.
    expect(state.tokenCountWithPending).toBeGreaterThan(0);
  });
});

describe('WiredContextState — appendToolResult', () => {
  it('persists a tool_result record keyed by tool_call_id', async () => {
    const { state, filePath } = makeState();

    await state.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_1', name: 'Read', args: { file: 'f' } }],
      model: 'moonshot-v1',
    });
    await state.appendToolResult('tc_1', { output: 'file contents' });

    const records = await readWireRecords(filePath);
    const resultRow = records.find((r) => r['type'] === 'tool_result');
    expect(resultRow).toBeDefined();
    expect(resultRow?.['tool_call_id']).toBe('tc_1');
    expect(resultRow?.['output']).toBe('file contents');
  });
});

describe('WiredContextState — applyConfigChange', () => {
  it('system_prompt change is persisted and reflected synchronously', async () => {
    const { state, filePath } = makeState();

    const event: ConfigChangeEvent = {
      type: 'system_prompt_changed',
      new_prompt: 'new prompt',
    };
    await state.applyConfigChange(event);

    expect(state.systemPrompt).toBe('new prompt');
    const records = await readWireRecords(filePath);
    expect(records.some((r) => r['type'] === 'system_prompt_changed')).toBe(true);
  });

  it('model change is persisted and updates .model', async () => {
    const { state, filePath } = makeState();

    await state.applyConfigChange({
      type: 'model_changed',
      old_model: 'moonshot-v1',
      new_model: 'moonshot-v2',
    });

    expect(state.model).toBe('moonshot-v2');
    const records = await readWireRecords(filePath);
    expect(records.some((r) => r['type'] === 'model_changed')).toBe(true);
  });

  it('tools change is persisted and updates activeTools for set_active', async () => {
    const { state, filePath } = makeState();

    await state.applyConfigChange({
      type: 'tools_changed',
      operation: 'set_active',
      tools: ['Read', 'Write'],
    });

    expect(new Set(state.activeTools)).toEqual(new Set(['Read', 'Write']));
    const records = await readWireRecords(filePath);
    expect(records.some((r) => r['type'] === 'tools_changed')).toBe(true);
  });
});

describe('WiredContextState — resetToSummary (compaction write path)', () => {
  it('replaces the in-memory history with the summary snapshot', async () => {
    const { state } = makeState();

    await state.appendUserMessage({ text: 'very long conversation turn 1' });
    await state.appendAssistantMessage({
      text: 'reply',
      think: null,
      toolCalls: [],
      model: 'moonshot-v1',
    });

    await state.resetToSummary({
      summary: 'user asked about foo; assistant replied',
      compactedRange: { fromTurn: 0, toTurn: 0, messageCount: 2 },
      preCompactTokens: 5000,
      postCompactTokens: 200,
      trigger: 'manual',
    });

    // After compaction, buildMessages is allowed to return either an
    // empty history or a single synthetic summary message — the contract
    // is just that the prior two live messages are gone from the
    // projection. (The actual wire file still contains the records;
    // compaction only rewrites the *projection*.)
    const messages = state.buildMessages();
    expect(messages.length).toBeLessThanOrEqual(1);
  });
});

describe('WiredContextState — drainSteerMessages', () => {
  it('returns pushed steers exactly once', () => {
    const { state } = makeState();
    state.pushSteer({ text: 'wait, also do X' });
    state.pushSteer({ text: 'and Y' });

    const first = state.drainSteerMessages();
    expect(first.map((s) => s.text)).toEqual(['wait, also do X', 'and Y']);

    const second = state.drainSteerMessages();
    expect(second).toEqual([]);
  });
});

// ── Slice 1 audit M3: `undefined` output normalisation ─────────────────
//
// Regression coverage for `PHASE1_AUDIT_slice1.md` M3:
//   `ToolResultPayload.output` is typed `unknown`, which includes
//   `undefined`. Before the fix, `appendToolResult({output: undefined})`
//   produced two correlated bugs:
//     1. `JSON.stringify({..., output: undefined})` silently drops the
//        `output` field, so the persisted `tool_result` row is missing a
//        contract-required field, and replay has to decide whether to
//        break the session.
//     2. The in-memory mirror pushed `text: undefined` into a TextPart,
//        which would crash any downstream reader.
//   The fix normalises `undefined` → `null` inside `appendToolResult`.
describe('WiredContextState — appendToolResult undefined output (Slice 1 audit M3)', () => {
  it('normalises `output: undefined` to null in the InMemory history mirror', async () => {
    const state = new InMemoryContextState({ initialModel: 'moonshot-v1' });
    await state.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_x', name: 'Noop', args: {} }],
      model: 'moonshot-v1',
    });
    await state.appendToolResult('tc_x', { output: undefined });

    const messages = state.buildMessages();
    const toolMsg = messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    // The in-memory mirror must carry a real text string (`JSON.stringify(null)`
    // = "null"), NOT literal `undefined` — any `text: undefined` is a bug.
    const textPart = toolMsg!.content.find((p) => p.type === 'text') as
      | { type: 'text'; text: string }
      | undefined;
    expect(textPart).toBeDefined();
    expect(typeof textPart!.text).toBe('string');
    expect(textPart!.text).toBe('null');
  });

  it('persists `output: undefined` as `output: null`, replayable with schema ok', async () => {
    const { state, filePath } = makeState();
    await state.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_1', name: 'Noop', args: {} }],
      model: 'moonshot-v1',
    });
    await state.appendToolResult('tc_1', { output: undefined });

    // Raw disk check: the persisted row must contain the literal key
    // `"output":null`, never a missing key.
    const records = await readWireRecords(filePath);
    const toolResultRow = records.find((r) => r['type'] === 'tool_result');
    expect(toolResultRow).toBeDefined();
    expect('output' in toolResultRow!).toBe(true);
    expect(toolResultRow!['output']).toBeNull();

    // Replay must produce a valid record — no schema violation, no broken
    // session, and the replayed `output` is `null` (not `undefined`).
    const result = await replayWire(filePath, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    const replayedToolResult = result.records.find((r) => r.type === 'tool_result');
    if (replayedToolResult === undefined || replayedToolResult.type !== 'tool_result') {
      throw new Error('expected a replayed tool_result record');
    }
    expect(replayedToolResult.output).toBeNull();
  });

  it('leaves non-undefined outputs untouched (normal path)', async () => {
    const { state, filePath } = makeState();
    await state.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_2', name: 'Echo', args: {} }],
      model: 'moonshot-v1',
    });
    await state.appendToolResult('tc_2', { output: 'normal string' });

    const records = await readWireRecords(filePath);
    const toolResultRow = records.find((r) => r['type'] === 'tool_result');
    expect(toolResultRow!['output']).toBe('normal string');
  });
});

describe('WiredContextState — atomicity (WAL-then-mirror)', () => {
  it('when the journal write fails, the in-memory projection is not changed', async () => {
    const filePath = join(workDir, 'wire.jsonl');
    const gate: StubGate = new StubGate();
    const writer = new WiredJournalWriter({ filePath, lifecycle: gate });
    const state = new WiredContextState({
      journalWriter: writer,
      initialModel: 'moonshot-v1',
      initialSystemPrompt: 'sp',
      currentTurnId: () => 't1',
    });

    await state.appendUserMessage({ text: 'first' });
    const beforeLen = state.buildMessages().length;

    // Flip the gate to compacting so the next write throws.
    gate.state = 'compacting';
    await expect(state.appendUserMessage({ text: 'blocked' })).rejects.toThrow();

    const afterLen = state.buildMessages().length;
    expect(afterLen).toBe(beforeLen);
  });
});
