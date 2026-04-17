/**
 * Replay projector unit tests (Slice 3.4).
 *
 * Tests verify that `projectReplayState` correctly builds initial
 * ContextState inputs from replayed WireRecords.
 */

import { describe, expect, it } from 'vitest';

import { projectReplayState } from '../../src/session/replay-projector.js';
import type { WireRecord } from '../../src/storage/wire-record.js';

function makeUserMessage(seq: number, turnId: string, content: string): WireRecord {
  return {
    type: 'user_message',
    seq,
    time: Date.now(),
    turn_id: turnId,
    content,
  };
}

function makeAssistantMessage(
  seq: number,
  turnId: string,
  text: string,
  opts?: { usage?: { input_tokens: number; output_tokens: number } },
): WireRecord {
  return {
    type: 'assistant_message',
    seq,
    time: Date.now(),
    turn_id: turnId,
    text,
    think: null,
    tool_calls: [],
    model: 'test-model',
    ...(opts?.usage !== undefined ? { usage: opts.usage } : {}),
  };
}

function makeToolResult(
  seq: number,
  turnId: string,
  toolCallId: string,
  output: unknown,
): WireRecord {
  return {
    type: 'tool_result',
    seq,
    time: Date.now(),
    turn_id: turnId,
    tool_call_id: toolCallId,
    output,
  };
}

