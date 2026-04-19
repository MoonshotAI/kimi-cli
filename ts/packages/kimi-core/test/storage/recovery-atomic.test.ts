/**
 * Phase 25 Stage G — slice 25c-4b: atomic-aware crash-recovery contract.
 *
 * This suite pins the new recovery-detection API that slice 25c-4b adds to
 * `recovery.ts`, plus the extended behaviour of the existing
 * `findDanglingToolCalls` / `repairJournal` entry points once the atomic
 * record stream (25b) is in play.
 *
 * Scope (pre-impl red baseline):
 *   A. `findDanglingSteps`          — new API
 *   B. `findDanglingSubagents`      — new API
 *   C. `findDanglingToolCalls`      — now scans legacy AND atomic paths
 *   D. `repairJournal`              — 3 new synthetic phases land here
 *
 * Design decisions this file pins (Coordinator questions C.6–C.8):
 *   - Atomic `tool_call` ↔ `tool_result` match requires a populated
 *     `parent_uuid` on the tool_result. A tool_result that carries only
 *     `tool_call_id` is treated as *legacy* and matches through the
 *     `assistant_message.tool_calls[].id` set.
 *   - When the same `tool_call_id` appears in BOTH a legacy
 *     `assistant_message` entry and an atomic `tool_call` row, the atomic
 *     entry wins — legacy is deduplicated so a dangling pair is not
 *     double-reported.
 *   - Atomic `tool_call` with a matching `tool_call_id` on some
 *     `tool_result` BUT no `parent_uuid` still counts as dangling — the
 *     atomic path only resolves through `parent_uuid`.
 */

import { describe, expect, it, vi } from 'vitest';

import { InMemoryContextState } from '../../src/storage/context-state.js';
import type { FullContextState, ToolResultPayload } from '../../src/storage/context-state.js';
import type { JournalInput } from '../../src/storage/wire-record.js';
import {
  findDanglingSteps,
  findDanglingSubagents,
  findDanglingToolCalls,
  repairJournal,
  type DanglingStep,
  type DanglingSubagent,
  type DanglingToolCall,
} from '../../src/storage/recovery.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import type { SessionJournal } from '../../src/storage/session-journal.js';
import type { WireRecord } from '../../src/storage/wire-record.js';

// ── Fixture builders ───────────────────────────────────────────────────
//
// The helpers below build WireRecords shaped like real wire.jsonl rows.
// Every helper hand-sets `seq` so tests can assert on ordering-independent
// detection. `time` is stamped off a counter so rows are unique-in-time
// regardless of clock resolution.

let timeSeed = 1_700_000_000_000;
function nextTime(): number {
  timeSeed += 1;
  return timeSeed;
}

function turnBegin(turnId: string, seq: number): WireRecord {
  return {
    type: 'turn_begin',
    seq,
    time: nextTime(),
    turn_id: turnId,
    agent_type: 'main',
    input_kind: 'user',
  } as WireRecord;
}

function userMessage(turnId: string, seq: number, text = 'hi'): WireRecord {
  return {
    type: 'user_message',
    seq,
    time: nextTime(),
    turn_id: turnId,
    content: text,
  } as WireRecord;
}

function assistantMessage(
  turnId: string,
  seq: number,
  toolCalls: Array<{ id: string; name: string; args: unknown }> = [],
): WireRecord {
  return {
    type: 'assistant_message',
    seq,
    time: nextTime(),
    turn_id: turnId,
    text: 'response',
    think: null,
    tool_calls: toolCalls,
    model: 'test-model',
  } as WireRecord;
}

function stepBegin(uuid: string, turnId: string, step: number, seq: number): WireRecord {
  return {
    type: 'step_begin',
    seq,
    time: nextTime(),
    uuid,
    turn_id: turnId,
    step,
  } as WireRecord;
}

function stepEnd(uuid: string, turnId: string, step: number, seq: number): WireRecord {
  return {
    type: 'step_end',
    seq,
    time: nextTime(),
    uuid,
    turn_id: turnId,
    step,
  } as WireRecord;
}

function toolCallRow(options: {
  uuid: string;
  stepUuid: string;
  turnId: string;
  step: number;
  seq: number;
  toolCallId: string;
  toolName?: string;
}): WireRecord {
  return {
    type: 'tool_call',
    seq: options.seq,
    time: nextTime(),
    uuid: options.uuid,
    turn_id: options.turnId,
    step: options.step,
    step_uuid: options.stepUuid,
    data: {
      tool_call_id: options.toolCallId,
      tool_name: options.toolName ?? 'Bash',
      args: {},
    },
  } as WireRecord;
}

