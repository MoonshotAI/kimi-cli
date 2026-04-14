// Component: WiredContextState (§4.5.2-4.5.5)
// Covers: FullContextState interface, atomic write → mirror invariant,
// buildMessages() sync read, drainSteerMessages() side effect, config
// change application.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ConfigChangeEvent, WiredContextState } from '../../src/storage/context-state.js';
import {
  type LifecycleGate,
  type LifecycleState,
  WiredJournalWriter,
} from '../../src/storage/journal-writer.js';

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
  });
  const state = new WiredContextState({
    journalWriter: writer,
    initialModel: 'moonshot-v1',
    initialSystemPrompt: 'you are helpful',
    currentTurnId: () => 't1',
  });
  return { state, filePath };
}

describe('WiredContextState — initial state', () => {
  it('exposes the constructor-provided defaults synchronously', () => {
    const { state } = makeState();
    expect(state.model).toBe('moonshot-v1');
    expect(state.systemPrompt).toBe('you are helpful');
    expect(state.tokenCountWithPending).toBe(0);
    expect(state.buildMessages()).toEqual([]);
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
