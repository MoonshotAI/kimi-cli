// Phase 25 Stage A — Slice 25b: wire-record atomic-schema additive extension.
//
// This suite locks the zod schemas + TS interfaces for the 4 new atomic
// record types (step_begin / step_end / content_part / tool_call) and the
// backwards-compatible optional fields added to 5 existing records
// (tool_result / user_message / subagent_spawned / subagent_completed /
// subagent_failed).
//
// Scope of this slice is schema-only: no production callers produce these
// records yet; the atomic switchover lives in slice 25c. Every test here
// FAILS until the Implementer lands the schema extension in
// `src/storage/wire-record.ts` + exports `KNOWN_RECORD_TYPES` from
// `src/storage/replay.ts`.
//
// Backwards-compat coverage (the new optional fields on the 5 existing
// records) is the core reason this extension is gated into its own slice:
// wire.jsonl files written before this slice must still replay byte-for-byte.

import { describe, expect, it } from 'vitest';

import { KNOWN_RECORD_TYPES } from '../../src/storage/replay.js';
import {
  ContentPartRecordSchema,
  StepBeginRecordSchema,
  StepEndRecordSchema,
  SubagentCompletedRecordSchema,
  SubagentFailedRecordSchema,
  SubagentSpawnedRecordSchema,
  ToolCallRecordSchema,
  ToolResultRecordSchema,
  UserMessageRecordSchema,
  WireRecordSchema,
} from '../../src/storage/wire-record.js';
import type {
  ContentPartRecord,
  StepBeginRecord,
  StepEndRecord,
  ToolCallRecord,
  WireRecord,
} from '../../src/storage/wire-record.js';
import type { ToolInputDisplay } from '../../src/soul/types.js';

// ── Shared fixtures ────────────────────────────────────────────────────

const BASE_TURN = 't-turn-1';
const BASE_STEP_UUID = 'u-step-1';

const VALID_TOOL_INPUT_DISPLAY: ToolInputDisplay = {
  kind: 'command',
  command: 'ls -la',
};

// ── 4 new atomic record types ──────────────────────────────────────────

