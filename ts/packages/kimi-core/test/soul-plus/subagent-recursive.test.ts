/**
 * Covers Scenario I for Phase 6 (v2 §3.6.1 / 决策 #88):
 *   Recursive subagent spawning. Subagent A spawns subagent B; the
 *   storage model must keep them flat (not nested) and use
 *   `parent_agent_id` on the `subagent_spawned` record to reconstruct the
 *   lineage.
 *
 * Invariants:
 *   - Every agent (main, A, B) has its OWN `wire.jsonl`. Children live
 *     flat under `sessions/<session>/subagents/<agent_id>/wire.jsonl`
 *     regardless of their parent chain (design: "扁平存储").
 *   - A's wire carries B's `subagent_spawned` record (because A is the
 *     spawning parent).
 *   - The main wire carries only A's `subagent_spawned`; B's is NOT
 *     bubbled up — the main wire stays shallow.
 *   - On B's spawned record, `parent_agent_id === A.agent_id`. On A's
 *     spawned record, `parent_agent_id` is undefined (main is not a
 *     subagent).
 *
 * These tests are red bar — the recursive lineage wiring lands with the
 * Phase 6 implementation.
 */

import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import type { SubagentSpawnedRecord } from '../../src/storage/wire-record.js';

// ── Helpers ──────────────────────────────────────────────────────────

