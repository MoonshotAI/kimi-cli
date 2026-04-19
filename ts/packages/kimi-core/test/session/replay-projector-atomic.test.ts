/**
 * Phase 25 Stage F — Slice 25c-4a: replay-projector atomic reconstruct.
 *
 * After 25c-2/25c-3, Soul writes `step_begin` / `content_part` / `tool_call`
 * / `step_end` records (atomic API) instead of aggregated `assistant_message`
 * rows. `projectReplayState` must reconstruct equivalent assistant Message[]
 * entries from these atomic records or `resume` returns an empty history.
 *
 * Algorithm under test (PROGRESS.md §F.2.1):
 *   - Maintain a single `openStep` (stepUuid, textChunks, thinkChunks,
 *     toolCalls, hasStepEnd).
 *   - `step_begin`     → flushOpenStep() then open a fresh step.
 *   - `content_part`   → append text/think chunks to the open step (or
 *                        flush + open a new step on stepUuid mismatch).
 *   - `tool_call`      → append a kosong ToolCall to the open step (or
 *                        flush + open a new step on stepUuid mismatch).
 *   - `step_end`       → mark hasStepEnd, fold usage into tokenCount,
 *                        flush.
 *   - `user_message` / `tool_result` / `compaction` / `context_cleared`
 *     all flush before they apply (step boundary).
 *   - End of records → flushOpenStep() once more (last-step boundary).
 *
 * Decision C6 / H3: a partial step (no `step_end`) is **dropped** at flush
 * time — never enters `messages[]` and contributes nothing to `tokenCount`.
 *
 * Tone aligned with `replay-projector.test.ts` (Slice 3.4 / Phase 23 T4):
 * the canonical `makeMainInit` baseline + raw WireRecord literals.
 */

import { describe, expect, it } from 'vitest';

import { projectReplayState } from '../../src/session/replay-projector.js';
import type {
  ContentPartRecord,
  SessionInitializedRecord,
  StepBeginRecord,
  StepEndRecord,
  ToolCallRecord,
  WireRecord,
} from '../../src/storage/wire-record.js';

// ── Baseline + record builders ────────────────────────────────────────

function makeMainInit(overrides?: Partial<SessionInitializedRecord>): SessionInitializedRecord {
  return {
    type: 'session_initialized',
    seq: 1,
    time: 1,
    agent_type: 'main',
    session_id: 'ses_atomic',
    system_prompt: '',
    model: 'baseline-model',
    active_tools: [],
    permission_mode: 'default',
    plan_mode: false,
    workspace_dir: '/tmp/ws',
    ...(overrides as object),
  } as SessionInitializedRecord;
}

const TURN = 'turn_atomic';

function stepBegin(seq: number, uuid: string, step = 0): StepBeginRecord {
  return {
    type: 'step_begin',
    seq,
    time: seq,
    uuid,
    turn_id: TURN,
    step,
  };
}

function stepEnd(
  seq: number,
  uuid: string,
  step = 0,
  usage?: { input_tokens: number; output_tokens: number },
): StepEndRecord {
  return {
    type: 'step_end',
    seq,
    time: seq,
    uuid,
    turn_id: TURN,
    step,
    ...(usage !== undefined ? { usage } : {}),
  };
}

function textPart(
  seq: number,
  stepUuid: string,
  text: string,
  step = 0,
): ContentPartRecord {
  return {
    type: 'content_part',
    seq,
    time: seq,
    uuid: `cp_${seq}`,
    turn_id: TURN,
    step,
    step_uuid: stepUuid,
    role: 'assistant',
    part: { kind: 'text', text },
  };
}

function thinkPart(
  seq: number,
  stepUuid: string,
  think: string,
  step = 0,
  encrypted?: string,
): ContentPartRecord {
  return {
    type: 'content_part',
    seq,
    time: seq,
    uuid: `cp_${seq}`,
    turn_id: TURN,
    step,
    step_uuid: stepUuid,
    role: 'assistant',
    part:
      encrypted !== undefined
        ? { kind: 'think', think, encrypted }
        : { kind: 'think', think },
  };
}

function toolCall(
  seq: number,
  stepUuid: string,
  toolCallId: string,
  toolName: string,
  args: unknown,
  step = 0,
): ToolCallRecord {
  return {
    type: 'tool_call',
    seq,
    time: seq,
    uuid: `tc_${seq}`,
    turn_id: TURN,
    step,
    step_uuid: stepUuid,
    data: {
      tool_call_id: toolCallId,
      tool_name: toolName,
      args,
    },
  };
}

function toolResult(seq: number, toolCallId: string, output: unknown): WireRecord {
  return {
    type: 'tool_result',
    seq,
    time: seq,
    turn_id: TURN,
    tool_call_id: toolCallId,
    output,
  };
}

