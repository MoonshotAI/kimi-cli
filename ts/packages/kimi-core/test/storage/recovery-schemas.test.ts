/**
 * Recovery-related wire record schema tests (§8).
 *
 * Tests verify that:
 *   - TurnEndRecord accepts reason:'interrupted' + synthetic:true
 *   - ToolResultRecord accepts synthetic:true
 *   - ApprovalResponseRecord accepts synthetic:true
 *   - Zod schemas round-trip the new recovery fields
 */

import { describe, expect, it } from 'vitest';

import {
  TurnEndRecordSchema,
  ToolResultRecordSchema,
  ApprovalResponseRecordSchema,
  type TurnEndRecord,
  type ToolResultRecord,
  type ApprovalResponseRecord,
} from '../../src/storage/wire-record.js';

describe('TurnEndRecord with interrupted reason', () => {
  it('validates a synthetic interrupted turn_end', () => {
    const record: TurnEndRecord = {
      type: 'turn_end',
      seq: 10,
      time: Date.now(),
      turn_id: 't1',
      agent_type: 'main',
      success: false,
      reason: 'interrupted',
      synthetic: true,
    };
    const parsed = TurnEndRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.reason).toBe('interrupted');
      expect(parsed.data.synthetic).toBe(true);
    }
  });

  it('accepts turn_end without synthetic field (backward compatible)', () => {
    const record = {
      type: 'turn_end',
      seq: 11,
      time: Date.now(),
      turn_id: 't2',
      agent_type: 'main',
      success: true,
      reason: 'done',
    };
    const parsed = TurnEndRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.synthetic).toBeUndefined();
    }
  });

  it('accepts all four reason values', () => {
    const reasons = ['done', 'cancelled', 'error', 'interrupted'] as const;
    for (const reason of reasons) {
      const record = {
        type: 'turn_end',
        seq: 1,
        time: Date.now(),
        turn_id: 't1',
        agent_type: 'main',
        success: reason === 'done',
        reason,
      };
      const parsed = TurnEndRecordSchema.safeParse(record);
      expect(parsed.success).toBe(true);
    }
  });
});

describe('ToolResultRecord with synthetic field', () => {
  it('validates a synthetic error tool_result', () => {
    const record: ToolResultRecord = {
      type: 'tool_result',
      seq: 20,
      time: Date.now(),
      turn_id: 't1',
      tool_call_id: 'tc-1',
      output: 'tool execution cancelled',
      is_error: true,
      synthetic: true,
    };
    const parsed = ToolResultRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.is_error).toBe(true);
      expect(parsed.data.synthetic).toBe(true);
      expect(parsed.data.output).toBe('tool execution cancelled');
    }
  });

  it('accepts tool_result without synthetic field (backward compatible)', () => {
    const record = {
      type: 'tool_result',
      seq: 21,
      time: Date.now(),
      turn_id: 't1',
      tool_call_id: 'tc-2',
      output: 'success',
    };
    const parsed = ToolResultRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.synthetic).toBeUndefined();
    }
  });
});

describe('ApprovalResponseRecord with synthetic field', () => {
  it('validates a synthetic cancelled approval_response', () => {
    const record: ApprovalResponseRecord = {
      type: 'approval_response',
      seq: 30,
      time: Date.now(),
      turn_id: 't1',
      step: 1,
      data: {
        request_id: 'req-1',
        response: 'cancelled',
        feedback: 'interrupted by crash',
        synthetic: true,
      },
    };
    const parsed = ApprovalResponseRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.data.response).toBe('cancelled');
      expect(parsed.data.data.synthetic).toBe(true);
      expect(parsed.data.data.feedback).toBe('interrupted by crash');
    }
  });

  it('accepts approval_response without synthetic field (backward compatible)', () => {
    const record = {
      type: 'approval_response',
      seq: 31,
      time: Date.now(),
      turn_id: 't1',
      step: 1,
      data: {
        request_id: 'req-2',
        response: 'approved',
      },
    };
    const parsed = ApprovalResponseRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
  });
});
