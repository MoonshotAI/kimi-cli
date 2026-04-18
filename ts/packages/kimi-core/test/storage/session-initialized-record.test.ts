/**
 * Phase 23 — SessionInitializedRecord wire schema (T1).
 *
 * Locks the wire-side shape of `session_initialized` for all three
 * agent_type branches (main / sub / independent) plus top-level routing
 * through `WireRecordSchema`.
 *
 * Red bar until Phase 23 Step 1 (`SessionInitializedRecordSchema`) lands
 * and is wired into `WireRecordSchema`.
 *
 * Spec references:
 *   - phase-23-session-initialized.md §Step 1 (1.1–1.3)
 *   - v2 design §4.1.2 (wire.jsonl physical row contract)
 *
 * Scope:
 *   1. main branch — session_id required, no parent fields
 *   2. sub branch  — parent_session_id + parent_tool_call_id + run_in_background required;
 *                    agent_name / parent_agent_id / thinking_level optional
 *   3. independent branch — agent_id required, no parent (C8 留 schema slot)
 *   4. discriminator errors (missing / invalid agent_type) → safeParse fails
 *   5. common-field validation (invalid permission_mode, missing system_prompt)
 *   6. route through top-level WireRecordSchema discriminatedUnion
 *
 * Non-goals:
 *   - behavioural tests (replayWire / projectReplayState / createSession);
 *     those live in T2 / T3 / T4 / T5.
 */

import { describe, expect, it } from 'vitest';

import {
  SessionInitializedRecordSchema,
  WireRecordSchema,
  type SessionInitializedRecord,
} from '../../src/storage/wire-record.js';

// ── helpers ─────────────────────────────────────────────────────────

function commonFields() {
  return {
    type: 'session_initialized' as const,
    seq: 1,
    time: 1712790000000,
    system_prompt: 'you are helpful',
    model: 'moonshot-v1',
    active_tools: ['bash', 'read'],
    permission_mode: 'default' as const,
    plan_mode: false,
    workspace_dir: '/tmp/work',
  };
}

// ── 1. main branch ──────────────────────────────────────────────────
describe('SessionInitializedRecordSchema — main branch', () => {
  it('accepts a canonical main record with session_id', () => {
    const parsed = SessionInitializedRecordSchema.parse({
      ...commonFields(),
      agent_type: 'main',
      session_id: 'ses_abc123',
    });
    expect(parsed.agent_type).toBe('main');
    if (parsed.agent_type === 'main') {
      expect(parsed.session_id).toBe('ses_abc123');
    }
    expect(parsed.system_prompt).toBe('you are helpful');
    expect(parsed.model).toBe('moonshot-v1');
    expect(parsed.active_tools).toEqual(['bash', 'read']);
    expect(parsed.permission_mode).toBe('default');
  });

  it('accepts empty system_prompt (represents "not configured")', () => {
    const parsed = SessionInitializedRecordSchema.parse({
      ...commonFields(),
      system_prompt: '',
      agent_type: 'main',
      session_id: 'ses_empty',
    });
    expect(parsed.system_prompt).toBe('');
  });

  it('accepts empty active_tools array', () => {
    const parsed = SessionInitializedRecordSchema.parse({
      ...commonFields(),
      active_tools: [],
      agent_type: 'main',
      session_id: 'ses_no_tools',
    });
    expect(parsed.active_tools).toEqual([]);
  });

  it('accepts optional thinking_level', () => {
    const parsed = SessionInitializedRecordSchema.parse({
      ...commonFields(),
      thinking_level: 'high',
      agent_type: 'main',
      session_id: 'ses_think',
    });
    expect(parsed.thinking_level).toBe('high');
  });

  it('rejects main branch missing session_id', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      agent_type: 'main',
    });
    expect(result.success).toBe(false);
  });
});

