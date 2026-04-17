// Component: SessionJournal (§4.5.6)
// Covers both WiredSessionJournalImpl and InMemorySessionJournalImpl.
// Verifies the management-class write window does NOT touch conversation
// projection memory, only writes wire.jsonl rows via the shared
// JournalWriter.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type LifecycleGate,
  type LifecycleState,
  WiredJournalWriter,
} from '../../src/storage/journal-writer.js';
import {
  InMemorySessionJournalImpl,
  WiredSessionJournalImpl,
} from '../../src/storage/session-journal.js';

class StubGate implements LifecycleGate {
  state: LifecycleState = 'active';
}

async function readWireRecords(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-sj-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('WiredSessionJournalImpl', () => {
  function makeWired(): { journal: WiredSessionJournalImpl; filePath: string } {
    const filePath = join(workDir, 'wire.jsonl');
    const writer = new WiredJournalWriter({
      filePath,
      lifecycle: new StubGate(),
      // Phase 3: management-class records (turn_begin / permission /
      // tool_call_dispatched / tool_denied) are not in FORCE_FLUSH_KINDS,
      // so under the default batched mode they stay in memory until the
      // drain timer fires. Pin this suite to per-record mode to preserve
      // its "append → read back from disk" assertions.
      config: { fsyncMode: 'per-record' },
    });
    return { journal: new WiredSessionJournalImpl(writer), filePath };
  }

  it('writes a turn_begin record', async () => {
    const { journal, filePath } = makeWired();
    await journal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 't1',
      agent_type: 'main',
      input_kind: 'user',
      user_input: 'hi',
    });
    const records = await readWireRecords(filePath);
    const row = records.find((r) => r['type'] === 'turn_begin');
    expect(row).toBeDefined();
    expect(row?.['turn_id']).toBe('t1');
    expect(typeof row?.['seq']).toBe('number');
    expect(typeof row?.['time']).toBe('number');
  });

  it('writes a turn_end record with usage', async () => {
    const { journal, filePath } = makeWired();
    await journal.appendTurnEnd({
      type: 'turn_end',
      turn_id: 't1',
      agent_type: 'main',
      success: true,
      reason: 'done',
      usage: { input_tokens: 30, output_tokens: 10 },
    });
    const records = await readWireRecords(filePath);
    const row = records.find((r) => r['type'] === 'turn_end');
    expect(row).toBeDefined();
    expect((row!['usage'] as Record<string, number>)['output_tokens']).toBe(10);
  });

  // Phase 1 (方案 A): notification records are now written by
  // ContextState.appendNotification, not SessionJournal. Test removed.

  it('writes a permission_mode_changed record with optional turn_id omitted', async () => {
    const { journal, filePath } = makeWired();
    await journal.appendPermissionModeChanged({
      type: 'permission_mode_changed',
      data: { from: 'ask', to: 'auto', reason: 'startup' },
    });
    const records = await readWireRecords(filePath);
    expect(records.some((r) => r['type'] === 'permission_mode_changed')).toBe(true);
  });

  it('writes tool_call_dispatched and tool_denied records', async () => {
    const { journal, filePath } = makeWired();
    await journal.appendToolCallDispatched({
      type: 'tool_call_dispatched',
      turn_id: 't1',
      step: 1,
      data: {
        tool_call_id: 'tc_1',
        tool_name: 'Bash',
        args: { command: 'ls' },
        assistant_message_id: 'msg_1',
      },
    });
    await journal.appendToolDenied({
      type: 'tool_denied',
      turn_id: 't1',
      step: 1,
      data: {
        tool_call_id: 'tc_1',
        tool_name: 'Bash',
        rule_id: 'rule:no-ls',
        reason: 'denied by rule',
      },
    });
    const records = await readWireRecords(filePath);
    const types = records.map((r) => r['type']);
    expect(types).toContain('tool_call_dispatched');
    expect(types).toContain('tool_denied');
  });

  it('allocates monotonic seq across mixed append methods', async () => {
    const { journal } = makeWired();
    // Rely on the fact that the same seq counter underlies
    // ContextState and SessionJournal via the shared JournalWriter.
    // We only check that the file ends up with unique, monotonic
    // seq values.
    await journal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 't1',
      agent_type: 'main',
      input_kind: 'user',
      user_input: 'a',
    });
    await journal.appendTurnEnd({
      type: 'turn_end',
      turn_id: 't1',
      agent_type: 'main',
      success: true,
      reason: 'done',
    });

    const records = await readWireRecords(join(workDir, 'wire.jsonl'));
    const body = records.filter((r) => r['type'] !== 'metadata');
    const seqs = body.map((r) => r['seq'] as number);
    const sorted = seqs.toSorted((a, b) => a - b);
    expect(seqs).toEqual(sorted);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('InMemorySessionJournalImpl', () => {
  it('keeps records in-memory and exposes them for assertion', async () => {
    const journal = new InMemorySessionJournalImpl();
    await journal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 't1',
      agent_type: 'main',
      input_kind: 'user',
      user_input: 'hi',
    });
    await journal.appendTurnEnd({
      type: 'turn_end',
      turn_id: 't1',
      agent_type: 'main',
      success: true,
      reason: 'done',
    });

    const all = journal.getRecords();
    expect(all.length).toBe(2);
    expect(journal.getRecordsByType('turn_begin').length).toBe(1);
    expect(journal.getRecordsByType('turn_end').length).toBe(1);
  });

  it('clear() empties the in-memory buffer', async () => {
    const journal = new InMemorySessionJournalImpl();
    await journal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 't1',
      agent_type: 'main',
      input_kind: 'user',
      user_input: 'hi',
    });
    journal.clear();
    expect(journal.getRecords().length).toBe(0);
  });
});