function userMessage(seq: number, text: string): WireRecord {
  return {
    type: 'user_message',
    seq,
    time: seq,
    turn_id: TURN,
    content: text,
  };
}

// ── A.1 — single complete step → single assistant Message ─────────────

describe('projectReplayState atomic — A.1 single complete step', () => {
  it('emits one assistant Message with text content for step_begin/content_part(text)/step_end', () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1'),
      textPart(11, 's1', 'hello'),
      stepEnd(12, 's1', 0, { input_tokens: 7, output_tokens: 3 }),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      toolCalls: [],
    });
    // step_end usage folds into tokenCount.
    expect(result.tokenCount).toBe(10);
  });
});

// ── A.2 — think + text interleaved within a single step ───────────────

describe('projectReplayState atomic — A.2 think/text interleaved', () => {
  it('joins think chunks separately from text chunks; think appears before text in content', () => {
    // Author order: think 'T', text 'A', think 'T2', text 'B'. Reconstruct
    // groups by kind and emits think-first to mirror adaptAssistantMessage
    // (`replay-projector.ts` legacy assistant_message case orders think
    // before text — the atomic path keeps that contract).
    const records: WireRecord[] = [
      stepBegin(10, 's1'),
      thinkPart(11, 's1', 'T'),
      textPart(12, 's1', 'A'),
      thinkPart(13, 's1', 'T2'),
      textPart(14, 's1', 'B'),
      stepEnd(15, 's1'),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toEqual([
      { type: 'think', think: 'TT2' },
      { type: 'text', text: 'AB' },
    ]);
  });
});

// ── A.3 — multiple text content_parts in one step concatenate ─────────

describe('projectReplayState atomic — A.3 multiple text chunks', () => {
  it("joins repeated text content_parts with no separator (mirror Soul's stream)", () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1'),
      textPart(11, 's1', 'A'),
      textPart(12, 's1', 'B'),
      textPart(13, 's1', 'C'),
      stepEnd(14, 's1'),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toEqual([{ type: 'text', text: 'ABC' }]);
  });
});

// ── A.4 — step containing a tool_call → assistant Message with toolCalls

describe('projectReplayState atomic — A.4 step with tool_call', () => {
  it('builds an assistant Message whose toolCalls carry kosong-shaped { type, id, function }', () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1'),
      textPart(11, 's1', 'use echo'),
      toolCall(12, 's1', 'tcall_1', 'echo', { msg: 'hi' }),
      stepEnd(13, 's1'),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(1);
    const m = result.messages[0]!;
    expect(m.role).toBe('assistant');
    expect(m.content).toEqual([{ type: 'text', text: 'use echo' }]);
    expect(m.toolCalls).toHaveLength(1);
    expect(m.toolCalls[0]).toEqual({
      type: 'function',
      id: 'tcall_1',
      function: { name: 'echo', arguments: JSON.stringify({ msg: 'hi' }) },
    });
  });
});

// ── A.5 — tool_result follows step → independent tool Message ─────────

describe('projectReplayState atomic — A.5 step + tool_result', () => {
  it('emits assistant Message + a separate tool Message keyed by tool_call_id', () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1'),
      textPart(11, 's1', 'x'),
      toolCall(12, 's1', 'tcall_x', 'echo', { v: 1 }),
      stepEnd(13, 's1'),
      toolResult(14, 'tcall_x', 'ok'),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe('assistant');
    expect(result.messages[0]!.toolCalls).toHaveLength(1);
    expect(result.messages[1]!.role).toBe('tool');
    expect(result.messages[1]!.toolCallId).toBe('tcall_x');
    expect(result.messages[1]!.content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});

// ── A.6 — multi-step turn: each step aggregates independently ─────────

describe('projectReplayState atomic — A.6 multi-step turn', () => {
  it('separates step 1 + tool_result + step 2 into 3 distinct messages, no interleave', () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1', 0),
      textPart(11, 's1', 'first'),
      toolCall(12, 's1', 'tc_a', 'echo', { msg: 'one' }),
      stepEnd(13, 's1', 0),
      toolResult(14, 'tc_a', 'one-result'),
      stepBegin(15, 's2', 1),
      textPart(16, 's2', 'final'),
      stepEnd(17, 's2', 1),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]!.role).toBe('assistant');
    expect(result.messages[0]!.content).toEqual([{ type: 'text', text: 'first' }]);
    expect(result.messages[0]!.toolCalls).toHaveLength(1);
    expect(result.messages[1]!.role).toBe('tool');
    expect(result.messages[1]!.toolCallId).toBe('tc_a');
    expect(result.messages[2]!.role).toBe('assistant');
    expect(result.messages[2]!.content).toEqual([{ type: 'text', text: 'final' }]);
    expect(result.messages[2]!.toolCalls).toHaveLength(0);
  });
});

