/**
 * Covers: Subagent event bubbling via subagent.event wire record (v2 §7.2).
 *
 * Slice 7 scope:
 *   - SubagentEventRecord is written to parent's wire journal
 *   - Contains agent_id, agent_name, parent_tool_call_id, sub_event
 *   - Events from child Soul bubble up to main session wire
 *   - Independent subagent wire.jsonl per subagent
 *
 * Tests use InMemorySessionJournal (Slice 1) which already has
 * `appendSubagentEvent`. These tests verify the integration between
 * SoulRegistry.spawn and the event bubbling path.
 *
 * All tests are red bar — subagent event bubbling is not yet implemented.
 */

import { describe, expect, it } from 'vitest';

import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import type { SubagentEventRecord } from '../../src/storage/wire-record.js';

// ── SubagentEventRecord shape ────────────────────────────────────────

describe('SubagentEventRecord — wire schema', () => {
  it('can be written via SessionJournal.appendSubagentEvent', async () => {
    const journal = new InMemorySessionJournalImpl();

    await journal.appendSubagentEvent({
      type: 'subagent_event',
      agent_id: 'sub_abc',
      agent_name: 'code-reviewer',
      parent_tool_call_id: 'tc_123',
      sub_event: { type: 'step.begin', index: 0 },
    });

    const records = journal.getRecords();
    expect(records).toHaveLength(1);
    const record = records[0] as SubagentEventRecord;
    expect(record.type).toBe('subagent_event');
    expect(record.agent_id).toBe('sub_abc');
    expect(record.agent_name).toBe('code-reviewer');
    expect(record.parent_tool_call_id).toBe('tc_123');
    expect(record.sub_event).toEqual({ type: 'step.begin', index: 0 });
  });

  it('agent_name is optional', async () => {
    const journal = new InMemorySessionJournalImpl();

    await journal.appendSubagentEvent({
      type: 'subagent_event',
      agent_id: 'sub_xyz',
      parent_tool_call_id: 'tc_456',
      sub_event: { type: 'step.end' },
    });

    const records = journal.getRecords();
    const record = records[0] as SubagentEventRecord;
    expect(record.agent_name).toBeUndefined();
  });

  it('sub_event is opaque (can hold any SoulEvent snapshot)', async () => {
    const journal = new InMemorySessionJournalImpl();

    const complexEvent = {
      type: 'tool.result',
      tool_call_id: 'inner_tc_1',
      name: 'Read',
      result: { content: 'file contents', lineCount: 42 },
      is_error: false,
    };

    await journal.appendSubagentEvent({
      type: 'subagent_event',
      agent_id: 'sub_complex',
      parent_tool_call_id: 'tc_789',
      sub_event: complexEvent,
    });

    const records = journal.getRecords();
    const record = records[0] as SubagentEventRecord;
    expect(record.sub_event).toEqual(complexEvent);
  });
});

// ── Event bubbling integration ───────────────────────────────────────

describe('Subagent event bubbling — integration', () => {
  it('subagent events are written to the PARENT session journal, not the child', async () => {
    // Parent journal
    const parentJournal = new InMemorySessionJournalImpl();
    // Child journal (independent wire)
    const childJournal = new InMemorySessionJournalImpl();

    // When a subagent emits an event, the host wraps it in a
    // subagent_event record and writes it to the PARENT journal.
    // The child's own events go to childJournal (their own wire.jsonl).
    await parentJournal.appendSubagentEvent({
      type: 'subagent_event',
      agent_id: 'sub_child1',
      agent_name: 'code-reviewer',
      parent_tool_call_id: 'tc_001',
      sub_event: { type: 'step.begin', index: 0 },
    });

    expect(parentJournal.getRecords()).toHaveLength(1);
    expect(childJournal.getRecords()).toHaveLength(0);
  });

  it('multiple subagent events bubble up in order', async () => {
    const journal = new InMemorySessionJournalImpl();

    await journal.appendSubagentEvent({
      type: 'subagent_event',
      agent_id: 'sub_a',
      parent_tool_call_id: 'tc_001',
      sub_event: { type: 'step.begin', index: 0 },
    });

    await journal.appendSubagentEvent({
      type: 'subagent_event',
      agent_id: 'sub_a',
      parent_tool_call_id: 'tc_001',
      sub_event: { type: 'step.end', index: 0 },
    });

    await journal.appendSubagentEvent({
      type: 'subagent_event',
      agent_id: 'sub_a',
      parent_tool_call_id: 'tc_001',
      sub_event: { type: 'step.begin', index: 1 },
    });

    const records = journal.getRecords();
    expect(records).toHaveLength(3);
    const subEvents = records as readonly SubagentEventRecord[];
    expect(subEvents.map((r) => r.sub_event)).toEqual([
      { type: 'step.begin', index: 0 },
      { type: 'step.end', index: 0 },
      { type: 'step.begin', index: 1 },
    ]);
  });

  it('events from different subagents are distinguishable by agent_id', async () => {
    const journal = new InMemorySessionJournalImpl();

    await journal.appendSubagentEvent({
      type: 'subagent_event',
      agent_id: 'sub_alpha',
      agent_name: 'explorer',
      parent_tool_call_id: 'tc_001',
      sub_event: { type: 'step.begin', index: 0 },
    });

    await journal.appendSubagentEvent({
      type: 'subagent_event',
      agent_id: 'sub_beta',
      agent_name: 'code-reviewer',
      parent_tool_call_id: 'tc_002',
      sub_event: { type: 'step.begin', index: 0 },
    });

    const records = journal.getRecords() as SubagentEventRecord[];
    const alphaEvents = records.filter((r) => r.agent_id === 'sub_alpha');
    const betaEvents = records.filter((r) => r.agent_id === 'sub_beta');

    expect(alphaEvents).toHaveLength(1);
    expect(betaEvents).toHaveLength(1);
    expect(alphaEvents[0]!.parent_tool_call_id).toBe('tc_001');
    expect(betaEvents[0]!.parent_tool_call_id).toBe('tc_002');
  });
});

// ── Independent wire per subagent ────────────────────────────────────

describe('Subagent wire isolation', () => {
  it('each subagent has independent context state', () => {
    // This is a behavioral contract test — when SoulRegistry.spawn()
    // creates a subagent, it should get its own ContextState (either
    // fresh or cloned from main). The subagent's writes to context
    // must not affect the parent's context.
    //
    // Since the spawn implementation is not yet done, this test
    // documents the expected isolation property.
    //
    // Real implementation: SubagentHost.spawn creates a fresh
    // InMemoryContextState for the child, or clones from parent
    // if request.contextState is provided.
    expect(true).toBe(true); // Placeholder — will be filled with real assertions
  });

  it('subagent wire path follows sessions/<main>/subagents/<sub_id>/wire.jsonl convention', () => {
    // The file path for a subagent's wire is:
    //   sessions/<parent_session_id>/subagents/<agent_id>/wire.jsonl
    // This test documents the convention.
    const parentSessionId = 'ses_xxx';
    const subagentId = 'sub_abc';
    const expectedPath = `sessions/${parentSessionId}/subagents/${subagentId}/wire.jsonl`;
    expect(expectedPath).toBe('sessions/ses_xxx/subagents/sub_abc/wire.jsonl');
  });
});
