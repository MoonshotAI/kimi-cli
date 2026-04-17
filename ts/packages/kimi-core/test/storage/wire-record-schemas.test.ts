// Component: WireRecord zod schemas (§4.3 + appendix B)
// These tests lock the wire-side shape of every record type that Slice 1
// scope covers. The implementer should not have to touch them.

import { describe, expect, it } from 'vitest';

import {
  ApprovalRequestRecordSchema,
  ApprovalResponseRecordSchema,
  ApprovalSourceSchema,
  AssistantMessageRecordSchema,
  CompactionRecordSchema,
  ContextEditRecordSchema,
  ModelChangedRecordSchema,
  NotificationRecordSchema,
  OwnershipChangedRecordSchema,
  PermissionModeChangedRecordSchema,
  PlanModeChangedRecordSchema,
  SkillCompletedRecordSchema,
  SkillInvokedRecordSchema,
  SubagentCompletedRecordSchema,
  SubagentFailedRecordSchema,
  SubagentSpawnedRecordSchema,
  SystemPromptChangedRecordSchema,
  SystemReminderRecordSchema,
  TeamMailRecordSchema,
  ThinkingChangedRecordSchema,
  ToolCallDispatchedRecordSchema,
  ToolDeniedRecordSchema,
  ToolResultRecordSchema,
  ToolsChangedRecordSchema,
  TurnBeginRecordSchema,
  TurnEndRecordSchema,
  UserMessageRecordSchema,
  WireFileMetadataSchema,
  WireRecordSchema,
} from '../../src/storage/wire-record.js';