// ── 2. sub branch ───────────────────────────────────────────────────
describe('SessionInitializedRecordSchema — sub branch', () => {
  it('accepts a canonical sub record with full parent lineage', () => {
    const parsed = SessionInitializedRecordSchema.parse({
      ...commonFields(),
      agent_type: 'sub',
      agent_id: 'sa_researcher_01',
      agent_name: 'researcher',
      parent_session_id: 'ses_parent',
      parent_tool_call_id: 'tc_1',
      run_in_background: false,
    });
    expect(parsed.agent_type).toBe('sub');
    if (parsed.agent_type === 'sub') {
      expect(parsed.agent_id).toBe('sa_researcher_01');
      expect(parsed.agent_name).toBe('researcher');
      expect(parsed.parent_session_id).toBe('ses_parent');
      expect(parsed.parent_tool_call_id).toBe('tc_1');
      expect(parsed.run_in_background).toBe(false);
    }
  });

  it('accepts sub without optional agent_name', () => {
    const parsed = SessionInitializedRecordSchema.parse({
      ...commonFields(),
      agent_type: 'sub',
      agent_id: 'sa_anon',
      parent_session_id: 'ses_parent',
      parent_tool_call_id: 'tc_2',
      run_in_background: true,
    });
    if (parsed.agent_type === 'sub') {
      expect(parsed.agent_name).toBeUndefined();
    }
  });

  it('accepts sub with optional parent_agent_id (nested subagent case)', () => {
    const parsed = SessionInitializedRecordSchema.parse({
      ...commonFields(),
      agent_type: 'sub',
      agent_id: 'sa_nested',
      parent_session_id: 'ses_root',
      parent_agent_id: 'sa_outer',
      parent_tool_call_id: 'tc_3',
      run_in_background: false,
    });
    if (parsed.agent_type === 'sub') {
      expect(parsed.parent_agent_id).toBe('sa_outer');
    }
  });

  it('rejects sub branch missing parent_session_id', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      agent_type: 'sub',
      agent_id: 'sa_x',
      parent_tool_call_id: 'tc_x',
      run_in_background: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects sub branch missing parent_tool_call_id', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      agent_type: 'sub',
      agent_id: 'sa_x',
      parent_session_id: 'ses_p',
      run_in_background: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects sub branch missing run_in_background flag', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      agent_type: 'sub',
      agent_id: 'sa_x',
      parent_session_id: 'ses_p',
      parent_tool_call_id: 'tc_x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects sub branch missing agent_id', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      agent_type: 'sub',
      parent_session_id: 'ses_p',
      parent_tool_call_id: 'tc_x',
      run_in_background: false,
    });
    expect(result.success).toBe(false);
  });
});

// ── 3. independent branch (schema slot only) ───────────────────────
describe('SessionInitializedRecordSchema — independent branch', () => {
  it('accepts an independent record with agent_id and no parent fields', () => {
    const parsed = SessionInitializedRecordSchema.parse({
      ...commonFields(),
      agent_type: 'independent',
      agent_id: 'ind_agent_1',
    });
    expect(parsed.agent_type).toBe('independent');
    if (parsed.agent_type === 'independent') {
      expect(parsed.agent_id).toBe('ind_agent_1');
    }
  });

  it('accepts independent with optional agent_name', () => {
    const parsed = SessionInitializedRecordSchema.parse({
      ...commonFields(),
      agent_type: 'independent',
      agent_id: 'ind_agent_2',
      agent_name: 'planner',
    });
    if (parsed.agent_type === 'independent') {
      expect(parsed.agent_name).toBe('planner');
    }
  });

  it('rejects independent branch missing agent_id', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      agent_type: 'independent',
    });
    expect(result.success).toBe(false);
  });
});

// ── 4. discriminator errors ─────────────────────────────────────────
describe('SessionInitializedRecordSchema — discriminator errors', () => {
  it('rejects missing agent_type', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      session_id: 'ses_x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid agent_type value', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      agent_type: 'team_lead',
      agent_id: 'a',
    });
    expect(result.success).toBe(false);
  });

  it('rejects wrong literal type', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      type: 'metadata',
      agent_type: 'main',
      session_id: 'ses_x',
    });
    expect(result.success).toBe(false);
  });
});