let sessionDir: string;
beforeEach(async () => {
  sessionDir = join(
    tmpdir(),
    `kimi-sub-rec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(sessionDir, { recursive: true });
});
afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readLines(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Simulates a Phase 6 recursive-spawn run by writing the lifecycle records
 * + the expected child wire.jsonl stubs directly. This keeps the test
 * focused on the STORAGE TOPOLOGY (flat layout, parent_agent_id chain)
 * without requiring a fully-wired SoulPlus facade that can do nested
 * runSubagentTurn. The implementer must produce this same topology from
 * the real code path — the assertions below are what must hold either
 * way.
 *
 * If the implementer exposes a higher-level helper that lets these
 * assertions run against the real SoulRegistry, migrate this test to use
 * it — but until then, pinning the topology at this level is what lets us
 * fail fast.
 */
// TODO(Phase 6 follow-up): migrate to real SoulRegistry e2e run, delete this helper.
async function simulateRecursiveRun(args: {
  mainJournal: InMemorySessionJournalImpl;
  aJournal: InMemorySessionJournalImpl;
  bJournal: InMemorySessionJournalImpl;
  parentToolCallIdForA: string;
  parentToolCallIdForB: string;
  agentIdA: string;
  agentIdB: string;
  sessionRoot: string;
}): Promise<void> {
  // The main wire records spawning A only.
  await args.mainJournal.appendSubagentSpawned({
    type: 'subagent_spawned',
    data: {
      agent_id: args.agentIdA,
      agent_name: 'a-agent',
      parent_tool_call_id: args.parentToolCallIdForA,
      run_in_background: false,
    },
  });

  // A's own wire records spawning B (recursive).
  await args.aJournal.appendSubagentSpawned({
    type: 'subagent_spawned',
    data: {
      agent_id: args.agentIdB,
      agent_name: 'b-agent',
      parent_tool_call_id: args.parentToolCallIdForB,
      parent_agent_id: args.agentIdA,
      run_in_background: false,
    },
  });

  // Each agent has its own wire.jsonl on disk under the flat layout.
  const mainMetadata = JSON.stringify({
    type: 'metadata',
    protocol_version: '2.1',
    created_at: 1,
  });
  const makeAssistantLine = (agentId: string, seq: number): string =>
    JSON.stringify({
      type: 'assistant_message',
      seq,
      time: 1,
      turn_id: `t_${agentId}`,
      text: `reply body for ${agentId}`,
      think: null,
      tool_calls: [],
      model: 'test-model',
    });

  const pathA = join(args.sessionRoot, 'subagents', args.agentIdA, 'wire.jsonl');
  const pathB = join(args.sessionRoot, 'subagents', args.agentIdB, 'wire.jsonl');
  await mkdir(join(args.sessionRoot, 'subagents', args.agentIdA), { recursive: true });
  await mkdir(join(args.sessionRoot, 'subagents', args.agentIdB), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(pathA, [mainMetadata, makeAssistantLine(args.agentIdA, 1)].join('\n') + '\n');
  await writeFile(pathB, [mainMetadata, makeAssistantLine(args.agentIdB, 1)].join('\n') + '\n');

  // Both complete successfully.
  await args.aJournal.appendSubagentCompleted({
    type: 'subagent_completed',
    data: {
      agent_id: args.agentIdB,
      parent_tool_call_id: args.parentToolCallIdForB,
      result_summary: 'B done',
    },
  });
  await args.mainJournal.appendSubagentCompleted({
    type: 'subagent_completed',
    data: {
      agent_id: args.agentIdA,
      parent_tool_call_id: args.parentToolCallIdForA,
      result_summary: 'A done',
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Scenario I — recursive subagent flat storage', () => {
  const AGENT_A = 'sub_A';
  const AGENT_B = 'sub_B';
  const TC_A = 'tc_main_spawns_A';
  const TC_B = 'tc_A_spawns_B';

  let mainJournal: InMemorySessionJournalImpl;
  let aJournal: InMemorySessionJournalImpl;
  let bJournal: InMemorySessionJournalImpl;

  beforeEach(async () => {
    mainJournal = new InMemorySessionJournalImpl();
    aJournal = new InMemorySessionJournalImpl();
    bJournal = new InMemorySessionJournalImpl();
    await simulateRecursiveRun({
      mainJournal,
      aJournal,
      bJournal,
      parentToolCallIdForA: TC_A,
      parentToolCallIdForB: TC_B,
      agentIdA: AGENT_A,
      agentIdB: AGENT_B,
      sessionRoot: sessionDir,
    });
  });

  it('each agent has an independent wire.jsonl under the flat subagents/ layout', async () => {
    expect(await pathExists(join(sessionDir, 'subagents', AGENT_A, 'wire.jsonl'))).toBe(true);
    expect(await pathExists(join(sessionDir, 'subagents', AGENT_B, 'wire.jsonl'))).toBe(true);
    // FLAT: B is NOT under subagents/A/subagents/B (that would be the
    // discarded nested layout from the pre-Phase-6 design).
    expect(
      await pathExists(join(sessionDir, 'subagents', AGENT_A, 'subagents', AGENT_B)),
    ).toBe(false);
  });

  it("main wire only carries A's subagent_spawned — B's spawn stays in A's journal", () => {
    const mainTypes = mainJournal.getRecords().map((r) => r.type);
    const mainSpawned = mainJournal.getRecordsByType('subagent_spawned');
    expect(mainSpawned.map((r) => r.data.agent_id)).toEqual([AGENT_A]);
    // Main wire never sees B; bubbling is gone.
    expect(mainTypes).not.toContain('subagent_event');
  });

  it("A's wire carries B's subagent_spawned", () => {
    const aSpawned = aJournal.getRecordsByType('subagent_spawned');
    expect(aSpawned.map((r) => r.data.agent_id)).toEqual([AGENT_B]);
  });

  it("parent_agent_id on B's spawned record points at A.agent_id", () => {
    const aSpawned = aJournal.getRecordsByType('subagent_spawned');
    const bSpawnRecord = aSpawned.find((r) => r.data.agent_id === AGENT_B) as
      | SubagentSpawnedRecord
      | undefined;
    expect(bSpawnRecord).toBeDefined();
    expect(bSpawnRecord!.data.parent_agent_id).toBe(AGENT_A);
  });

  it("A's spawn record (in the main wire) has parent_agent_id === undefined", () => {
    const mainSpawned = mainJournal.getRecordsByType('subagent_spawned');
    const aSpawnRecord = mainSpawned.find((r) => r.data.agent_id === AGENT_A);
    expect(aSpawnRecord).toBeDefined();
    expect(aSpawnRecord!.data.parent_agent_id).toBeUndefined();
  });

  it("each subagent wire.jsonl contains its OWN assistant_message and not the sibling's", async () => {
    const aLines = await readLines(join(sessionDir, 'subagents', AGENT_A, 'wire.jsonl'));
    const bLines = await readLines(join(sessionDir, 'subagents', AGENT_B, 'wire.jsonl'));

    const aAssistants = aLines.filter((r) => r['type'] === 'assistant_message');
    const bAssistants = bLines.filter((r) => r['type'] === 'assistant_message');

    expect(aAssistants).toHaveLength(1);
    expect(bAssistants).toHaveLength(1);
    expect(String((aAssistants[0]!['text'] as string) ?? '')).toContain(AGENT_A);
    expect(String((bAssistants[0]!['text'] as string) ?? '')).toContain(AGENT_B);
  });

  it('no wire.jsonl (main / A / B) carries a `source` field', async () => {
    const aLines = await readLines(join(sessionDir, 'subagents', AGENT_A, 'wire.jsonl'));
    const bLines = await readLines(join(sessionDir, 'subagents', AGENT_B, 'wire.jsonl'));
    for (const r of [...aLines, ...bLines]) {
      expect(r).not.toHaveProperty('source');
      expect(r).not.toHaveProperty('_source');
    }
  });

  it("main wire completes A's lifecycle pair (spawned + completed, no failed)", () => {
    expect(mainJournal.getRecordsByType('subagent_spawned')).toHaveLength(1);
    expect(mainJournal.getRecordsByType('subagent_completed')).toHaveLength(1);
    expect(mainJournal.getRecordsByType('subagent_failed')).toHaveLength(0);
  });

  it("A's wire completes B's lifecycle pair (spawned + completed, no failed)", () => {
    expect(aJournal.getRecordsByType('subagent_spawned')).toHaveLength(1);
    expect(aJournal.getRecordsByType('subagent_completed')).toHaveLength(1);
    expect(aJournal.getRecordsByType('subagent_failed')).toHaveLength(0);
  });
});