describe('WireFileMetadataSchema', () => {
  it('accepts a canonical metadata header', () => {
    const parsed = WireFileMetadataSchema.parse({
      type: 'metadata',
      protocol_version: '2.1',
      created_at: 1712790000000,
      kimi_version: '1.0.0',
    });
    expect(parsed.protocol_version).toBe('2.1');
  });

  it('allows kimi_version to be omitted', () => {
    const parsed = WireFileMetadataSchema.parse({
      type: 'metadata',
      protocol_version: '2.1',
      created_at: 1712790000000,
    });
    expect(parsed.kimi_version).toBeUndefined();
  });

  it('rejects metadata with wrong literal type', () => {
    const result = WireFileMetadataSchema.safeParse({
      type: 'not_metadata',
      protocol_version: '2.1',
      created_at: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('turn_begin record', () => {
  it('accepts a real user turn with user_input present', () => {
    const parsed = TurnBeginRecordSchema.parse({
      type: 'turn_begin',
      seq: 1,
      time: 1712790000000,
      turn_id: 't1',
      agent_type: 'main',
      input_kind: 'user',
      user_input: 'hello',
    });
    expect(parsed.user_input).toBe('hello');
  });

  it('accepts a system_trigger turn without user_input', () => {
    const parsed = TurnBeginRecordSchema.parse({
      type: 'turn_begin',
      seq: 7,
      time: 1712790000000,
      turn_id: 't7',
      agent_type: 'main',
      input_kind: 'system_trigger',
      trigger_source: 'notification_drain',
    });
    expect(parsed.user_input).toBeUndefined();
    expect(parsed.trigger_source).toBe('notification_drain');
  });

  it('rejects an unknown agent_type', () => {
    const result = TurnBeginRecordSchema.safeParse({
      type: 'turn_begin',
      seq: 1,
      time: 1,
      turn_id: 't1',
      agent_type: 'unknown',
      input_kind: 'user',
    });
    expect(result.success).toBe(false);
  });
});

describe('turn_end record', () => {
  it('allows the usage block to be omitted', () => {
    const parsed = TurnEndRecordSchema.parse({
      type: 'turn_end',
      seq: 3,
      time: 2,
      turn_id: 't1',
      agent_type: 'main',
      success: false,
      reason: 'cancelled',
    });
    expect(parsed.usage).toBeUndefined();
  });

  it('parses a full usage block', () => {
    const parsed = TurnEndRecordSchema.parse({
      type: 'turn_end',
      seq: 3,
      time: 2,
      turn_id: 't1',
      agent_type: 'main',
      success: true,
      reason: 'done',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 5,
        cache_write_tokens: 0,
        cost_usd: 0.01,
      },
    });
    expect(parsed.usage?.input_tokens).toBe(10);
  });
});

describe('user_message record', () => {
  it('requires content to be a string', () => {
    const parsed = UserMessageRecordSchema.parse({
      type: 'user_message',
      seq: 4,
      time: 1,
      turn_id: 't1',
      content: 'hi',
    });
    expect(parsed.content).toBe('hi');
  });
});

describe('assistant_message record', () => {
  it('allows nullable text and think', () => {
    const parsed = AssistantMessageRecordSchema.parse({
      type: 'assistant_message',
      seq: 5,
      time: 1,
      turn_id: 't1',
      text: null,
      think: null,
      tool_calls: [],
      model: 'moonshot-v1',
    });
    expect(parsed.text).toBeNull();
  });

  it('accepts tool_calls with unknown args', () => {
    const parsed = AssistantMessageRecordSchema.parse({
      type: 'assistant_message',
      seq: 5,
      time: 1,
      turn_id: 't1',
      text: 'ok',
      think: null,
      tool_calls: [{ id: 'tc_1', name: 'Read', args: { file: '/foo' } }],
      model: 'moonshot-v1',
    });
    expect(parsed.tool_calls[0]?.name).toBe('Read');
  });
});

describe('assistant_message record — Slice 2.0 new fields (Fix 1 + Fix 2)', () => {
  it('accepts think_signature as optional field', () => {
    const parsed = AssistantMessageRecordSchema.parse({
      type: 'assistant_message',
      seq: 5,
      time: 1,
      turn_id: 't1',
      text: 'ok',
      think: 'reasoning',
      think_signature: 'sig_xyz',
      tool_calls: [],
      model: 'moonshot-v1',
    });
    expect(parsed.think_signature).toBe('sig_xyz');
  });

  it('old wire format (no think_signature) replays without error', () => {
    const parsed = AssistantMessageRecordSchema.parse({
      type: 'assistant_message',
      seq: 5,
      time: 1,
      turn_id: 't1',
      text: 'ok',
      think: null,
      tool_calls: [],
      model: 'moonshot-v1',
    });
    expect(parsed.think_signature).toBeUndefined();
  });

  it('accepts cache_write_tokens in usage', () => {
    const parsed = AssistantMessageRecordSchema.parse({
      type: 'assistant_message',
      seq: 5,
      time: 1,
      turn_id: 't1',
      text: 'ok',
      think: null,
      tool_calls: [],
      model: 'moonshot-v1',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 20,
        cache_write_tokens: 30,
      },
    });
    expect(parsed.usage?.cache_write_tokens).toBe(30);
  });

  it('old wire format (no cache_write_tokens in usage) replays without error', () => {
    const parsed = AssistantMessageRecordSchema.parse({
      type: 'assistant_message',
      seq: 5,
      time: 1,
      turn_id: 't1',
      text: 'ok',
      think: null,
      tool_calls: [],
      model: 'moonshot-v1',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(parsed.usage?.cache_write_tokens).toBeUndefined();
  });
});

describe('tool_result record', () => {
  it('allows is_error to be omitted', () => {
    const parsed = ToolResultRecordSchema.parse({
      type: 'tool_result',
      seq: 6,
      time: 1,
      turn_id: 't1',
      tool_call_id: 'tc_1',
      output: 'done',
    });
    expect(parsed.is_error).toBeUndefined();
  });
});

describe('compaction record', () => {
  it('parses a canonical compaction row', () => {
    const parsed = CompactionRecordSchema.parse({
      type: 'compaction',
      seq: 10,
      time: 1,
      summary: 'user asked about foo',
      compacted_range: { from_turn: 0, to_turn: 5, message_count: 12 },
      pre_compact_tokens: 20000,
      post_compact_tokens: 1200,
      trigger: 'auto',
      archive_file: 'wire.1.jsonl',
    });
    expect(parsed.compacted_range.from_turn).toBe(0);
  });
});

describe('config-change records', () => {
  it('system_prompt_changed round-trips', () => {
    const parsed = SystemPromptChangedRecordSchema.parse({
      type: 'system_prompt_changed',
      seq: 1,
      time: 1,
      new_prompt: 'you are a helpful assistant',
    });
    expect(parsed.new_prompt).toMatch(/helpful/);
  });

  it('model_changed carries old + new', () => {
    const parsed = ModelChangedRecordSchema.parse({
      type: 'model_changed',
      seq: 1,
      time: 1,
      old_model: 'gpt-4',
      new_model: 'gpt-4.1',
    });
    expect(parsed.new_model).toBe('gpt-4.1');
  });

  it('thinking_changed carries level string', () => {
    expect(() =>
      ThinkingChangedRecordSchema.parse({
        type: 'thinking_changed',
        seq: 1,
        time: 1,
        level: 'high',
      }),
    ).not.toThrow();
  });

  it('plan_mode_changed carries enabled bool', () => {
    const parsed = PlanModeChangedRecordSchema.parse({
      type: 'plan_mode_changed',
      seq: 1,
      time: 1,
      enabled: true,
    });
    expect(parsed.enabled).toBe(true);
  });

  it('tools_changed rejects unknown operation', () => {
    const result = ToolsChangedRecordSchema.safeParse({
      type: 'tools_changed',
      seq: 1,
      time: 1,
      operation: 'swap',
      tools: ['Read'],
    });
    expect(result.success).toBe(false);
  });
});

describe('system_reminder / notification records (management-class)', () => {
  it('system_reminder accepts content and optional consumed_at_turn', () => {
    const parsed = SystemReminderRecordSchema.parse({
      type: 'system_reminder',
      seq: 1,
      time: 1,
      content: 'you are in plan mode',
      consumed_at_turn: 3,
    });
    expect(parsed.consumed_at_turn).toBe(3);
  });

  it('notification requires targets and severity', () => {
    const parsed = NotificationRecordSchema.parse({
      type: 'notification',
      seq: 2,
      time: 1,
      data: {
        id: 'n00000001',
        category: 'task',
        type: 'task.succeeded',
        source_kind: 'background_task',
        source_id: 'bg_1',
        title: 'Task done',
        body: 'ok',
        severity: 'success',
        targets: ['llm', 'wire'],
      },
    });
    expect(parsed.data.targets).toContain('llm');
  });

  it('notification accepts optional envelope_id (Phase 8 / 决策 #103)', () => {
    const parsed = NotificationRecordSchema.parse({
      type: 'notification',
      seq: 3,
      time: 1,
      data: {
        id: 'n00000002',
        category: 'team',
        type: 'team.mail',
        source_kind: 'team_mail',
        source_id: 'mail_abc',
        title: 'New mail',
        body: 'from alice',
        severity: 'info',
        targets: ['llm'],
        envelope_id: 'env_0xdeadbeef',
      },
    });
    expect(parsed.data.envelope_id).toBe('env_0xdeadbeef');
  });

  it('notification rejects an invalid severity', () => {
    const result = NotificationRecordSchema.safeParse({
      type: 'notification',
      seq: 2,
      time: 1,
      data: {
        id: 'n1',
        category: 'task',
        type: 't',
        source_kind: 's',
        source_id: 's1',
        title: 't',
        body: 'b',
        severity: 'critical', // invalid
        targets: [],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('permission / tool-dispatch audit records', () => {
  it('permission_mode_changed allows turn_id to be omitted at startup', () => {
    expect(() =>
      PermissionModeChangedRecordSchema.parse({
        type: 'permission_mode_changed',
        seq: 1,
        time: 1,
        data: { from: 'ask', to: 'auto', reason: 'startup' },
      }),
    ).not.toThrow();
  });

  it('tool_call_dispatched requires step and assistant_message_id', () => {
    const parsed = ToolCallDispatchedRecordSchema.parse({
      type: 'tool_call_dispatched',
      seq: 1,
      time: 1,
      turn_id: 't1',
      step: 2,
      data: {
        tool_call_id: 'tc_1',
        tool_name: 'Bash',
        args: { command: 'ls' },
        assistant_message_id: 'msg_1',
      },
    });
    expect(parsed.step).toBe(2);
  });

  it('tool_denied requires rule_id and reason', () => {
    const result = ToolDeniedRecordSchema.safeParse({
      type: 'tool_denied',
      seq: 1,
      time: 1,
      turn_id: 't1',
      step: 2,
      data: {
        tool_call_id: 'tc_1',
        tool_name: 'Bash',
        // missing rule_id
        reason: 'not allowed',
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('management-class records (Slice 4/7/8 scope, schema only for Slice 1)', () => {
  it('skill_invoked parses a canonical row', () => {
    const parsed = SkillInvokedRecordSchema.parse({
      type: 'skill_invoked',
      seq: 1,
      time: 1,
      turn_id: 't1',
      agent_type: 'main',
      data: {
        skill_name: 'do-foo',
        execution_mode: 'inline',
        original_input: 'do the foo thing',
      },
    });
    expect(parsed.data.skill_name).toBe('do-foo');
  });

  it('skill_completed parses with success + optional error', () => {
    const parsed = SkillCompletedRecordSchema.parse({
      type: 'skill_completed',
      seq: 1,
      time: 1,
      turn_id: 't1',
      data: {
        skill_name: 'do-foo',
        execution_mode: 'fork',
        success: false,
        error: 'boom',
        sub_agent_id: 'sub_1',
      },
    });
    expect(parsed.data.success).toBe(false);
  });

  // ── Slice 7.1 (决策 #99) — invocation_trigger / query_depth ────────────

  it('skill_invoked accepts invocation_trigger + query_depth (Phase 7)', () => {
    const parsed = SkillInvokedRecordSchema.parse({
      type: 'skill_invoked',
      seq: 1,
      time: 1,
      turn_id: 't1',
      agent_type: 'main',
      data: {
        skill_name: 'do-foo',
        execution_mode: 'inline',
        original_input: 'args',
        invocation_trigger: 'claude-proactive',
        query_depth: 2,
      },
    });
    const d = parsed.data as unknown as {
      invocation_trigger?: string;
      query_depth?: number;
    };
    expect(d.invocation_trigger).toBe('claude-proactive');
    expect(d.query_depth).toBe(2);
  });

  it('skill_invoked rejects unknown invocation_trigger values', () => {
    const result = SkillInvokedRecordSchema.safeParse({
      type: 'skill_invoked',
      seq: 1,
      time: 1,
      turn_id: 't1',
      data: {
        skill_name: 'x',
        execution_mode: 'inline',
        original_input: '',
        invocation_trigger: 'bogus-trigger',
      },
    });
    expect(result.success).toBe(false);
  });

  it('skill_invoked accepts the three canonical invocation_trigger values', () => {
    for (const trigger of ['user-slash', 'claude-proactive', 'nested-skill'] as const) {
      const r = SkillInvokedRecordSchema.safeParse({
        type: 'skill_invoked',
        seq: 1,
        time: 1,
        turn_id: 't1',
        data: {
          skill_name: 's',
          execution_mode: 'inline',
          original_input: '',
          invocation_trigger: trigger,
        },
      });
      expect(r.success).toBe(true);
    }
  });

  it('skill_completed accepts invocation_trigger + query_depth (Phase 7)', () => {
    const parsed = SkillCompletedRecordSchema.parse({
      type: 'skill_completed',
      seq: 1,
      time: 1,
      turn_id: 't1',
      data: {
        skill_name: 'do-foo',
        execution_mode: 'inline',
        success: true,
        invocation_trigger: 'nested-skill',
        query_depth: 3,
      },
    });
    const d = parsed.data as unknown as {
      invocation_trigger?: string;
      query_depth?: number;
    };
    expect(d.invocation_trigger).toBe('nested-skill');
    expect(d.query_depth).toBe(3);
  });

  it('approval_request carries ApprovalDisplay + ApprovalSource', () => {
    const parsed = ApprovalRequestRecordSchema.parse({
      type: 'approval_request',
      seq: 1,
      time: 1,
      turn_id: 't1',
      step: 2,
      data: {
        request_id: 'req_1',
        tool_call_id: 'tc_1',
        tool_name: 'Bash',
        action: 'run_command',
        display: { kind: 'command', command: 'ls' },
        source: { kind: 'soul', agent_id: 'main' },
      },
    });
    expect(parsed.data.display.kind).toBe('command');
    expect(parsed.data.source.kind).toBe('soul');
  });

  it('approval_response carries the enum response + optional feedback', () => {
    const parsed = ApprovalResponseRecordSchema.parse({
      type: 'approval_response',
      seq: 2,
      time: 1,
      turn_id: 't1',
      step: 2,
      data: {
        request_id: 'req_1',
        response: 'rejected',
        feedback: 'nope',
      },
    });
    expect(parsed.data.response).toBe('rejected');
  });

  it('team_mail parses from_agent + to_agent + content', () => {
    const parsed = TeamMailRecordSchema.parse({
      type: 'team_mail',
      seq: 1,
      time: 1,
      data: {
        mail_id: 'm_1',
        from_agent: 'alice',
        to_agent: 'bob',
        content: 'please review',
        summary: 'review request',
      },
    });
    expect(parsed.data.from_agent).toBe('alice');
  });

  // ── Slice 7.2 (决策 #100) — ApprovalSource mcp branch ─────────────────

  it('ApprovalSource accepts the mcp branch with server_id + reason', () => {
    for (const reason of ['elicitation', 'auth', 'tool_call'] as const) {
      const parsed = ApprovalSourceSchema.parse({
        kind: 'mcp',
        server_id: 'playwright',
        reason,
      });
      expect(parsed.kind).toBe('mcp');
      const narrow = parsed as unknown as { kind: string; server_id: string; reason: string };
      expect(narrow.server_id).toBe('playwright');
      expect(narrow.reason).toBe(reason);
    }
  });

  it('ApprovalSource mcp branch rejects unknown reason values', () => {
    const result = ApprovalSourceSchema.safeParse({
      kind: 'mcp',
      server_id: 'x',
      reason: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('approval_request record carries an mcp-source approval', () => {
    const parsed = ApprovalRequestRecordSchema.parse({
      type: 'approval_request',
      seq: 10,
      time: 1,
      turn_id: 't1',
      step: 1,
      data: {
        request_id: 'req_mcp',
        tool_call_id: 'tc_mcp',
        tool_name: 'mcp__playwright__click',
        action: 'call_tool',
        display: { kind: 'command', command: 'click #submit' },
        source: { kind: 'mcp', server_id: 'playwright', reason: 'tool_call' },
      },
    });
    const src = parsed.data.source as unknown as { kind: string; server_id: string };
    expect(src.kind).toBe('mcp');
    expect(src.server_id).toBe('playwright');
  });

  it('ownership_changed allows null old_owner', () => {
    const parsed = OwnershipChangedRecordSchema.parse({
      type: 'ownership_changed',
      seq: 1,
      time: 1,
      old_owner: null,
      new_owner: 'alice',
    });
    expect(parsed.old_owner).toBeNull();
  });
});

// ── Subagent lifecycle records (Phase 6 / 决策 #88) ─────────────────────
//
// The old `subagent_event` wrapper (which nested SoulEvent snapshots into the
// parent wire) is gone. The parent wire now only records three lifecycle
// references — `subagent_spawned` / `subagent_completed` / `subagent_failed`.
// Child events are stored independently at
// `sessions/<session>/subagents/<agent_id>/wire.jsonl` and never leak into
// the parent wire. Source-tagged forwarding happens only in the transport
// layer (EventBus), never in persistence.

describe('subagent_spawned record (§3.6.1 / Phase 6)', () => {
  it('parses a canonical spawned record (main agent spawns sub)', () => {
    const parsed = SubagentSpawnedRecordSchema.parse({
      type: 'subagent_spawned',
      seq: 1,
      time: 1712790000000,
      data: {
        agent_id: 'sub_abc',
        agent_name: 'code-reviewer',
        parent_tool_call_id: 'tc_001',
        run_in_background: false,
      },
    });
    expect(parsed.data.agent_id).toBe('sub_abc');
    expect(parsed.data.agent_name).toBe('code-reviewer');
    expect(parsed.data.parent_tool_call_id).toBe('tc_001');
    expect(parsed.data.run_in_background).toBe(false);
    expect(parsed.data.parent_agent_id).toBeUndefined();
  });

  it('agent_name is optional', () => {
    const parsed = SubagentSpawnedRecordSchema.parse({
      type: 'subagent_spawned',
      seq: 2,
      time: 1,
      data: {
        agent_id: 'sub_xyz',
        parent_tool_call_id: 'tc_002',
        run_in_background: true,
      },
    });
    expect(parsed.data.agent_name).toBeUndefined();
    expect(parsed.data.run_in_background).toBe(true);
  });

  it('recursive spawn: parent_agent_id points at the spawning subagent', () => {
    const parsed = SubagentSpawnedRecordSchema.parse({
      type: 'subagent_spawned',
      seq: 3,
      time: 1,
      data: {
        agent_id: 'sub_B',
        parent_tool_call_id: 'tc_inner',
        parent_agent_id: 'sub_A',
        run_in_background: false,
      },
    });
    expect(parsed.data.parent_agent_id).toBe('sub_A');
  });

  it('rejects when run_in_background is missing', () => {
    const result = SubagentSpawnedRecordSchema.safeParse({
      type: 'subagent_spawned',
      seq: 1,
      time: 1,
      data: {
        agent_id: 'sub_1',
        parent_tool_call_id: 'tc_1',
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('subagent_completed record (§3.6.1 / Phase 6)', () => {
  it('parses canonical completed record with usage', () => {
    const parsed = SubagentCompletedRecordSchema.parse({
      type: 'subagent_completed',
      seq: 5,
      time: 1712790000500,
      data: {
        agent_id: 'sub_abc',
        parent_tool_call_id: 'tc_001',
        result_summary: 'Reviewed the diff. Looks good.',
        usage: {
          input: 1200,
          output: 320,
          cache_read: 400,
          cache_write: 0,
        },
      },
    });
    expect(parsed.data.agent_id).toBe('sub_abc');
    expect(parsed.data.result_summary).toMatch(/Reviewed/);
    expect(parsed.data.usage?.input).toBe(1200);
    expect(parsed.data.usage?.output).toBe(320);
  });

  it('usage is optional (terminal path may not have token counts)', () => {
    const parsed = SubagentCompletedRecordSchema.parse({
      type: 'subagent_completed',
      seq: 6,
      time: 1,
      data: {
        agent_id: 'sub_2',
        parent_tool_call_id: 'tc_b',
        result_summary: 'done',
      },
    });
    expect(parsed.data.usage).toBeUndefined();
  });
});

describe('subagent_failed record (§3.6.1 / Phase 6)', () => {
  it('parses canonical failed record', () => {
    const parsed = SubagentFailedRecordSchema.parse({
      type: 'subagent_failed',
      seq: 7,
      time: 1,
      data: {
        agent_id: 'sub_bad',
        parent_tool_call_id: 'tc_c',
        error: 'Subagent was aborted',
      },
    });
    expect(parsed.data.error).toMatch(/aborted/);
    expect(parsed.data.agent_id).toBe('sub_bad');
  });

  it('rejects when error is missing', () => {
    const result = SubagentFailedRecordSchema.safeParse({
      type: 'subagent_failed',
      seq: 7,
      time: 1,
      data: {
        agent_id: 'sub_bad',
        parent_tool_call_id: 'tc_c',
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('legacy subagent_event record is rejected by WireRecordSchema', () => {
  // 决策 #88: the nested subagent_event wrapper is gone. The top-level union
  // must refuse it so a stray legacy record cannot round-trip through the
  // wire layer. Replay handles such a line by dropping to the "unknown
  // record type" path (see replay-subagent.test.ts — skip + warn).
  it('WireRecordSchema rejects type="subagent_event"', () => {
    const result = WireRecordSchema.safeParse({
      type: 'subagent_event',
      seq: 1,
      time: 1,
      agent_id: 'sub_1',
      parent_tool_call_id: 'tc_1',
      sub_event: { type: 'step.begin', index: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe('WireRecordSchema union routes the three new lifecycle types', () => {
  it('parses a subagent_spawned line via the top-level union', () => {
    const parsed = WireRecordSchema.parse({
      type: 'subagent_spawned',
      seq: 1,
      time: 1,
      data: {
        agent_id: 'sub_a',
        parent_tool_call_id: 'tc_1',
        run_in_background: false,
      },
    });
    expect(parsed.type).toBe('subagent_spawned');
  });

  it('parses a subagent_completed line via the top-level union', () => {
    const parsed = WireRecordSchema.parse({
      type: 'subagent_completed',
      seq: 2,
      time: 1,
      data: {
        agent_id: 'sub_a',
        parent_tool_call_id: 'tc_1',
        result_summary: 'done',
      },
    });
    expect(parsed.type).toBe('subagent_completed');
  });

  it('parses a subagent_failed line via the top-level union', () => {
    const parsed = WireRecordSchema.parse({
      type: 'subagent_failed',
      seq: 3,
      time: 1,
      data: {
        agent_id: 'sub_a',
        parent_tool_call_id: 'tc_1',
        error: 'boom',
      },
    });
    expect(parsed.type).toBe('subagent_failed');
  });
});

describe('context_edit record (reserved — schema only)', () => {
  it('parses a rewind operation with to_turn', () => {
    const parsed = ContextEditRecordSchema.parse({
      type: 'context_edit',
      seq: 1,
      time: 1,
      operation: 'rewind',
      to_turn: 5,
    });
    expect(parsed.operation).toBe('rewind');
    expect(parsed.to_turn).toBe(5);
  });
});

describe('WireRecordSchema discriminated union', () => {
  it('routes to the right branch by `type`', () => {
    const parsed = WireRecordSchema.parse({
      type: 'user_message',
      seq: 1,
      time: 1,
      turn_id: 't1',
      content: 'hi',
    });
    expect(parsed.type).toBe('user_message');
  });

  it('rejects a completely unknown record type', () => {
    const result = WireRecordSchema.safeParse({
      type: 'never_heard_of_this',
      seq: 1,
      time: 1,
    });
    expect(result.success).toBe(false);
  });
});