// ── A.7 — user_message boundary flushes the open step ────────────────

describe('projectReplayState atomic — A.7 user_message boundary flush', () => {
  it('produces [assistant("A"), user("hi"), assistant("B")] when a user_message sits between two complete steps', () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1', 0),
      textPart(11, 's1', 'A'),
      stepEnd(12, 's1', 0),
      userMessage(13, 'hi'),
      stepBegin(14, 's2', 1),
      textPart(15, 's2', 'B'),
      stepEnd(16, 's2', 1),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]!.role).toBe('assistant');
    expect(result.messages[0]!.content).toEqual([{ type: 'text', text: 'A' }]);
    expect(result.messages[1]!.role).toBe('user');
    expect(result.messages[1]!.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(result.messages[2]!.role).toBe('assistant');
    expect(result.messages[2]!.content).toEqual([{ type: 'text', text: 'B' }]);
  });
});

// ── A.8 — partial step (no step_end) is dropped (decision C6/H3) ──────

describe('projectReplayState atomic — A.8 partial step dropped', () => {
  it('does not emit any Message when only step_begin + content_part are present (no step_end)', () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1'),
      textPart(11, 's1', 'partial'),
      // no step_end — interrupted/aborted mid-stream
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(0);
    // Token count unchanged — partial step never folds usage.
    expect(result.tokenCount).toBe(0);
  });
});

// ── A.9 — partial step + later complete step keeps only the complete ─

describe('projectReplayState atomic — A.9 partial then complete step', () => {
  it("drops the partial s1 when s2's step_begin arrives, keeps only s2 in messages", () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1', 0),
      textPart(11, 's1', 'lost'),
      // s1 never closes — opening s2 forces an implicit flush + drop.
      stepBegin(12, 's2', 1),
      textPart(13, 's2', 'kept'),
      stepEnd(14, 's2', 1),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toEqual([{ type: 'text', text: 'kept' }]);
  });
});

// ── A.10 — step_uuid mismatch on content_part → flush + open new ─────