function toolResult(options: {
  turnId: string;
  seq: number;
  toolCallId: string;
  parentUuid?: string | undefined;
}): WireRecord {
  const base: Record<string, unknown> = {
    type: 'tool_result',
    seq: options.seq,
    time: nextTime(),
    turn_id: options.turnId,
    tool_call_id: options.toolCallId,
    output: 'ok',
  };
  if (options.parentUuid !== undefined) {
    base['parent_uuid'] = options.parentUuid;
  }
  return base as unknown as WireRecord;
}

function subagentSpawned(options: {
  seq: number;
  agentId: string;
  parentToolCallId: string;
  parentToolCallUuid?: string | undefined;
}): WireRecord {
  const data: Record<string, unknown> = {
    agent_id: options.agentId,
    parent_tool_call_id: options.parentToolCallId,
    run_in_background: false,
  };
  if (options.parentToolCallUuid !== undefined) {
    data['parent_tool_call_uuid'] = options.parentToolCallUuid;
  }
  return {
    type: 'subagent_spawned',
    seq: options.seq,
    time: nextTime(),
    data,
  } as WireRecord;
}

function subagentCompleted(options: {
  seq: number;
  agentId: string;
  parentToolCallId: string;
}): WireRecord {
  return {
    type: 'subagent_completed',
    seq: options.seq,
    time: nextTime(),
    data: {
      agent_id: options.agentId,
      parent_tool_call_id: options.parentToolCallId,
      result_summary: 'done',
    },
  } as WireRecord;
}

function subagentFailed(options: {
  seq: number;
  agentId: string;
  parentToolCallId: string;
  error?: string;
}): WireRecord {
  return {
    type: 'subagent_failed',
    seq: options.seq,
    time: nextTime(),
    data: {
      agent_id: options.agentId,
      parent_tool_call_id: options.parentToolCallId,
      error: options.error ?? 'boom',
    },
  } as WireRecord;
}

// ── A. findDanglingSteps ───────────────────────────────────────────────

describe('findDanglingSteps', () => {
  it('returns [] for empty records', () => {
    expect(findDanglingSteps([])).toEqual([]);
  });

  it('returns [] when every step_begin has a matching step_end (by uuid)', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      stepBegin('step-u-1', 't1', 0, 2),
      stepEnd('step-u-1', 't1', 0, 3),
    ];
    expect(findDanglingSteps(records)).toEqual([]);
  });

  it('detects a lone step_begin (no step_end) and carries uuid/turnId/step', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      stepBegin('step-u-lone', 't1', 3, 2),
      // crash hits here
    ];
    const dangling = findDanglingSteps(records);
    expect(dangling).toHaveLength(1);
    const first = dangling[0] as DanglingStep;
    expect(first.stepUuid).toBe('step-u-lone');
    expect(first.turnId).toBe('t1');
    expect(first.step).toBe(3);
  });

  it('reports dangling when a step_end uuid does NOT match the open step_begin', () => {
    // step_begin.uuid='step-u-A' but step_end.uuid='step-u-B'. The open step
    // A never closes, so it is dangling; B had no begin to close.
    const records: WireRecord[] = [
      stepBegin('step-u-A', 't1', 0, 1),
      stepEnd('step-u-B', 't1', 0, 2),
    ];
    const dangling = findDanglingSteps(records);
    expect(dangling).toHaveLength(1);
    expect((dangling[0] as DanglingStep).stepUuid).toBe('step-u-A');
  });

  it('returns only the dangling entries when 2 complete + 2 dangling are interleaved', () => {
    const records: WireRecord[] = [
      stepBegin('s-1', 't1', 0, 1),
      stepEnd('s-1', 't1', 0, 2),
      stepBegin('s-2', 't1', 1, 3),
      stepBegin('s-3', 't1', 2, 4),
      stepEnd('s-3', 't1', 2, 5),
      stepBegin('s-4', 't2', 0, 6),
      // s-2 and s-4 are dangling
    ];
    const dangling = findDanglingSteps(records);
    const uuids = dangling.map((d) => d.stepUuid).sort();
    expect(uuids).toEqual(['s-2', 's-4']);
  });

  it('ignores a step_end whose uuid never opened a step_begin', () => {
    const records: WireRecord[] = [stepEnd('never-opened', 't1', 0, 1)];
    expect(findDanglingSteps(records)).toEqual([]);
  });

  it('handles out-of-order records (step_end seen before step_begin) using set-subtraction semantics', () => {
    // Detection is "begun \ ended" — order-independent. An end observed
    // before the matching begin still marks the step as closed.
    const records: WireRecord[] = [
      stepEnd('s-ooo', 't1', 0, 2),
      stepBegin('s-ooo', 't1', 0, 1),
    ];
    expect(findDanglingSteps(records)).toEqual([]);
  });

  it('handles an empty stepUuid string as just another uuid value (no crash)', () => {
    // Phase 25 guarantees `uuid: string` is non-empty in production writes,
    // but the recovery scanner must not special-case that: an empty string
    // is a uuid value like any other. This pins "no NPE on empty string".
    const records: WireRecord[] = [stepBegin('', 't1', 0, 1)];
    const dangling = findDanglingSteps(records);
    expect(dangling).toHaveLength(1);
    expect((dangling[0] as DanglingStep).stepUuid).toBe('');
  });

  it('ignores legacy assistant_message / tool_result records (not in the step scanner scope)', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-1', name: 'Bash', args: {} }]),
      toolResult({ turnId: 't1', seq: 4, toolCallId: 'tc-1' }),
      stepBegin('s-atomic', 't1', 0, 5),
      stepEnd('s-atomic', 't1', 0, 6),
    ];
    expect(findDanglingSteps(records)).toEqual([]);
  });

  it('does not mutate the input records array (purity)', () => {
    const records: WireRecord[] = [stepBegin('s-immutable', 't1', 0, 1)];
    const snapshot = [...records];
    findDanglingSteps(records);
    expect(records).toEqual(snapshot);
  });
});

