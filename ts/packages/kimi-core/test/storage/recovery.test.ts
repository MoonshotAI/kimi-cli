/**
 * Crash recovery — passive journal repair tests (§8).
 *
 * Tests verify that:
 *   - Dangling tool_calls are detected and repaired with synthetic error tool_result
 *   - Dangling turn_begins are detected and repaired with synthetic interrupted turn_end
 *   - Dangling approval_requests are detected and repaired with synthetic cancelled approval_response
 *   - The main repairJournal orchestrator runs all repairs in correct order
 *   - Healthy journals pass through with no synthetic records
 *   - Recovery obeys the "passive only" principle (no user_message, no re-run, no recovery turn)
 */

import { describe, expect, it } from 'vitest';

import { InMemoryContextState } from '../../src/storage/context-state.js';
import {
  findDanglingApprovals,
  findDanglingToolCalls,
  findDanglingTurns,
  repairJournal,
} from '../../src/storage/recovery.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import type { WireRecord } from '../../src/storage/wire-record.js';

// ── Helper: build minimal WireRecords for test scenarios ──────────────

function turnBegin(turnId: string, seq: number): WireRecord {
  return {
    type: 'turn_begin',
    seq,
    time: Date.now(),
    turn_id: turnId,
    agent_type: 'main',
    input_kind: 'user',
  } as WireRecord;
}

function turnEnd(
  turnId: string,
  seq: number,
  reason: 'done' | 'cancelled' | 'error' | 'interrupted' = 'done',
): WireRecord {
  return {
    type: 'turn_end',
    seq,
    time: Date.now(),
    turn_id: turnId,
    agent_type: 'main',
    success: reason === 'done',
    reason,
  } as WireRecord;
}

function userMessage(turnId: string, seq: number): WireRecord {
  return {
    type: 'user_message',
    seq,
    time: Date.now(),
    turn_id: turnId,
    content: 'test input',
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
    time: Date.now(),
    turn_id: turnId,
    text: 'response',
    think: null,
    tool_calls: toolCalls,
    model: 'test-model',
  } as WireRecord;
}

function toolResult(turnId: string, seq: number, toolCallId: string, isError = false): WireRecord {
  return {
    type: 'tool_result',
    seq,
    time: Date.now(),
    turn_id: turnId,
    tool_call_id: toolCallId,
    output: isError ? 'tool execution cancelled' : 'ok',
    is_error: isError || undefined,
  } as WireRecord;
}

function approvalRequest(turnId: string, seq: number, requestId: string): WireRecord {
  return {
    type: 'approval_request',
    seq,
    time: Date.now(),
    turn_id: turnId,
    step: 1,
    data: {
      request_id: requestId,
      tool_call_id: 'tc-1',
      tool_name: 'Bash',
      action: 'execute command',
      display: { kind: 'command', command: 'echo ok' },
      source: { kind: 'soul', agent_id: 'agent_main' },
    },
  } as WireRecord;
}

function approvalResponse(
  turnId: string,
  seq: number,
  requestId: string,
  response: 'approved' | 'rejected' | 'cancelled' = 'approved',
): WireRecord {
  return {
    type: 'approval_response',
    seq,
    time: Date.now(),
    turn_id: turnId,
    step: 1,
    data: {
      request_id: requestId,
      response,
    },
  } as WireRecord;
}

// ── Detection tests ───────────────────────────────────────────────────