describe('StepBeginRecordSchema (new — phase 25 §A.2 / D-STEP-ID)', () => {
  it('round-trips a canonical step_begin row with uuid anchor', () => {
    const input = {
      type: 'step_begin' as const,
      seq: 10,
      time: 1_712_790_000_000,
      uuid: BASE_STEP_UUID,
      turn_id: BASE_TURN,
      step: 0,
    };
    const parsed: StepBeginRecord = StepBeginRecordSchema.parse(input);
    expect(parsed.type).toBe('step_begin');
    expect(parsed.uuid).toBe(BASE_STEP_UUID);
    expect(parsed.turn_id).toBe(BASE_TURN);
    expect(parsed.step).toBe(0);
    expect(parsed.seq).toBe(10);
  });

  it('routes through the top-level WireRecordSchema discriminated union', () => {
    const parsed = WireRecordSchema.parse({
      type: 'step_begin',
      seq: 1,
      time: 1,
      uuid: BASE_STEP_UUID,
      turn_id: BASE_TURN,
      step: 2,
    });
    expect(parsed.type).toBe('step_begin');
  });

  it('rejects a step_begin row missing the required uuid anchor', () => {
    const result = StepBeginRecordSchema.safeParse({
      type: 'step_begin',
      seq: 1,
      time: 1,
      turn_id: BASE_TURN,
      step: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a step_begin row missing turn_id', () => {
    const result = StepBeginRecordSchema.safeParse({
      type: 'step_begin',
      seq: 1,
      time: 1,
      uuid: BASE_STEP_UUID,
      step: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a step_begin row missing step', () => {
    const result = StepBeginRecordSchema.safeParse({
      type: 'step_begin',
      seq: 1,
      time: 1,
      uuid: BASE_STEP_UUID,
      turn_id: BASE_TURN,
    });
    expect(result.success).toBe(false);
  });
});

describe('StepEndRecordSchema (new — phase 25 §A.2)', () => {
  it('round-trips a step_end row without optional usage / finish_reason', () => {
    const input = {
      type: 'step_end' as const,
      seq: 11,
      time: 1_712_790_001_000,
      uuid: 'u-step-end-1',
      turn_id: BASE_TURN,
      step: 0,
    };
    const parsed: StepEndRecord = StepEndRecordSchema.parse(input);
    expect(parsed.uuid).toBe('u-step-end-1');
    expect(parsed.usage).toBeUndefined();
    expect(parsed.finish_reason).toBeUndefined();
  });

  it('carries a full usage block with cache counters', () => {
    const parsed = StepEndRecordSchema.parse({
      type: 'step_end',
      seq: 11,
      time: 1,
      uuid: 'u-step-end-2',
      turn_id: BASE_TURN,
      step: 1,
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        cache_read_tokens: 15,
        cache_write_tokens: 5,
      },
      finish_reason: 'stop',
    });
    expect(parsed.usage?.input_tokens).toBe(120);
    expect(parsed.usage?.cache_read_tokens).toBe(15);
    expect(parsed.usage?.cache_write_tokens).toBe(5);
    expect(parsed.finish_reason).toBe('stop');
  });

  it('accepts usage without the optional cache counters', () => {
    const parsed = StepEndRecordSchema.parse({
      type: 'step_end',
      seq: 11,
      time: 1,
      uuid: 'u-step-end-3',
      turn_id: BASE_TURN,
      step: 2,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
      },
    });
    expect(parsed.usage?.cache_read_tokens).toBeUndefined();
    expect(parsed.usage?.cache_write_tokens).toBeUndefined();
  });

  it('has a uuid independent of step_begin.uuid (no structural conflation)', () => {
    // Nothing in the schema forces them to differ; this test documents the
    // contract that step_begin.uuid and step_end.uuid are independent
    // values and can coexist on the same step/turn.
    const begin = StepBeginRecordSchema.parse({
      type: 'step_begin',
      seq: 1,
      time: 1,
      uuid: 'u-begin',
      turn_id: BASE_TURN,
      step: 0,
    });
    const end = StepEndRecordSchema.parse({
      type: 'step_end',
      seq: 2,
      time: 1,
      uuid: 'u-end',
      turn_id: BASE_TURN,
      step: 0,
    });
    expect(begin.uuid).not.toBe(end.uuid);
  });

  it('routes through WireRecordSchema', () => {
    const parsed = WireRecordSchema.parse({
      type: 'step_end',
      seq: 12,
      time: 1,
      uuid: 'u-end',
      turn_id: BASE_TURN,
      step: 0,
    });
    expect(parsed.type).toBe('step_end');
  });

  it('rejects a step_end row missing uuid', () => {
    const result = StepEndRecordSchema.safeParse({
      type: 'step_end',
      seq: 1,
      time: 1,
      turn_id: BASE_TURN,
      step: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('ContentPartRecordSchema (new — phase 25 §A.2 / D-MSG-ID)', () => {
  it('round-trips a text part anchored to its step_uuid', () => {
    const input = {
      type: 'content_part' as const,
      seq: 20,
      time: 1_712_790_002_000,
      uuid: 'u-part-1',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      role: 'assistant' as const,
      part: { kind: 'text' as const, text: 'Hello, world.' },
    };
    const parsed: ContentPartRecord = ContentPartRecordSchema.parse(input);
    expect(parsed.step_uuid).toBe(BASE_STEP_UUID);
    expect(parsed.role).toBe('assistant');
    if (parsed.part.kind === 'text') {
      expect(parsed.part.text).toBe('Hello, world.');
    } else {
      throw new Error('expected text part');
    }
  });

  it('round-trips a think part without the optional encrypted payload', () => {
    const parsed = ContentPartRecordSchema.parse({
      type: 'content_part',
      seq: 21,
      time: 1,
      uuid: 'u-part-2',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      role: 'assistant',
      part: { kind: 'think', think: 'let me think...' },
    });
    if (parsed.part.kind === 'think') {
      expect(parsed.part.think).toBe('let me think...');
      expect(parsed.part.encrypted).toBeUndefined();
    } else {
      throw new Error('expected think part');
    }
  });

  it('round-trips a think part with the optional encrypted payload', () => {
    const parsed = ContentPartRecordSchema.parse({
      type: 'content_part',
      seq: 21,
      time: 1,
      uuid: 'u-part-2b',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      role: 'assistant',
      part: {
        kind: 'think',
        think: 'private reasoning',
        encrypted: 'base64:deadbeef',
      },
    });
    if (parsed.part.kind === 'think') {
      expect(parsed.part.encrypted).toBe('base64:deadbeef');
    } else {
      throw new Error('expected think part');
    }
  });

  it('routes through WireRecordSchema', () => {
    const parsed = WireRecordSchema.parse({
      type: 'content_part',
      seq: 22,
      time: 1,
      uuid: 'u-part-union',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      role: 'assistant',
      part: { kind: 'text', text: 'via union' },
    });
    expect(parsed.type).toBe('content_part');
  });

  it('rejects an unknown part.kind value', () => {
    const result = ContentPartRecordSchema.safeParse({
      type: 'content_part',
      seq: 1,
      time: 1,
      uuid: 'u-part',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      role: 'assistant',
      part: { kind: 'image', url: 'https://x' }, // not in phase-1 vocabulary
    });
    expect(result.success).toBe(false);
  });

  it('rejects a record missing the required part field', () => {
    const result = ContentPartRecordSchema.safeParse({
      type: 'content_part',
      seq: 1,
      time: 1,
      uuid: 'u-part',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      role: 'assistant',
    });
    expect(result.success).toBe(false);
  });

  it('rejects role other than assistant (phase 1 only emits assistant parts)', () => {
    const result = ContentPartRecordSchema.safeParse({
      type: 'content_part',
      seq: 1,
      time: 1,
      uuid: 'u-part',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      role: 'user',
      part: { kind: 'text', text: 'user cannot emit parts yet' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a text part that is missing the text field', () => {
    const result = ContentPartRecordSchema.safeParse({
      type: 'content_part',
      seq: 1,
      time: 1,
      uuid: 'u-part',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      role: 'assistant',
      part: { kind: 'text' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a record missing step_uuid (breaks D-MSG-ID anchoring)', () => {
    const result = ContentPartRecordSchema.safeParse({
      type: 'content_part',
      seq: 1,
      time: 1,
      uuid: 'u-part',
      turn_id: BASE_TURN,
      step: 0,
      role: 'assistant',
      part: { kind: 'text', text: 'orphan' },
    });
    expect(result.success).toBe(false);
  });
});

describe('ToolCallRecordSchema (new — phase 25 §A.2 / D-TOOLCALL-UNIFIED)', () => {
  it('round-trips a minimal tool_call with only the required data fields', () => {
    const input = {
      type: 'tool_call' as const,
      seq: 30,
      time: 1_712_790_003_000,
      uuid: 'u-tc-1',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      data: {
        tool_call_id: 'tc_provider_1',
        tool_name: 'Bash',
        args: { command: 'ls' },
      },
    };
    const parsed: ToolCallRecord = ToolCallRecordSchema.parse(input);
    expect(parsed.data.tool_call_id).toBe('tc_provider_1');
    expect(parsed.data.tool_name).toBe('Bash');
    expect(parsed.data.activity_description).toBeUndefined();
    expect(parsed.data.user_facing_name).toBeUndefined();
    expect(parsed.data.input_display).toBeUndefined();
  });

  it('round-trips with all three optional display hints populated', () => {
    const parsed = ToolCallRecordSchema.parse({
      type: 'tool_call',
      seq: 31,
      time: 1,
      uuid: 'u-tc-2',
      turn_id: BASE_TURN,
      step: 1,
      step_uuid: BASE_STEP_UUID,
      data: {
        tool_call_id: 'tc_2',
        tool_name: 'Read',
        args: { file: '/tmp/x' },
        activity_description: 'Reading /tmp/x',
        user_facing_name: 'Read file',
        input_display: VALID_TOOL_INPUT_DISPLAY,
      },
    });
    expect(parsed.data.activity_description).toBe('Reading /tmp/x');
    expect(parsed.data.user_facing_name).toBe('Read file');
    expect(parsed.data.input_display?.kind).toBe('command');
  });

  it('accepts args shaped as an object, null, string, number, array, or boolean', () => {
    const shapes: unknown[] = [
      { foo: 'bar' },
      null,
      'raw-string-args',
      42,
      [1, 2, 3],
      true,
    ];
    for (const args of shapes) {
      const parsed = ToolCallRecordSchema.parse({
        type: 'tool_call',
        seq: 1,
        time: 1,
        uuid: 'u-tc-args',
        turn_id: BASE_TURN,
        step: 0,
        step_uuid: BASE_STEP_UUID,
        data: {
          tool_call_id: 'tc_args',
          tool_name: 'Any',
          args,
        },
      });
      expect(parsed.data.tool_call_id).toBe('tc_args');
    }
  });

  it('routes through WireRecordSchema', () => {
    const parsed = WireRecordSchema.parse({
      type: 'tool_call',
      seq: 32,
      time: 1,
      uuid: 'u-tc-union',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      data: {
        tool_call_id: 'tc_u',
        tool_name: 'Bash',
        args: { command: 'pwd' },
      },
    });
    expect(parsed.type).toBe('tool_call');
  });

  it('rejects a tool_call record missing the uuid anchor', () => {
    const result = ToolCallRecordSchema.safeParse({
      type: 'tool_call',
      seq: 1,
      time: 1,
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      data: {
        tool_call_id: 'tc_x',
        tool_name: 'Bash',
        args: null,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tool_call record missing step_uuid', () => {
    const result = ToolCallRecordSchema.safeParse({
      type: 'tool_call',
      seq: 1,
      time: 1,
      uuid: 'u-tc',
      turn_id: BASE_TURN,
      step: 0,
      data: {
        tool_call_id: 'tc_x',
        tool_name: 'Bash',
        args: null,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tool_call record missing data.tool_call_id', () => {
    const result = ToolCallRecordSchema.safeParse({
      type: 'tool_call',
      seq: 1,
      time: 1,
      uuid: 'u-tc',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      data: {
        tool_name: 'Bash',
        args: null,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tool_call record with malformed input_display', () => {
    const result = ToolCallRecordSchema.safeParse({
      type: 'tool_call',
      seq: 1,
      time: 1,
      uuid: 'u-tc',
      turn_id: BASE_TURN,
      step: 0,
      step_uuid: BASE_STEP_UUID,
      data: {
        tool_call_id: 'tc_x',
        tool_name: 'Bash',
        args: null,
        input_display: { kind: 'not-a-real-display-kind' },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ── 5 existing records — additive optional fields (backwards compat) ───

describe('ToolResultRecordSchema — additive optional uuid / parent_uuid', () => {
  it('still parses legacy rows that omit both uuid and parent_uuid', () => {
    const parsed = ToolResultRecordSchema.parse({
      type: 'tool_result',
      seq: 6,
      time: 1,
      turn_id: BASE_TURN,
      tool_call_id: 'tc_1',
      output: 'done',
    });
    expect(parsed.tool_call_id).toBe('tc_1');
    expect((parsed as { uuid?: unknown }).uuid).toBeUndefined();
    expect((parsed as { parent_uuid?: unknown }).parent_uuid).toBeUndefined();
  });

  it('parses a new row carrying uuid + parent_uuid alongside tool_call_id', () => {
    const parsed = ToolResultRecordSchema.parse({
      type: 'tool_result',
      seq: 6,
      time: 1,
      turn_id: BASE_TURN,
      tool_call_id: 'tc_1',
      output: { ok: true },
      uuid: 'u-result-1',
      parent_uuid: 'u-tc-1',
    }) as {
      tool_call_id: string;
      uuid?: string;
      parent_uuid?: string;
    };
    expect(parsed.uuid).toBe('u-result-1');
    expect(parsed.parent_uuid).toBe('u-tc-1');
    expect(parsed.tool_call_id).toBe('tc_1');
  });

  it('routes both legacy and new tool_result shapes through the top-level union', () => {
    const legacy = WireRecordSchema.parse({
      type: 'tool_result',
      seq: 1,
      time: 1,
      turn_id: BASE_TURN,
      tool_call_id: 'tc_1',
      output: 'ok',
    });
    expect(legacy.type).toBe('tool_result');
    const extended = WireRecordSchema.parse({
      type: 'tool_result',
      seq: 2,
      time: 1,
      turn_id: BASE_TURN,
      tool_call_id: 'tc_1',
      output: 'ok',
      uuid: 'u-res',
      parent_uuid: 'u-call',
    });
    expect(extended.type).toBe('tool_result');
  });
});

describe('UserMessageRecordSchema — additive optional uuid', () => {
  it('still parses legacy rows without uuid', () => {
    const parsed = UserMessageRecordSchema.parse({
      type: 'user_message',
      seq: 4,
      time: 1,
      turn_id: BASE_TURN,
      content: 'hi',
    });
    expect(parsed.content).toBe('hi');
    expect((parsed as { uuid?: unknown }).uuid).toBeUndefined();
  });

  it('parses a new row with uuid', () => {
    const parsed = UserMessageRecordSchema.parse({
      type: 'user_message',
      seq: 4,
      time: 1,
      turn_id: BASE_TURN,
      content: 'hi again',
      uuid: 'u-um-1',
    }) as { content: unknown; uuid?: string };
    expect(parsed.uuid).toBe('u-um-1');
  });
});

describe('SubagentSpawnedRecordSchema — additive optional uuid + data.parent_tool_call_uuid', () => {
  it('still parses legacy rows with neither top-level uuid nor data.parent_tool_call_uuid', () => {
    const parsed = SubagentSpawnedRecordSchema.parse({
      type: 'subagent_spawned',
      seq: 1,
      time: 1,
      data: {
        agent_id: 'sub_a',
        parent_tool_call_id: 'tc_parent',
        run_in_background: false,
      },
    });
    expect(parsed.data.agent_id).toBe('sub_a');
    expect((parsed as { uuid?: unknown }).uuid).toBeUndefined();
    expect(
      (parsed.data as { parent_tool_call_uuid?: unknown }).parent_tool_call_uuid,
    ).toBeUndefined();
  });

  it('parses a new row carrying top-level uuid and data.parent_tool_call_uuid', () => {
    const parsed = SubagentSpawnedRecordSchema.parse({
      type: 'subagent_spawned',
      seq: 1,
      time: 1,
      uuid: 'u-spawn-1',
      data: {
        agent_id: 'sub_a',
        parent_tool_call_id: 'tc_parent',
        parent_tool_call_uuid: 'u-tc-parent',
        run_in_background: false,
      },
    }) as {
      uuid?: string;
      data: {
        agent_id: string;
        parent_tool_call_id: string;
        parent_tool_call_uuid?: string;
      };
    };
    expect(parsed.uuid).toBe('u-spawn-1');
    expect(parsed.data.parent_tool_call_uuid).toBe('u-tc-parent');
    // provider-id form preserved unchanged
    expect(parsed.data.parent_tool_call_id).toBe('tc_parent');
  });

  it('accepts the mixed case where one of the two new fields is present', () => {
    // top-level uuid present, data.parent_tool_call_uuid absent
    const a = SubagentSpawnedRecordSchema.parse({
      type: 'subagent_spawned',
      seq: 1,
      time: 1,
      uuid: 'u-spawn-top-only',
      data: {
        agent_id: 'sub_a',
        parent_tool_call_id: 'tc_parent',
        run_in_background: false,
      },
    }) as { uuid?: string };
    expect(a.uuid).toBe('u-spawn-top-only');
    // top-level uuid absent, data.parent_tool_call_uuid present
    const b = SubagentSpawnedRecordSchema.parse({
      type: 'subagent_spawned',
      seq: 2,
      time: 1,
      data: {
        agent_id: 'sub_b',
        parent_tool_call_id: 'tc_parent',
        parent_tool_call_uuid: 'u-tc-parent',
        run_in_background: true,
      },
    }) as {
      uuid?: string;
      data: { parent_tool_call_uuid?: string };
    };
    expect(b.uuid).toBeUndefined();
    expect(b.data.parent_tool_call_uuid).toBe('u-tc-parent');
  });
});

describe('SubagentCompletedRecordSchema — additive optional uuid + parent_uuid', () => {
  it('still parses legacy rows without uuid / parent_uuid', () => {
    const parsed = SubagentCompletedRecordSchema.parse({
      type: 'subagent_completed',
      seq: 1,
      time: 1,
      data: {
        agent_id: 'sub_a',
        parent_tool_call_id: 'tc_parent',
        result_summary: 'done',
      },
    });
    expect(parsed.data.result_summary).toBe('done');
    expect((parsed as { uuid?: unknown }).uuid).toBeUndefined();
    expect((parsed as { parent_uuid?: unknown }).parent_uuid).toBeUndefined();
  });

  it('parses a new row with top-level uuid + parent_uuid', () => {
    const parsed = SubagentCompletedRecordSchema.parse({
      type: 'subagent_completed',
      seq: 1,
      time: 1,
      uuid: 'u-complete-1',
      parent_uuid: 'u-spawn-1',
      data: {
        agent_id: 'sub_a',
        parent_tool_call_id: 'tc_parent',
        result_summary: 'done',
      },
    }) as { uuid?: string; parent_uuid?: string };
    expect(parsed.uuid).toBe('u-complete-1');
    expect(parsed.parent_uuid).toBe('u-spawn-1');
  });
});

describe('SubagentFailedRecordSchema — additive optional uuid + parent_uuid', () => {
  it('still parses legacy rows without uuid / parent_uuid', () => {
    const parsed = SubagentFailedRecordSchema.parse({
      type: 'subagent_failed',
      seq: 1,
      time: 1,
      data: {
        agent_id: 'sub_a',
        parent_tool_call_id: 'tc_parent',
        error: 'boom',
      },
    });
    expect(parsed.data.error).toBe('boom');
    expect((parsed as { uuid?: unknown }).uuid).toBeUndefined();
    expect((parsed as { parent_uuid?: unknown }).parent_uuid).toBeUndefined();
  });

  it('parses a new row with top-level uuid + parent_uuid', () => {
    const parsed = SubagentFailedRecordSchema.parse({
      type: 'subagent_failed',
      seq: 1,
      time: 1,
      uuid: 'u-fail-1',
      parent_uuid: 'u-spawn-1',
      data: {
        agent_id: 'sub_a',
        parent_tool_call_id: 'tc_parent',
        error: 'aborted',
      },
    }) as { uuid?: string; parent_uuid?: string };
    expect(parsed.uuid).toBe('u-fail-1');
    expect(parsed.parent_uuid).toBe('u-spawn-1');
  });
});

// ── WireRecord TypeScript union includes the 4 new branches ────────────

describe('WireRecord TS union (compile-time assertion)', () => {
  it('accepts all 4 new atomic variants in an exhaustive type-narrowing switch', () => {
    // This test is intentionally structured so that removing any of the 4
    // new branches from the `WireRecord` TS union would fail to typecheck
    // (the `default: never` arm would break). The runtime check is a
    // sanity validation that `type` is one of the expected strings.
    const inputs: WireRecord[] = [
      {
        type: 'step_begin',
        seq: 1,
        time: 1,
        uuid: 'u1',
        turn_id: BASE_TURN,
        step: 0,
      },
      {
        type: 'step_end',
        seq: 2,
        time: 1,
        uuid: 'u2',
        turn_id: BASE_TURN,
        step: 0,
      },
      {
        type: 'content_part',
        seq: 3,
        time: 1,
        uuid: 'u3',
        turn_id: BASE_TURN,
        step: 0,
        step_uuid: 'u1',
        role: 'assistant',
        part: { kind: 'text', text: 'hi' },
      },
      {
        type: 'tool_call',
        seq: 4,
        time: 1,
        uuid: 'u4',
        turn_id: BASE_TURN,
        step: 0,
        step_uuid: 'u1',
        data: {
          tool_call_id: 'tc_1',
          tool_name: 'Bash',
          args: null,
        },
      },
    ];
    const seen: string[] = [];
    for (const rec of inputs) {
      switch (rec.type) {
        case 'step_begin':
        case 'step_end':
        case 'content_part':
        case 'tool_call':
          seen.push(rec.type);
          break;
        default:
          // All other WireRecord variants — unreachable for the fixtures above.
          seen.push('other');
      }
    }
    expect(seen).toEqual(['step_begin', 'step_end', 'content_part', 'tool_call']);
  });
});

// ── KNOWN_RECORD_TYPES extension (replay.ts) ───────────────────────────

describe('KNOWN_RECORD_TYPES extension (replay.ts)', () => {
  it('is a ReadonlySet<string>', () => {
    expect(KNOWN_RECORD_TYPES).toBeInstanceOf(Set);
    for (const t of KNOWN_RECORD_TYPES) {
      expect(typeof t).toBe('string');
    }
  });

  it('contains the 4 new atomic record type strings', () => {
    expect(KNOWN_RECORD_TYPES.has('step_begin')).toBe(true);
    expect(KNOWN_RECORD_TYPES.has('step_end')).toBe(true);
    expect(KNOWN_RECORD_TYPES.has('content_part')).toBe(true);
    expect(KNOWN_RECORD_TYPES.has('tool_call')).toBe(true);
  });

  it('still contains the soon-to-be-removed legacy types (slice 25c scope)', () => {
    // This slice is additive only — the legacy types stay registered
    // until slice 25c flips the producer path and deletes them.
    expect(KNOWN_RECORD_TYPES.has('assistant_message')).toBe(true);
    expect(KNOWN_RECORD_TYPES.has('tool_call_dispatched')).toBe(true);
  });

  it('still contains the non-atomic stable types unchanged', () => {
    for (const t of [
      'turn_begin',
      'turn_end',
      'user_message',
      'tool_result',
      'compaction',
      'subagent_spawned',
      'subagent_completed',
      'subagent_failed',
      'session_meta_changed',
    ]) {
      expect(KNOWN_RECORD_TYPES.has(t)).toBe(true);
    }
  });
});