// ── B. findDanglingSubagents ──────────────────────────────────────────

describe('findDanglingSubagents', () => {
  it('returns [] for empty records', () => {
    expect(findDanglingSubagents([])).toEqual([]);
  });

  it('returns [] when spawn is matched by subagent_completed', () => {
    const records: WireRecord[] = [
      subagentSpawned({ seq: 1, agentId: 'sa-1', parentToolCallId: 'tc-1' }),
      subagentCompleted({ seq: 2, agentId: 'sa-1', parentToolCallId: 'tc-1' }),
    ];
    expect(findDanglingSubagents(records)).toEqual([]);
  });

  it('returns [] when spawn is matched by subagent_failed', () => {
    const records: WireRecord[] = [
      subagentSpawned({ seq: 1, agentId: 'sa-1', parentToolCallId: 'tc-1' }),
      subagentFailed({ seq: 2, agentId: 'sa-1', parentToolCallId: 'tc-1' }),
    ];
    expect(findDanglingSubagents(records)).toEqual([]);
  });

  it('detects a lone spawn (no completed / failed) and carries agent_id + parent + spawnedSeq', () => {
    const records: WireRecord[] = [
      subagentSpawned({
        seq: 42,
        agentId: 'sa-ghost',
        parentToolCallId: 'tc-parent',
        parentToolCallUuid: 'u-tc-parent',
      }),
    ];
    const dangling = findDanglingSubagents(records);
    expect(dangling).toHaveLength(1);
    const first = dangling[0] as DanglingSubagent;
    expect(first.agentId).toBe('sa-ghost');
    expect(first.parentToolCallId).toBe('tc-parent');
    expect(first.parentToolCallUuid).toBe('u-tc-parent');
    expect(first.spawnedSeq).toBe(42);
  });

  it('returns only unsettled spawns when mixed with settled ones', () => {
    const records: WireRecord[] = [
      subagentSpawned({ seq: 1, agentId: 'sa-ok', parentToolCallId: 'tc-1' }),
      subagentCompleted({ seq: 2, agentId: 'sa-ok', parentToolCallId: 'tc-1' }),
      subagentSpawned({ seq: 3, agentId: 'sa-lost', parentToolCallId: 'tc-2' }),
      subagentSpawned({ seq: 4, agentId: 'sa-err', parentToolCallId: 'tc-3' }),
      subagentFailed({ seq: 5, agentId: 'sa-err', parentToolCallId: 'tc-3' }),
    ];
    const dangling = findDanglingSubagents(records);
    expect(dangling.map((d) => d.agentId)).toEqual(['sa-lost']);
  });

  it('ignores a completed / failed record that has no matching spawn (never reports)', () => {
    const records: WireRecord[] = [
      subagentCompleted({ seq: 1, agentId: 'sa-orphan', parentToolCallId: 'tc-1' }),
      subagentFailed({ seq: 2, agentId: 'sa-orphan2', parentToolCallId: 'tc-2' }),
    ];
    expect(findDanglingSubagents(records)).toEqual([]);
  });

  it('leaves parentToolCallUuid as undefined when spawn omits parent_tool_call_uuid', () => {
    const records: WireRecord[] = [
      subagentSpawned({
        seq: 7,
        agentId: 'sa-no-uuid',
        parentToolCallId: 'tc-legacy',
        // no parentToolCallUuid
      }),
    ];
    const dangling = findDanglingSubagents(records);
    expect(dangling).toHaveLength(1);
    const first = dangling[0] as DanglingSubagent;
    expect(first.parentToolCallUuid).toBeUndefined();
    expect(first.parentToolCallId).toBe('tc-legacy');
  });

  it('treats duplicate settled records as idempotent — one match closes the spawn', () => {
    const records: WireRecord[] = [
      subagentSpawned({ seq: 1, agentId: 'sa-dup', parentToolCallId: 'tc-dup' }),
      subagentCompleted({ seq: 2, agentId: 'sa-dup', parentToolCallId: 'tc-dup' }),
      subagentCompleted({ seq: 3, agentId: 'sa-dup', parentToolCallId: 'tc-dup' }),
    ];
    expect(findDanglingSubagents(records)).toEqual([]);
  });
});