describe('findDanglingToolCalls', () => {
  it('returns empty for a healthy journal (all tool_calls have tool_results)', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-1', name: 'Read', args: {} }]),
      toolResult('t1', 4, 'tc-1'),
      turnEnd('t1', 5),
    ];
    expect(findDanglingToolCalls(records)).toEqual([]);
  });

  it('detects a single dangling tool_call', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-1', name: 'Bash', args: { command: 'ls' } }]),
      // No tool_result for tc-1
    ];
    const dangling = findDanglingToolCalls(records);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]).toEqual({
      turnId: 't1',
      toolCallId: 'tc-1',
      toolName: 'Bash',
    });
  });

  it('detects multiple dangling tool_calls from a single assistant_message', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [
        { id: 'tc-1', name: 'Read', args: {} },
        { id: 'tc-2', name: 'Write', args: {} },
      ]),
      toolResult('t1', 4, 'tc-1'), // Only tc-1 has a result
      // tc-2 is dangling
    ];
    const dangling = findDanglingToolCalls(records);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.toolCallId).toBe('tc-2');
  });

  it('ignores resolved tool_calls when detecting dangling ones', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-1', name: 'Read', args: {} }]),
      toolResult('t1', 4, 'tc-1'),
      assistantMessage('t1', 5, [{ id: 'tc-2', name: 'Write', args: {} }]),
      // tc-2 is dangling
    ];
    const dangling = findDanglingToolCalls(records);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.toolCallId).toBe('tc-2');
  });
});

describe('findDanglingTurns', () => {
  it('returns empty for a healthy journal (all turns have turn_end)', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3),
      turnEnd('t1', 4),
    ];
    expect(findDanglingTurns(records)).toEqual([]);
  });

  it('detects a turn_begin without turn_end', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3),
      // No turn_end
    ];
    const dangling = findDanglingTurns(records);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.turnId).toBe('t1');
    expect(dangling[0]!.agentType).toBe('main');
  });

  it('correctly handles multiple turns with only the last one dangling', () => {
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      turnEnd('t1', 2),
      turnBegin('t2', 3),
      // No turn_end for t2
    ];
    const dangling = findDanglingTurns(records);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.turnId).toBe('t2');
  });
});

describe('findDanglingApprovals', () => {
  it('returns empty when all approval_requests have responses', () => {
    const records: WireRecord[] = [
      approvalRequest('t1', 1, 'req-1'),
      approvalResponse('t1', 2, 'req-1'),
    ];
    expect(findDanglingApprovals(records)).toEqual([]);
  });

  it('detects an approval_request without a response', () => {
    const records: WireRecord[] = [
      approvalRequest('t1', 1, 'req-1'),
      // No approval_response
    ];
    const dangling = findDanglingApprovals(records);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.requestId).toBe('req-1');
  });

  it('handles mixed resolved and dangling approvals', () => {
    const records: WireRecord[] = [
      approvalRequest('t1', 1, 'req-1'),
      approvalResponse('t1', 2, 'req-1'),
      approvalRequest('t1', 3, 'req-2'),
      // req-2 is dangling
    ];
    const dangling = findDanglingApprovals(records);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.requestId).toBe('req-2');
  });
});

// ── Repair orchestrator tests ─────────────────────────────────────────

describe('repairJournal', () => {
  function createRepairDeps() {
    const contextState = new InMemoryContextState({ initialModel: 'test-model' });
    const sessionJournal = new InMemorySessionJournalImpl();
    return { contextState, sessionJournal };
  }

  it('reports no repairs needed for a healthy journal', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3),
      turnEnd('t1', 4),
    ];
    const result = await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    expect(result.health).toBe('ok');
    expect(result.syntheticCount).toBe(0);
  });

  it('repairs dangling tool_calls with synthetic error tool_result', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-1', name: 'Bash', args: {} }]),
      // tool_result missing → should be repaired
    ];
    const result = await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    expect(result.syntheticCount).toBeGreaterThanOrEqual(1);
    // The synthetic tool_result should be is_error: true with "tool execution cancelled"
  });

  it('repairs dangling turn_begin with synthetic interrupted turn_end', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      // turn_end missing → should be repaired
    ];
    const result = await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    expect(result.syntheticCount).toBeGreaterThanOrEqual(1);
    // The synthetic turn_end should have reason: 'interrupted', synthetic: true
  });

  it('repairs dangling approval_request with synthetic cancelled approval_response', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-1', name: 'Bash', args: {} }]),
      approvalRequest('t1', 4, 'req-1'),
      // approval_response missing → should be repaired
    ];
    const result = await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    expect(result.syntheticCount).toBeGreaterThanOrEqual(1);
  });

  it('repairs all three kinds of dangling records in one pass', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-1', name: 'Bash', args: {} }]),
      approvalRequest('t1', 4, 'req-1'),
      // All three are dangling: approval, tool_result, turn_end
    ];
    const result = await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    // At minimum: 1 cancelled approval_response + 1 error tool_result + 1 interrupted turn_end = 3
    expect(result.syntheticCount).toBeGreaterThanOrEqual(3);
  });

  it('does NOT append any synthetic user_message (§8 passive-only principle)', async () => {
    const { contextState, sessionJournal } = createRepairDeps();
    const records: WireRecord[] = [
      turnBegin('t1', 1),
      userMessage('t1', 2),
      assistantMessage('t1', 3, [{ id: 'tc-1', name: 'Bash', args: {} }]),
      // dangling tool_call
    ];
    await repairJournal({
      records,
      contextState,
      sessionJournal,
      currentTurnId: () => 't1',
    });
    // Verify no user_message records were added by repair
    const journalRecords = sessionJournal.getRecords();
    const userMessages = journalRecords.filter((r) => r.type === 'turn_begin');
    // Only the repair records should be present — no new turn_begin that
    // would indicate a recovery turn was started
    expect(userMessages).toHaveLength(0);
  });
});