// ── 5. common-field validation ──────────────────────────────────────
describe('SessionInitializedRecordSchema — common field validation', () => {
  it('rejects missing system_prompt (empty string allowed, but not missing)', () => {
    const { system_prompt: _drop, ...rest } = commonFields();
    void _drop;
    const result = SessionInitializedRecordSchema.safeParse({
      ...rest,
      agent_type: 'main',
      session_id: 'ses_x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid permission_mode value', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      permission_mode: 'yolo',
      agent_type: 'main',
      session_id: 'ses_x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean plan_mode', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      plan_mode: 'false',
      agent_type: 'main',
      session_id: 'ses_x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-array active_tools', () => {
    const result = SessionInitializedRecordSchema.safeParse({
      ...commonFields(),
      active_tools: { bash: true },
      agent_type: 'main',
      session_id: 'ses_x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing workspace_dir', () => {
    const { workspace_dir: _drop, ...rest } = commonFields();
    void _drop;
    const result = SessionInitializedRecordSchema.safeParse({
      ...rest,
      agent_type: 'main',
      session_id: 'ses_x',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all three permission_mode values', () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      const parsed = SessionInitializedRecordSchema.parse({
        ...commonFields(),
        permission_mode: mode,
        agent_type: 'main',
        session_id: 'ses_x',
      });
      expect(parsed.permission_mode).toBe(mode);
    }
  });
});

// ── 6. route through WireRecordSchema (top-level union) ────────────
describe('WireRecordSchema — routes session_initialized through top-level discriminator', () => {
  it('parses a main session_initialized via the top-level WireRecord union', () => {
    const parsed = WireRecordSchema.parse({
      ...commonFields(),
      agent_type: 'main',
      session_id: 'ses_topr',
    });
    expect(parsed.type).toBe('session_initialized');
    // Narrowing through the top-level union must still expose agent_type.
    if (parsed.type === 'session_initialized' && parsed.agent_type === 'main') {
      expect(parsed.session_id).toBe('ses_topr');
    }
  });

  it('parses a sub session_initialized via the top-level WireRecord union', () => {
    const parsed = WireRecordSchema.parse({
      ...commonFields(),
      agent_type: 'sub',
      agent_id: 'sa_top',
      parent_session_id: 'ses_p',
      parent_tool_call_id: 'tc_top',
      run_in_background: false,
    });
    expect(parsed.type).toBe('session_initialized');
    if (parsed.type === 'session_initialized' && parsed.agent_type === 'sub') {
      expect(parsed.agent_id).toBe('sa_top');
    }
  });

  it('rejects malformed session_initialized through top-level union', () => {
    const result = WireRecordSchema.safeParse({
      ...commonFields(),
      agent_type: 'main',
      // no session_id
    });
    expect(result.success).toBe(false);
  });
});

// ── 7. compile-time type surface ───────────────────────────────────
describe('SessionInitializedRecord — type narrowing', () => {
  it('narrows via agent_type discriminator at the type level', () => {
    // This block is a type-level assertion disguised as a runtime test.
    // If the discriminated-union type surface regresses, this won't compile.
    const main: SessionInitializedRecord = {
      ...commonFields(),
      agent_type: 'main',
      session_id: 'ses_a',
    };
    if (main.agent_type === 'main') {
      expect(main.session_id).toBe('ses_a');
    }

    const sub: SessionInitializedRecord = {
      ...commonFields(),
      agent_type: 'sub',
      agent_id: 'sa_b',
      parent_session_id: 'ses_p',
      parent_tool_call_id: 'tc_b',
      run_in_background: true,
    };
    if (sub.agent_type === 'sub') {
      expect(sub.parent_tool_call_id).toBe('tc_b');
    }

    const indep: SessionInitializedRecord = {
      ...commonFields(),
      agent_type: 'independent',
      agent_id: 'ind_c',
    };
    if (indep.agent_type === 'independent') {
      expect(indep.agent_id).toBe('ind_c');
    }
  });
});