describe('projectReplayState', () => {
  it('returns empty state for no records', () => {
    const result = projectReplayState([]);
    expect(result.messages).toHaveLength(0);
    expect(result.model).toBeUndefined();
    expect(result.systemPrompt).toBeUndefined();
    expect(result.activeTools.size).toBe(0);
    expect(result.lastSeq).toBe(0);
    expect(result.permissionMode).toBeUndefined();
    expect(result.tokenCount).toBe(0);
  });

  it('projects user + assistant messages', () => {
    const records: WireRecord[] = [
      makeUserMessage(1, 'turn_1', 'hello'),
      makeAssistantMessage(2, 'turn_1', 'Hi!', {
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ];

    const result = projectReplayState(records);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[1]!.role).toBe('assistant');
    expect(result.lastSeq).toBe(2);
    expect(result.tokenCount).toBe(150);
  });

  it('projects tool result messages', () => {
    const records: WireRecord[] = [
      makeUserMessage(1, 'turn_1', 'run ls'),
      {
        type: 'assistant_message',
        seq: 2,
        time: Date.now(),
        turn_id: 'turn_1',
        text: null,
        think: null,
        tool_calls: [{ id: 'tc_1', name: 'bash', args: { cmd: 'ls' } }],
        model: 'test-model',
      },
      makeToolResult(3, 'turn_1', 'tc_1', 'file1.txt\nfile2.txt'),
    ];

    const result = projectReplayState(records);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[2]!.role).toBe('tool');
    expect(result.messages[2]!.toolCallId).toBe('tc_1');
  });

  it('handles compaction (replaces all prior messages)', () => {
    const records: WireRecord[] = [
      makeUserMessage(1, 'turn_1', 'first'),
      makeAssistantMessage(2, 'turn_1', 'reply1', {
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      makeUserMessage(3, 'turn_2', 'second'),
      makeAssistantMessage(4, 'turn_2', 'reply2', {
        usage: { input_tokens: 200, output_tokens: 100 },
      }),
      {
        type: 'compaction',
        seq: 5,
        time: Date.now(),
        summary: 'Summary of prior conversation.',
        compacted_range: { from_turn: 1, to_turn: 2, message_count: 4 },
        pre_compact_tokens: 450,
        post_compact_tokens: 50,
        trigger: 'auto' as const,
      },
      makeUserMessage(6, 'turn_3', 'third'),
      makeAssistantMessage(7, 'turn_3', 'reply3', {
        usage: { input_tokens: 80, output_tokens: 30 },
      }),
    ];

    const result = projectReplayState(records);
    // After compaction: summary message + turn_3's user + assistant = 3
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]!.role).toBe('assistant'); // summary
    expect(result.messages[1]!.role).toBe('user'); // "third"
    expect(result.messages[2]!.role).toBe('assistant'); // "reply3"
    // Token count: compaction reset to 50, then +80+30 = 160
    expect(result.tokenCount).toBe(160);
    expect(result.lastSeq).toBe(7);
  });

  it('tracks model_changed', () => {
    const records: WireRecord[] = [
      {
        type: 'model_changed',
        seq: 1,
        time: Date.now(),
        old_model: 'gpt-3.5',
        new_model: 'gpt-4',
      },
    ];

    const result = projectReplayState(records);
    expect(result.model).toBe('gpt-4');
  });

  it('tracks system_prompt_changed', () => {
    const records: WireRecord[] = [
      {
        type: 'system_prompt_changed',
        seq: 1,
        time: Date.now(),
        new_prompt: 'You are a coding assistant.',
      },
    ];

    const result = projectReplayState(records);
    expect(result.systemPrompt).toBe('You are a coding assistant.');
  });

  it('tracks tools_changed operations', () => {
    const records: WireRecord[] = [
      {
        type: 'tools_changed',
        seq: 1,
        time: Date.now(),
        operation: 'set_active' as const,
        tools: ['bash', 'read', 'write'],
      },
      {
        type: 'tools_changed',
        seq: 2,
        time: Date.now(),
        operation: 'remove' as const,
        tools: ['write'],
      },
      {
        type: 'tools_changed',
        seq: 3,
        time: Date.now(),
        operation: 'register' as const,
        tools: ['grep'],
      },
    ];

    const result = projectReplayState(records);
    expect(result.activeTools).toEqual(new Set(['bash', 'read', 'grep']));
    expect(result.lastSeq).toBe(3);
  });

  it('tracks permission_mode_changed', () => {
    const records: WireRecord[] = [
      {
        type: 'permission_mode_changed',
        seq: 1,
        time: Date.now(),
        data: { from: 'default', to: 'bypassPermissions', reason: '/yolo on' },
      },
    ];

    const result = projectReplayState(records);
    expect(result.permissionMode).toBe('bypassPermissions');
  });

  it('ignores management-class records (turn_begin, turn_end, etc.)', () => {
    const records: WireRecord[] = [
      {
        type: 'turn_begin',
        seq: 1,
        time: Date.now(),
        turn_id: 'turn_1',
        agent_type: 'main' as const,
        user_input: 'hello',
        input_kind: 'user' as const,
      },
      makeUserMessage(2, 'turn_1', 'hello'),
      {
        type: 'turn_end',
        seq: 3,
        time: Date.now(),
        turn_id: 'turn_1',
        agent_type: 'main' as const,
        success: true,
        reason: 'done' as const,
      },
    ];

    const result = projectReplayState(records);
    // Only the user_message should produce a message.
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.lastSeq).toBe(3);
  });

  it('uses last model_changed when multiple exist', () => {
    const records: WireRecord[] = [
      {
        type: 'model_changed',
        seq: 1,
        time: Date.now(),
        old_model: 'a',
        new_model: 'b',
      },
      {
        type: 'model_changed',
        seq: 2,
        time: Date.now(),
        old_model: 'b',
        new_model: 'c',
      },
    ];

    const result = projectReplayState(records);
    expect(result.model).toBe('c');
  });

  it('accumulates token count from multiple assistant messages', () => {
    const records: WireRecord[] = [
      makeAssistantMessage(1, 'turn_1', 'r1', {
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      makeAssistantMessage(2, 'turn_2', 'r2', {
        usage: { input_tokens: 200, output_tokens: 100 },
      }),
    ];

    const result = projectReplayState(records);
    expect(result.tokenCount).toBe(450);
  });

  // ── Slice 5.2 — plan_mode_changed + system_prompt_changed ─────────

  it('projects last plan_mode_changed (Slice 5.2)', () => {
    const records: WireRecord[] = [
      { type: 'plan_mode_changed', seq: 1, time: 1, enabled: true },
      { type: 'plan_mode_changed', seq: 2, time: 2, enabled: false },
      { type: 'plan_mode_changed', seq: 3, time: 3, enabled: true },
    ];
    const result = projectReplayState(records);
    expect(result.planMode).toBe(true);
  });

  it('planMode is undefined when no plan_mode_changed records exist', () => {
    const records: WireRecord[] = [
      { type: 'model_changed', seq: 1, time: 1, old_model: 'a', new_model: 'b' },
    ];
    const result = projectReplayState(records);
    expect(result.planMode).toBeUndefined();
  });

  it('planMode reflects single plan_mode_changed record', () => {
    const records: WireRecord[] = [
      { type: 'plan_mode_changed', seq: 1, time: 1, enabled: true },
    ];
    const result = projectReplayState(records);
    expect(result.planMode).toBe(true);
  });

  it('projects last system_prompt_changed (T3.4 verification)', () => {
    const records: WireRecord[] = [
      { type: 'system_prompt_changed', seq: 1, time: 1, new_prompt: 'first agent' },
      { type: 'system_prompt_changed', seq: 2, time: 2, new_prompt: 'second agent' },
    ];
    const result = projectReplayState(records);
    expect(result.systemPrompt).toBe('second agent');
  });

  // ── Phase 16 / 决策 #113 — sessionMetaPatch (T5) ─────────────────────

  describe('sessionMetaPatch projection (Phase 16 / T5)', () => {
    it('merges session_meta_changed records in seq order', () => {
      const records: WireRecord[] = [
        {
          type: 'session_meta_changed',
          seq: 1,
          time: 1,
          patch: { title: 'first' },
          source: 'user',
        },
        {
          type: 'session_meta_changed',
          seq: 2,
          time: 2,
          patch: { tags: ['a', 'b'] },
          source: 'user',
        },
        {
          type: 'session_meta_changed',
          seq: 3,
          time: 3,
          patch: { title: 'final' },
          source: 'auto',
        },
      ];
      const result = projectReplayState(records);
      expect(result.sessionMetaPatch.title).toBe('final');
      expect(result.sessionMetaPatch.tags).toEqual(['a', 'b']);
    });

    it('derives turn_count from turn_begin records', () => {
      const mkTurnBegin = (seq: number, id: string): WireRecord => ({
        type: 'turn_begin',
        seq,
        time: seq,
        turn_id: id,
        agent_type: 'main',
        input_kind: 'user',
        user_input: 'x',
      });
      const records: WireRecord[] = [
        mkTurnBegin(1, 'turn_1'),
        mkTurnBegin(2, 'turn_2'),
        mkTurnBegin(3, 'turn_3'),
        mkTurnBegin(4, 'turn_4'),
        mkTurnBegin(5, 'turn_5'),
      ];
      const result = projectReplayState(records);
      expect(result.sessionMetaPatch.turn_count).toBe(5);
    });

    it('derives last_model from the last model_changed record', () => {
      const records: WireRecord[] = [
        { type: 'model_changed', seq: 1, time: 1, old_model: 'a', new_model: 'b' },
        { type: 'model_changed', seq: 2, time: 2, old_model: 'b', new_model: 'c' },
      ];
      const result = projectReplayState(records);
      expect(result.sessionMetaPatch.last_model).toBe('c');
    });

    it('returns an empty sessionMetaPatch (turn_count=0) for an empty wire', () => {
      const result = projectReplayState([]);
      expect(result.sessionMetaPatch.turn_count).toBe(0);
      expect(result.sessionMetaPatch.title).toBeUndefined();
      expect(result.sessionMetaPatch.tags).toBeUndefined();
      expect(result.sessionMetaPatch.last_model).toBeUndefined();
    });

    it('combines meta patch + turn_count + last_model together', () => {
      const records: WireRecord[] = [
        {
          type: 'session_meta_changed',
          seq: 1,
          time: 1,
          patch: { title: 'mixed', tags: ['p'] },
          source: 'user',
        },
        {
          type: 'turn_begin',
          seq: 2,
          time: 2,
          turn_id: 'turn_1',
          agent_type: 'main',
          input_kind: 'user',
        },
        { type: 'model_changed', seq: 3, time: 3, old_model: 'a', new_model: 'latest' },
        {
          type: 'turn_begin',
          seq: 4,
          time: 4,
          turn_id: 'turn_2',
          agent_type: 'main',
          input_kind: 'user',
        },
      ];
      const result = projectReplayState(records);
      expect(result.sessionMetaPatch).toMatchObject({
        title: 'mixed',
        tags: ['p'],
        turn_count: 2,
        last_model: 'latest',
      });
    });
  });
});