// ── Subagent lifecycle (Phase 6 / 决策 #88) ─────────────────────────────
//
// The old `appendSubagentEvent` method is gone. Its role — "bubble child
// SoulEvent snapshots up to the parent wire" — is replaced by three
// lifecycle-only methods that match the new `subagent_spawned` /
// `subagent_completed` / `subagent_failed` wire records (§3.6.1 / §4.5.6).
// Child events are written to `sessions/<session>/subagents/<agent_id>/
// wire.jsonl` through an independent JournalWriter — SessionJournal never
// touches them.

describe('SessionJournal — subagent lifecycle methods', () => {
  describe('InMemorySessionJournalImpl', () => {
    it('exposes appendSubagentSpawned / Completed / Failed (method surface)', () => {
      const journal = new InMemorySessionJournalImpl();
      expect(typeof journal.appendSubagentSpawned).toBe('function');
      expect(typeof journal.appendSubagentCompleted).toBe('function');
      expect(typeof journal.appendSubagentFailed).toBe('function');
    });

    it('does NOT expose the legacy appendSubagentEvent method', () => {
      const journal = new InMemorySessionJournalImpl();
      // Bracket access proves runtime removal even if a caller defeated the
      // TypeScript signature with a cast.
      expect(
        (journal as unknown as Record<string, unknown>)['appendSubagentEvent'],
      ).toBeUndefined();
    });

    it('records a subagent_spawned row and exposes it by type', async () => {
      const journal = new InMemorySessionJournalImpl();
      await journal.appendSubagentSpawned({
        type: 'subagent_spawned',
        data: {
          agent_id: 'sub_abc',
          agent_name: 'code-reviewer',
          parent_tool_call_id: 'tc_001',
          run_in_background: false,
        },
      });

      const rows = journal.getRecordsByType('subagent_spawned');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data.agent_id).toBe('sub_abc');
      expect(rows[0]!.data.parent_tool_call_id).toBe('tc_001');
      expect(typeof rows[0]!.seq).toBe('number');
      expect(typeof rows[0]!.time).toBe('number');
    });

    it('records a subagent_completed row (with usage) and exposes it by type', async () => {
      const journal = new InMemorySessionJournalImpl();
      await journal.appendSubagentCompleted({
        type: 'subagent_completed',
        data: {
          agent_id: 'sub_abc',
          parent_tool_call_id: 'tc_001',
          result_summary: 'investigation summary',
          usage: { input: 500, output: 120 },
        },
      });

      const rows = journal.getRecordsByType('subagent_completed');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data.result_summary).toBe('investigation summary');
      expect(rows[0]!.data.usage?.input).toBe(500);
    });

    it('records a subagent_failed row and exposes it by type', async () => {
      const journal = new InMemorySessionJournalImpl();
      await journal.appendSubagentFailed({
        type: 'subagent_failed',
        data: {
          agent_id: 'sub_abc',
          parent_tool_call_id: 'tc_001',
          error: 'Subagent was aborted',
        },
      });

      const rows = journal.getRecordsByType('subagent_failed');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data.error).toMatch(/aborted/);
    });

    it('spawned + completed pair is queryable as distinct record types', async () => {
      const journal = new InMemorySessionJournalImpl();
      await journal.appendSubagentSpawned({
        type: 'subagent_spawned',
        data: {
          agent_id: 'sub_abc',
          parent_tool_call_id: 'tc_001',
          run_in_background: false,
        },
      });
      await journal.appendSubagentCompleted({
        type: 'subagent_completed',
        data: {
          agent_id: 'sub_abc',
          parent_tool_call_id: 'tc_001',
          result_summary: 'done',
        },
      });

      expect(journal.getRecordsByType('subagent_spawned')).toHaveLength(1);
      expect(journal.getRecordsByType('subagent_completed')).toHaveLength(1);
      expect(journal.getRecordsByType('subagent_failed')).toHaveLength(0);
    });
  });

  describe('WiredSessionJournalImpl', () => {
    function makeWired(): { journal: WiredSessionJournalImpl; filePath: string } {
      const filePath = join(workDir, 'wire.jsonl');
      const writer = new WiredJournalWriter({
        filePath,
        lifecycle: new StubGate(),
        config: { fsyncMode: 'per-record' },
      });
      return { journal: new WiredSessionJournalImpl(writer), filePath };
    }

    it('persists a subagent_spawned row to wire.jsonl', async () => {
      const { journal, filePath } = makeWired();
      await journal.appendSubagentSpawned({
        type: 'subagent_spawned',
        data: {
          agent_id: 'sub_abc',
          parent_tool_call_id: 'tc_001',
          run_in_background: false,
        },
      });
      const records = await readWireRecords(filePath);
      const row = records.find((r) => r['type'] === 'subagent_spawned');
      expect(row).toBeDefined();
      expect((row!['data'] as Record<string, unknown>)['agent_id']).toBe('sub_abc');
    });

    it('persists a subagent_completed row to wire.jsonl', async () => {
      const { journal, filePath } = makeWired();
      await journal.appendSubagentCompleted({
        type: 'subagent_completed',
        data: {
          agent_id: 'sub_abc',
          parent_tool_call_id: 'tc_001',
          result_summary: 'ok',
        },
      });
      const records = await readWireRecords(filePath);
      expect(records.some((r) => r['type'] === 'subagent_completed')).toBe(true);
    });

    it('persists a subagent_failed row to wire.jsonl', async () => {
      const { journal, filePath } = makeWired();
      await journal.appendSubagentFailed({
        type: 'subagent_failed',
        data: {
          agent_id: 'sub_abc',
          parent_tool_call_id: 'tc_001',
          error: 'boom',
        },
      });
      const records = await readWireRecords(filePath);
      expect(records.some((r) => r['type'] === 'subagent_failed')).toBe(true);
    });

    it('parent wire NEVER writes subagent_event rows anymore (§3.6.1)', async () => {
      const { journal } = makeWired();
      // The method is gone at the type level; runtime access must also be
      // undefined so a caller that silenced TypeScript cannot revive the
      // legacy nesting pathway.
      expect(
        (journal as unknown as Record<string, unknown>)['appendSubagentEvent'],
      ).toBeUndefined();
    });
  });
});