describe('projectReplayState atomic — A.10 step_uuid mismatch defence', () => {
  it('flushes the current step (dropping it as partial) when a content_part anchors to a different step_uuid; the mismatched step also lacks step_end → final messages = []', () => {
    // s1 has no step_end (the mismatched content_part forces flush →
    // dropped). The mismatched 'mismatched' content_part opens a fresh
    // step; that step never receives step_end either → also dropped at
    // end-of-records. The s1 step_end at the end matches no open step
    // (we already abandoned s1 when 'mismatched' arrived) so it is a
    // no-op. Net result: empty messages.
    const records: WireRecord[] = [
      stepBegin(10, 's1'),
      textPart(11, 's1', 'A'),
      textPart(12, 'mismatched', 'B'),
      stepEnd(13, 's1'),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(0);
  });
});

// ── A.11 — backward compat: legacy assistant_message still works ──────

describe('projectReplayState atomic — A.11 legacy assistant_message compat', () => {
  it('still projects pre-25c-2 wire shape (assistant_message + tool_result) into messages', () => {
    const records: WireRecord[] = [
      {
        type: 'assistant_message',
        seq: 10,
        time: 10,
        turn_id: TURN,
        text: 'legacy',
        think: null,
        tool_calls: [],
        model: 'm-legacy',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      toolResult(11, 'legacy_tc', 'result'),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe('assistant');
    expect(result.messages[0]!.content).toEqual([{ type: 'text', text: 'legacy' }]);
    expect(result.messages[1]!.role).toBe('tool');
    expect(result.tokenCount).toBe(3);
  });
});

// ── A.12 — end-of-records flush behaviour ────────────────────────────

describe('projectReplayState atomic — A.12 end-of-records flush', () => {
  it('flushes a normally-closed step that is the very last record', () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1'),
      textPart(11, 's1', 'end'),
      stepEnd(12, 's1'),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toEqual([{ type: 'text', text: 'end' }]);
  });

  it('drops a partial step left open at end-of-records', () => {
    const records: WireRecord[] = [stepBegin(10, 's1'), textPart(11, 's1', 'partial')];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(0);
  });
});

// ── A.13 — resume-style E2E: 3-step turn with interleaved tool calls ─

describe('projectReplayState atomic — A.13 resume E2E (3 steps + tools)', () => {
  it('reconstructs a full turn equivalent to the in-memory ContextState shape', () => {
    const records: WireRecord[] = [
      // step 1 — assistant calls echo
      stepBegin(10, 'sA', 0),
      textPart(11, 'sA', 'planning'),
      toolCall(12, 'sA', 'tc_1', 'echo', { msg: 'one' }),
      stepEnd(13, 'sA', 0, { input_tokens: 50, output_tokens: 10 }),
      toolResult(14, 'tc_1', 'one'),
      // step 2 — assistant continues, calls echo again
      stepBegin(15, 'sB', 1),
      textPart(16, 'sB', 'continuing'),
      toolCall(17, 'sB', 'tc_2', 'echo', { msg: 'two' }),
      stepEnd(18, 'sB', 1, { input_tokens: 60, output_tokens: 12 }),
      toolResult(19, 'tc_2', 'two'),
      // step 3 — final assistant message
      stepBegin(20, 'sC', 2),
      textPart(21, 'sC', 'done'),
      stepEnd(22, 'sC', 2, { input_tokens: 70, output_tokens: 8 }),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(5);
    expect(result.messages.map((m) => m.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(result.messages[0]!.toolCalls[0]?.id).toBe('tc_1');
    expect(result.messages[2]!.toolCalls[0]?.id).toBe('tc_2');
    expect(result.messages[4]!.toolCalls).toHaveLength(0);
    // Sum of usage: (50+10)+(60+12)+(70+8) = 210
    expect(result.tokenCount).toBe(210);
    expect(result.lastSeq).toBe(22);
  });
});

// ── A.14 — compaction boundary flushes open step before reset ─────────

describe('projectReplayState atomic — A.14 compaction boundary', () => {
  it('flushes the open step before compaction replaces messages, then continues with the next step', () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1', 0),
      textPart(11, 's1', 'pre'),
      stepEnd(12, 's1', 0, { input_tokens: 10, output_tokens: 5 }),
      {
        type: 'compaction',
        seq: 13,
        time: 13,
        summary: 'compact summary',
        compacted_range: { from_turn: 1, to_turn: 1, message_count: 1 },
        pre_compact_tokens: 15,
        post_compact_tokens: 4,
        trigger: 'auto',
      },
      stepBegin(14, 's2', 1),
      textPart(15, 's2', 'post'),
      stepEnd(16, 's2', 1, { input_tokens: 6, output_tokens: 1 }),
    ];
    const result = projectReplayState(records, makeMainInit());
    // After compaction: [summary, assistant('post')]
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe('assistant');
    expect(result.messages[0]!.content).toEqual([{ type: 'text', text: 'compact summary' }]);
    expect(result.messages[1]!.role).toBe('assistant');
    expect(result.messages[1]!.content).toEqual([{ type: 'text', text: 'post' }]);
    // tokenCount: compaction reset to 4, then +6+1 = 11.
    expect(result.tokenCount).toBe(11);
  });
});

// ── A.15 — tokenCount accumulates across multiple step_end usages ────

describe('projectReplayState atomic — A.15 token accumulation', () => {
  it('sums usage from every step_end record (only step_end carries usage)', () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1', 0),
      stepEnd(11, 's1', 0, { input_tokens: 10, output_tokens: 5 }),
      stepBegin(12, 's2', 1),
      stepEnd(13, 's2', 1, { input_tokens: 20, output_tokens: 3 }),
    ];
    const result = projectReplayState(records, makeMainInit());
    // 10 + 5 + 20 + 3 = 38
    expect(result.tokenCount).toBe(38);
    // Pin the edge-case semantics: a step with only step_begin + step_end
    // (no content_part / tool_call) still materialises as an empty-content
    // assistant Message. Mirrors the legacy `assistant_message` case where
    // `text=null, think=null, tool_calls=[]` also produced an empty Message.
    // Two steps → two messages. Any future decision to silently drop empty
    // steps would require flipping this assertion + recording the change.
    expect(result.messages).toHaveLength(2);
  });

  it('treats step_end without usage as a zero-token contribution', () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1'),
      textPart(11, 's1', 'x'),
      stepEnd(12, 's1'),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.tokenCount).toBe(0);
    expect(result.messages).toHaveLength(1);
  });
});

// ── Extra: think encrypted carries through ────────────────────────────

describe('projectReplayState atomic — encrypted think round-trip', () => {
  it('preserves the encrypted attribute on think parts (Anthropic signature)', () => {
    const records: WireRecord[] = [
      stepBegin(10, 's1'),
      thinkPart(11, 's1', 'secret-think', 0, 'sig_abc'),
      textPart(12, 's1', 'reply'),
      stepEnd(13, 's1'),
    ];
    const result = projectReplayState(records, makeMainInit());
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content[0]).toMatchObject({
      type: 'think',
      think: 'secret-think',
      encrypted: 'sig_abc',
    });
    expect(result.messages[0]!.content[1]).toEqual({ type: 'text', text: 'reply' });
  });
});
