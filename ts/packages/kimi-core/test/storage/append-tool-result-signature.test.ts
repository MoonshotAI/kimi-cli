/**
 * Phase 25 Stage C — Slice 25c-2 behaviour E: `appendToolResult` signature.
 *
 * Slice 25c-2 prepends `parentUuid: string | undefined` to both the
 * SoulContextState and FullContextState `appendToolResult` methods:
 *
 *   appendToolResult(
 *     parentUuid: string | undefined,
 *     toolCallId: string,
 *     result: ToolResultPayload,
 *     turnIdOverride?: string,  // FullContextState only
 *   ): Promise<void>;
 *
 * The `parentUuid` maps onto the `parent_uuid` field on the wire
 * `tool_result` record (§A.2, added in slice 25b). This lets the
 * replay-projector reconstruct the tool_call → tool_result parent link
 * without scanning the history for a matching tool_call_id.
 *
 * Pins:
 *   - Passing a real `parentUuid` persists it on the wire row.
 *   - Passing `undefined` omits the field on the wire row (doesn't
 *     materialise as `parent_uuid: undefined`).
 *   - `turnIdOverride` still works alongside the new leading param.
 *   - The in-memory projection produces a tool Message regardless of
 *     the parentUuid value (parentUuid is archival metadata, not a
 *     projection input).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InMemoryContextState,
  WiredContextState,
} from '../../src/storage/context-state.js';
import {
  type LifecycleGate,
  type LifecycleState,
  WiredJournalWriter,
} from '../../src/storage/journal-writer.js';

class StubGate implements LifecycleGate {
  state: LifecycleState = 'active';
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-tr-sig-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function readWireRecords(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function makeWired(): { state: WiredContextState; filePath: string } {
  const filePath = join(workDir, 'wire.jsonl');
  const writer = new WiredJournalWriter({
    filePath,
    lifecycle: new StubGate(),
    // per-record fsync keeps "append then read file" synchronous so
    // these assertions don't need to wait on a drain timer.
    config: { fsyncMode: 'per-record' },
  });
  const state = new WiredContextState({
    journalWriter: writer,
    initialModel: 'moonshot-v1',
    initialSystemPrompt: '',
    currentTurnId: () => 't1',
  });
  return { state, filePath };
}

describe('WiredContextState.appendToolResult — 4-arg signature (25c-2 behaviour E)', () => {
  it('persists parent_uuid when parentUuid is a real string', async () => {
    const { state, filePath } = makeWired();

    await state.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_1', name: 'Read', args: { file: 'f' } }],
      model: 'moonshot-v1',
    });
    await state.appendToolResult('u-parent-tool-call', 'tc_1', {
      output: 'hello',
    });

    const records = await readWireRecords(filePath);
    const row = records.find((r) => r['type'] === 'tool_result');
    expect(row).toBeDefined();
    expect(row?.['tool_call_id']).toBe('tc_1');
    expect(row?.['parent_uuid']).toBe('u-parent-tool-call');
  });

  it('omits parent_uuid from the wire row when parentUuid is undefined', async () => {
    const { state, filePath } = makeWired();

    await state.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_2', name: 'Read', args: { file: 'f' } }],
      model: 'moonshot-v1',
    });
    await state.appendToolResult(undefined, 'tc_2', { output: 'world' });

    const records = await readWireRecords(filePath);
    const row = records.find((r) => r['type'] === 'tool_result');
    expect(row).toBeDefined();
    // Passing `undefined` must not stamp `parent_uuid: undefined` onto
    // the persisted row — JSON would drop the key on serialise anyway,
    // but we assert it explicitly so the schema's "field omitted" shape
    // survives the round-trip.
    expect(Object.hasOwn(row!, 'parent_uuid')).toBe(false);
  });

  it('turnIdOverride continues to work as the 4th positional argument', async () => {
    const { state, filePath } = makeWired();

    await state.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_3', name: 'Read', args: {} }],
      model: 'moonshot-v1',
    });
    await state.appendToolResult('u-parent', 'tc_3', { output: 'override' }, 't-override');

    const records = await readWireRecords(filePath);
    const row = records.find((r) => r['type'] === 'tool_result');
    expect(row?.['turn_id']).toBe('t-override');
    expect(row?.['parent_uuid']).toBe('u-parent');
  });

  it('projects a tool Message regardless of parentUuid value', async () => {
    const { state } = makeWired();

    await state.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_4', name: 'Read', args: {} }],
      model: 'moonshot-v1',
    });
    await state.appendToolResult(undefined, 'tc_4', { output: 'mirror' });

    const msgs = state.buildMessages();
    const tool = msgs.find((m) => m.role === 'tool');
    expect(tool).toBeDefined();
  });
});

describe('InMemoryContextState.appendToolResult — 4-arg signature (SoulContextState shape)', () => {
  it('accepts the new leading parentUuid argument and projects a tool Message', async () => {
    const state = new InMemoryContextState({
      initialModel: 'moonshot-v1',
      initialSystemPrompt: '',
    });

    await state.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_7', name: 'Read', args: {} }],
      model: 'moonshot-v1',
    });
    await state.appendToolResult('u-parent', 'tc_7', { output: 'x' });

    const msgs = state.buildMessages();
    const tool = msgs.find((m) => m.role === 'tool');
    expect(tool).toBeDefined();
  });

  it('accepts undefined parentUuid without throwing', async () => {
    const state = new InMemoryContextState({
      initialModel: 'moonshot-v1',
      initialSystemPrompt: '',
    });

    await state.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_8', name: 'Read', args: {} }],
      model: 'moonshot-v1',
    });
    await expect(
      state.appendToolResult(undefined, 'tc_8', { output: 'y' }),
    ).resolves.toBeUndefined();
  });
});