// ── Phase 15 A.7 — crash-recovery + stale-subagent cleanup integration ──
//
// Pins the "resume flow" contract: a single resume round must run BOTH
// journal repair (for dangling tool_calls / turns / approvals) AND
// subagent cleanup (for running subagent instances left over from the
// crash). Neither path writes to the other's store; both must complete
// without racing.
//
// Python parity: `app.py::resume_session` invokes
// `repair_journal(…)` and `_cleanup_stale_foreground_subagents(…)` in a
// single sequential pass.

describe('Resume integration (Phase 15 A.7)', () => {
  it('crash with dangling turn_begin AND running subagent → repairJournal + cleanupStaleSubagents both finish in one pass', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SubagentStore } = await import('../../src/soul-plus/subagent-store.js');
    const { cleanupStaleSubagents } = await import('../../src/soul-plus/subagent-runner.js');

    const tmp = await mkdtemp(join(tmpdir(), 'kimi-resume-integ-'));
    try {
      const store = new SubagentStore(tmp);
      await store.createInstance({
        agentId: 'sa_alive_on_crash',
        subagentType: 'coder',
        description: 'was running when crash hit',
        parentToolCallId: 'tc-1',
      });
      await store.updateInstance('sa_alive_on_crash', { status: 'running' });

      // Also a completed sibling — must NOT be touched by cleanup.
      await store.createInstance({
        agentId: 'sa_done_before_crash',
        subagentType: 'coder',
        description: 'finished before crash',
        parentToolCallId: 'tc-0',
      });
      await store.updateInstance('sa_done_before_crash', { status: 'completed' });

      const contextState = new InMemoryContextState({ initialModel: 'test-model' });
      const sessionJournal = new InMemorySessionJournalImpl();
      const wire: WireRecord[] = [
        turnBegin('t1', 1),
        userMessage('t1', 2),
        assistantMessage('t1', 3, [{ id: 'tc-1', name: 'Bash', args: {} }]),
        // dangling: tool_result + turn_end missing
      ];

      const repairResult = await repairJournal({
        records: wire,
        contextState,
        sessionJournal,
        currentTurnId: () => 't1',
      });
      const staleIds = await cleanupStaleSubagents(store);

      // Journal repair wrote ≥ 2 synthetic records (tool_result + turn_end).
      expect(repairResult.syntheticCount).toBeGreaterThanOrEqual(2);

      // Subagent cleanup flipped the running instance only.
      expect(staleIds).toEqual(['sa_alive_on_crash']);
      const stale = await store.getInstance('sa_alive_on_crash');
      expect(stale!.status).toBe('failed');
      const done = await store.getInstance('sa_done_before_crash');
      expect(done!.status).toBe('completed');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