// ── C. findDanglingToolCalls — atomic-aware ────────────────────────────

describe('findDanglingToolCalls (Phase 25 atomic-aware)', () => {
  it('legacy path: assistant_message tool_call without matching tool_result → dangling, toolCallUuid undefined', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-legacy-1', name: 'Bash', args: {} }]),
      // crash — no tool_result
    ];
    const dangling = findDanglingToolCalls(records);
    expect(dangling).toHaveLength(1);
    const first = dangling[0] as DanglingToolCall;
    expect(first.toolCallId).toBe('tc-legacy-1');
    expect(first.toolCallUuid).toBeUndefined();
    expect(first.toolName).toBe('Bash');
    expect(first.turnId).toBe('t1');
  });

  it('legacy path: assistant_message + tool_result → []', () => {
    const records: WireRecord[] = [
      assistantMessage('t1', 1, [{ id: 'tc-ok', name: 'Read', args: {} }]),
      toolResult({ turnId: 't1', seq: 2, toolCallId: 'tc-ok' }),
    ];
    expect(findDanglingToolCalls(records)).toEqual([]);
  });

  it('atomic path: tool_call row (uuid=u1) without tool_result(parent_uuid=u1) → dangling, toolCallUuid="u1"', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      stepBegin('s-1', 't1', 0, 2),
      toolCallRow({
        uuid: 'u-tc-atomic',
        stepUuid: 's-1',
        turnId: 't1',
        step: 0,
        seq: 3,
        toolCallId: 'tc-atomic-1',
        toolName: 'Edit',
      }),
      // crash — no tool_result
    ];
    const dangling = findDanglingToolCalls(records);
    expect(dangling).toHaveLength(1);
    const first = dangling[0] as DanglingToolCall;
    expect(first.toolCallUuid).toBe('u-tc-atomic');
    expect(first.toolCallId).toBe('tc-atomic-1');
    expect(first.toolName).toBe('Edit');
    expect(first.turnId).toBe('t1');
  });

  it('atomic path: tool_call + tool_result with matching parent_uuid → []', () => {
    const records: WireRecord[] = [
      stepBegin('s-1', 't1', 0, 1),
      toolCallRow({
        uuid: 'u-atomic-ok',
        stepUuid: 's-1',
        turnId: 't1',
        step: 0,
        seq: 2,
        toolCallId: 'tc-a',
      }),
      toolResult({
        turnId: 't1',
        seq: 3,
        toolCallId: 'tc-a',
        parentUuid: 'u-atomic-ok',
      }),
    ];
    expect(findDanglingToolCalls(records)).toEqual([]);
  });

  it('mixed session: legacy prefix + atomic suffix → both dangling entries surfaced', () => {
    const records: WireRecord[] = [
      // Legacy half (pre-switchover)
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-legacy', name: 'Bash', args: {} }]),
      // tool_result missing for tc-legacy → legacy dangling
      turnBegin('t2', 4),
      userMessage('t2', 5),
      // Atomic half (post-switchover)
      stepBegin('s-atomic', 't2', 0, 6),
      toolCallRow({
        uuid: 'u-atomic',
        stepUuid: 's-atomic',
        turnId: 't2',
        step: 0,
        seq: 7,
        toolCallId: 'tc-atomic',
      }),
      // tool_result missing for u-atomic → atomic dangling
    ];
    const dangling = findDanglingToolCalls(records);
    const ids = dangling.map((d) => d.toolCallId).sort();
    expect(ids).toEqual(['tc-atomic', 'tc-legacy']);
    const byId = Object.fromEntries(dangling.map((d) => [d.toolCallId, d]));
    expect(byId['tc-legacy']!.toolCallUuid).toBeUndefined();
    expect(byId['tc-atomic']!.toolCallUuid).toBe('u-atomic');
  });

  it('atomic decision: tool_result missing parent_uuid does NOT resolve an atomic tool_call — still dangling', () => {
    // Coordinator decision C.6 — atomic path only matches via `parent_uuid`.
    // A tool_result that carries only `tool_call_id` is routed to the
    // legacy matcher; the atomic `tool_call` row remains unresolved.
    const records: WireRecord[] = [
      stepBegin('s-1', 't1', 0, 1),
      toolCallRow({
        uuid: 'u-no-parent-match',
        stepUuid: 's-1',
        turnId: 't1',
        step: 0,
        seq: 2,
        toolCallId: 'tc-x',
      }),
      toolResult({ turnId: 't1', seq: 3, toolCallId: 'tc-x' /* no parent_uuid */ }),
    ];
    const dangling = findDanglingToolCalls(records);
    expect(dangling).toHaveLength(1);
    const first = dangling[0] as DanglingToolCall;
    expect(first.toolCallUuid).toBe('u-no-parent-match');
    expect(first.toolCallId).toBe('tc-x');
  });

  it('atomic priority: same tool_call_id in legacy + atomic → reports once (atomic wins, no double-count)', () => {
    // Coordinator decision C.7 — if both an `assistant_message.tool_calls[]`
    // entry and a `tool_call` atomic row share the same `tool_call_id`,
    // the atomic row is the canonical source and the legacy entry is
    // deduplicated so the pair never surfaces as two dangling rows.
    const records: WireRecord[] = [
      assistantMessage('t1', 1, [{ id: 'tc-dup', name: 'Bash', args: {} }]),
      stepBegin('s-1', 't1', 0, 2),
      toolCallRow({
        uuid: 'u-dup',
        stepUuid: 's-1',
        turnId: 't1',
        step: 0,
        seq: 3,
        toolCallId: 'tc-dup',
      }),
      // no tool_result at all → dangling
    ];
    const dangling = findDanglingToolCalls(records);
    expect(dangling).toHaveLength(1);
    const first = dangling[0] as DanglingToolCall;
    expect(first.toolCallUuid).toBe('u-dup');
    expect(first.toolCallId).toBe('tc-dup');
  });

  it('atomic priority: legacy tool_result matches atomic-dupe tool_call_id but atomic still dangling (parent_uuid absent)', () => {
    // Coordinator decision C.8 — even if a tool_result with the matching
    // tool_call_id exists, if it lacks `parent_uuid`, the atomic `tool_call`
    // row is *not* resolved. Reported exactly once (atomic wins over legacy).
    const records: WireRecord[] = [
      assistantMessage('t1', 1, [{ id: 'tc-dup', name: 'Bash', args: {} }]),
      toolResult({ turnId: 't1', seq: 2, toolCallId: 'tc-dup' /* no parent_uuid */ }),
      stepBegin('s-1', 't1', 0, 3),
      toolCallRow({
        uuid: 'u-dup-unmatched',
        stepUuid: 's-1',
        turnId: 't1',
        step: 0,
        seq: 4,
        toolCallId: 'tc-dup',
      }),
    ];
    const dangling = findDanglingToolCalls(records);
    expect(dangling).toHaveLength(1);
    const first = dangling[0] as DanglingToolCall;
    expect(first.toolCallUuid).toBe('u-dup-unmatched');
  });
});

