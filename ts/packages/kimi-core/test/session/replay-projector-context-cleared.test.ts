/**
 * Slice 20-A — `projectReplayState` support for `context_cleared`.
 *
 * Drives a new projector branch: when replay sees a `context_cleared`
 * record, it resets the accumulated conversation (messages + tokenCount)
 * just like the live `ContextState.clear()` path does. Anything written
 * AFTER the last `context_cleared` rebuilds the messages from empty.
 *
 * Config-class state (model, systemPrompt, activeTools, permissionMode,
 * planMode) is driven by its OWN `_changed` records and must NOT be
 * touched by a clear — that mirrors the live `clear()` contract.
 */

import { describe, expect, it } from 'vitest';

import { projectReplayState } from '../../src/session/replay-projector.js';
import type { WireRecord } from '../../src/storage/wire-record.js';

// ── Record factories (mirror the existing replay-projector.test.ts style) ─

function user(seq: number, turnId: string, content: string): WireRecord {
  return {
    type: 'user_message',
    seq,
    time: seq,
    turn_id: turnId,
    content,
  };
}

function assistant(
  seq: number,
  turnId: string,
  text: string,
  usage?: { input_tokens: number; output_tokens: number },
): WireRecord {
  return {
    type: 'assistant_message',
    seq,
    time: seq,
    turn_id: turnId,
    text,
    think: null,
    tool_calls: [],
    model: 'test-model',
    ...(usage !== undefined ? { usage } : {}),
  };
}

function cleared(seq: number): WireRecord {
  return {
    type: 'context_cleared',
    seq,
    time: seq,
  };
}

// ── 1. Core behaviour: clear empties accumulated projection ──────────────

describe('projectReplayState — context_cleared resets conversation', () => {
  it('drops messages and zeros tokenCount when clear is the last record', () => {
    const records: WireRecord[] = [
      user(1, 't1', 'hello'),
      assistant(2, 't1', 'hi', { input_tokens: 100, output_tokens: 50 }),
      cleared(3),
    ];

    const result = projectReplayState(records);

    expect(result.messages).toHaveLength(0);
    expect(result.tokenCount).toBe(0);
    expect(result.lastSeq).toBe(3);
  });

  it('rebuilds messages from empty for records after the clear', () => {
    const records: WireRecord[] = [
      user(1, 't1', 'first'),
      assistant(2, 't1', 'reply1', { input_tokens: 100, output_tokens: 50 }),
      cleared(3),
      user(4, 't2', 'second'),
      assistant(5, 't2', 'reply2', { input_tokens: 20, output_tokens: 10 }),
    ];

    const result = projectReplayState(records);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[1]!.role).toBe('assistant');
    // tokenCount only counts assistant_messages AFTER the last clear.
    expect(result.tokenCount).toBe(30);
    expect(result.lastSeq).toBe(5);
  });

  it('two successive context_cleared records do not crash and still land empty', () => {
    const records: WireRecord[] = [
      user(1, 't1', 'a'),
      assistant(2, 't1', 'b', { input_tokens: 5, output_tokens: 5 }),
      cleared(3),
      cleared(4),
    ];

    const result = projectReplayState(records);

    expect(result.messages).toHaveLength(0);
    expect(result.tokenCount).toBe(0);
    expect(result.lastSeq).toBe(4);
  });

  it('a lone context_cleared with no prior conversation stays empty', () => {
    const records: WireRecord[] = [cleared(1)];

    const result = projectReplayState(records);

    expect(result.messages).toHaveLength(0);
    expect(result.tokenCount).toBe(0);
    expect(result.lastSeq).toBe(1);
  });
});

// ── 2. Config-class records survive a clear ──────────────────────────────

describe('projectReplayState — context_cleared preserves config-class state', () => {
  it('model / systemPrompt / activeTools from before the clear remain in the projection', () => {
    const records: WireRecord[] = [
      {
        type: 'model_changed',
        seq: 1,
        time: 1,
        old_model: 'old',
        new_model: 'moonshot-v2',
      },
      {
        type: 'system_prompt_changed',
        seq: 2,
        time: 2,
        new_prompt: 'persistent sp',
      },
      {
        type: 'tools_changed',
        seq: 3,
        time: 3,
        operation: 'set_active',
        tools: ['Read', 'Write'],
      },
      user(4, 't1', 'hi'),
      assistant(5, 't1', 'hello', { input_tokens: 10, output_tokens: 5 }),
      cleared(6),
    ];

    const result = projectReplayState(records);

    expect(result.messages).toHaveLength(0);
    expect(result.tokenCount).toBe(0);
    expect(result.model).toBe('moonshot-v2');
    expect(result.systemPrompt).toBe('persistent sp');
    expect(result.activeTools).toEqual(new Set(['Read', 'Write']));
  });

  it('does not alter permissionMode or planMode from prior _changed records', () => {
    const records: WireRecord[] = [
      {
        type: 'permission_mode_changed',
        seq: 1,
        time: 1,
        data: { from: 'default', to: 'bypassPermissions', reason: '/yolo on' },
      },
      {
        type: 'plan_mode_changed',
        seq: 2,
        time: 2,
        enabled: true,
      },
      user(3, 't1', 'hi'),
      cleared(4),
    ];

    const result = projectReplayState(records);

    expect(result.permissionMode).toBe('bypassPermissions');
    expect(result.planMode).toBe(true);
    expect(result.messages).toHaveLength(0);
  });
});

// ── 3. Compaction interaction ────────────────────────────────────────────

describe('projectReplayState — context_cleared after compaction', () => {
  it('clear wipes the compaction summary message as well', () => {
    const records: WireRecord[] = [
      user(1, 't1', 'a'),
      assistant(2, 't1', 'b', { input_tokens: 100, output_tokens: 50 }),
      {
        type: 'compaction',
        seq: 3,
        time: 3,
        summary: 'summary of t1',
        compacted_range: { from_turn: 1, to_turn: 1, message_count: 2 },
        pre_compact_tokens: 150,
        post_compact_tokens: 40,
        trigger: 'auto',
      },
      cleared(4),
    ];

    const result = projectReplayState(records);

    expect(result.messages).toHaveLength(0);
    expect(result.tokenCount).toBe(0);
  });
});