// ── D. repairJournal — new synthetic phases ────────────────────────────

describe('repairJournal — atomic phases (step_end / subagent_failed / atomic tool_result)', () => {
  function createRepairDeps() {
    const contextState = new InMemoryContextState({
      initialModel: 'test-model',
      currentTurnId: () => 't1',
    });
    const sessionJournal = new InMemorySessionJournalImpl();
    return { contextState, sessionJournal };
  }

  it('dangling step: invokes contextState.appendStepEnd({ uuid, turnId, step })', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const appendStepEndSpy = vi.spyOn(
      contextState as FullContextState,
      'appendStepEnd',
    );
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      stepBegin('step-u-orphan', 't1', 5, 3),
      // crashed before step_end
    ];
    await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    expect(appendStepEndSpy).toHaveBeenCalledTimes(1);
    const arg = appendStepEndSpy.mock.calls[0]![0];
    expect(arg.uuid).toBe('step-u-orphan');
    expect(arg.turnId).toBe('t1');
    expect(arg.step).toBe(5);
  });

  it('dangling subagent: invokes sessionJournal.appendSubagentFailed with agent_id, parent_tool_call_id, error="crashed_before_outcome"', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const spy = vi.spyOn(sessionJournal as SessionJournal, 'appendSubagentFailed');
    const records: WireRecord[] = [
      subagentSpawned({
        seq: 1,
        agentId: 'sa-crash',
        parentToolCallId: 'tc-parent',
        parentToolCallUuid: 'u-parent',
      }),
    ];
    await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]![0] as JournalInput<'subagent_failed'>;
    expect(arg.data.agent_id).toBe('sa-crash');
    expect(arg.data.parent_tool_call_id).toBe('tc-parent');
    expect(arg.data.error).toBe('crashed_before_outcome');
  });

  it('dangling atomic tool_call: invokes contextState.appendToolResult with parentUuid=toolCallUuid and synthetic error payload', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const spy = vi.spyOn(contextState as FullContextState, 'appendToolResult');
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      stepBegin('s-1', 't1', 0, 2),
      toolCallRow({
        uuid: 'u-atomic-crash',
        stepUuid: 's-1',
        turnId: 't1',
        step: 0,
        seq: 3,
        toolCallId: 'tc-atomic',
        toolName: 'Bash',
      }),
    ];
    await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const [parentUuid, toolCallId, payload] = spy.mock.calls[0]! as [
      string | undefined,
      string,
      ToolResultPayload,
      (string | undefined)?,
    ];
    expect(parentUuid).toBe('u-atomic-crash');
    expect(toolCallId).toBe('tc-atomic');
    expect(payload.output).toBe('crashed_before_execution');
    expect(payload.isError).toBe(true);
    expect(payload.synthetic).toBe(true);
  });

  it('dangling legacy tool_call: preserves parentUuid=undefined (no atomic anchor exists)', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const spy = vi.spyOn(contextState as FullContextState, 'appendToolResult');
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-legacy', name: 'Bash', args: {} }]),
      // crashed — no tool_result, no atomic tool_call row
    ];
    await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]! as [
      string | undefined,
      string,
      ToolResultPayload,
      (string | undefined)?,
    ];
    expect(call[0]).toBeUndefined();
    expect(call[1]).toBe('tc-legacy');
  });

  it('syntheticCount aggregates across all 5 phases (approval + legacy tc + step + subagent + turn)', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-legacy', name: 'Bash', args: {} }]),
      // dangling: approval_request
      {
        type: 'approval_request',
        seq: 4,
        time: nextTime(),
        turn_id: 't1',
        step: 1,
        data: {
          request_id: 'req-1',
          tool_call_id: 'tc-legacy',
          tool_name: 'Bash',
          action: 'run',
          display: { kind: 'command', command: 'ls' },
          source: { kind: 'soul', agent_id: 'agent_main' },
        },
      } as WireRecord,
      stepBegin('step-u-lost', 't1', 0, 5),
      subagentSpawned({ seq: 6, agentId: 'sa-lost', parentToolCallId: 'tc-legacy' }),
      // dangling: turn_end missing for t1
    ];
    const result = await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    // 1 approval + 1 legacy tool_result + 1 step_end + 1 subagent_failed + 1 turn_end = 5
    expect(result.syntheticCount).toBeGreaterThanOrEqual(5);
  });

  it('warnings include "dangling step(s)" / "dangling subagent(s)" messages for new phases', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      stepBegin('step-u-lost', 't1', 0, 2),
      subagentSpawned({ seq: 3, agentId: 'sa-lost', parentToolCallId: 'tc-1' }),
    ];
    const result = await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    const joined = result.warnings.join('\n');
    expect(joined).toMatch(/dangling step/);
    expect(joined).toMatch(/dangling subagent/);
  });
});
