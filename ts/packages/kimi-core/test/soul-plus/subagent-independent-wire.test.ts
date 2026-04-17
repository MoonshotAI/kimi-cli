/**
 * Covers Scenarios C + D for Phase 6 (决策 #88 / v2 §3.6.1 / §6.5):
 *   C. Child subagent has its OWN wire.jsonl under
 *      `sessions/<session>/subagents/<agent_id>/wire.jsonl`, starting with a
 *      metadata header and containing the child's durable events (assistant
 *      messages, tool results, etc.). No `source` field leaks into that file.
 *   D. Parent wire.jsonl carries ONLY three lifecycle-reference record types
 *      (`subagent_spawned` / `subagent_completed` / `subagent_failed`). It
 *      never contains the old nested `subagent_event` rows and never sees
 *      the child's assistant / content / tool payloads.
 *
 * All tests are red bar — the wiring (independent JournalWriter per
 * subagent, SinkWrapper, SoulRegistry lifecycle records) is not yet in
 * place.
 */

import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentTypeRegistry,
  type AgentTypeDefinition,
} from '../../src/soul-plus/agent-type-registry.js';
import { SessionEventBus } from '../../src/soul-plus/index.js';
import { SubagentStore } from '../../src/soul-plus/subagent-store.js';
import { runSubagentTurn } from '../../src/soul-plus/subagent-runner.js';
import type { SubagentRunnerDeps } from '../../src/soul-plus/subagent-runner.js';
import type { SpawnRequest } from '../../src/soul-plus/subagent-types.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import type { Runtime, KosongAdapter } from '../../src/soul/runtime.js';
import type { Tool, ToolResult } from '../../src/soul/types.js';

// ── Test harness ─────────────────────────────────────────────────────

const CODER_DEF: AgentTypeDefinition = {
  name: 'coder',
  description: 'Code agent',
  whenToUse: 'For coding',
  systemPromptSuffix: 'You are a coder.',
  allowedTools: [],
  excludeTools: ['Agent'],
  defaultModel: null,
};

function createFakeKosong(responseText: string): KosongAdapter {
  return {
    chat: vi.fn().mockImplementation(async (params: { onDelta?: (d: string) => void }) => {
      if (params.onDelta) params.onDelta(responseText);
      return {
        message: { role: 'assistant' as const, content: responseText },
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage: { input: 42, output: 17 },
        actualModel: 'test-model',
      };
    }),
  };
}

function createFailingKosong(): KosongAdapter {
  return {
    chat: vi.fn().mockRejectedValue(new Error('upstream explosion')),
  };
}

function createFakeRuntime(kosong: KosongAdapter): Runtime {
  return { kosong };
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}),
    execute: async (): Promise<ToolResult> => ({ content: '' }),
  };
}

async function readLines(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

let sessionDir: string;
let store: SubagentStore;
let registry: AgentTypeRegistry;
let parentTools: Tool[];
let parentEventBus: SessionEventBus;
let parentJournal: InMemorySessionJournalImpl;

beforeEach(async () => {
  sessionDir = join(
    tmpdir(),
    `kimi-sub-indep-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(sessionDir, { recursive: true });
  store = new SubagentStore(sessionDir);
  registry = new AgentTypeRegistry();
  registry.register('coder', CODER_DEF);
  parentTools = [fakeTool('Read')];
  parentEventBus = new SessionEventBus();
  parentJournal = new InMemorySessionJournalImpl();
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

function makeDeps(kosong: KosongAdapter): SubagentRunnerDeps {
  return {
    store,
    typeRegistry: registry,
    parentTools,
    parentRuntime: createFakeRuntime(kosong),
    parentEventBus,
    parentSessionJournal: parentJournal,
    sessionDir,
    parentModel: 'test-model',
  };
}

function makeRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    parentAgentId: 'agent_main',
    parentToolCallId: 'tc_parent_001',
    agentName: 'coder',
    prompt: 'write a haiku',
    description: 'test subagent',
    ...overrides,
  };
}

// ── C. Child subagent has its own wire.jsonl ─────────────────────────

describe('Scenario C — subagent independent wire.jsonl', () => {
  it('creates sessions/<session>/subagents/<agent_id>/wire.jsonl on spawn', async () => {
    const agentId = 'sub_indep_C1';
    const kosong = createFakeKosong('I wrote a haiku.');
    await runSubagentTurn(makeDeps(kosong), agentId, makeRequest(), new AbortController().signal);

    const childWirePath = join(sessionDir, 'subagents', agentId, 'wire.jsonl');
    expect(await pathExists(childWirePath)).toBe(true);
  });

  it('child wire.jsonl starts with a metadata header record', async () => {
    const agentId = 'sub_indep_C2';
    const kosong = createFakeKosong('ok');
    await runSubagentTurn(makeDeps(kosong), agentId, makeRequest(), new AbortController().signal);

    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const first = lines[0]!;
    expect(first['type']).toBe('metadata');
    expect(typeof first['protocol_version']).toBe('string');
    expect(typeof first['created_at']).toBe('number');
  });

  it("child wire carries the child's assistant_message; parent wire does NOT", async () => {
    const agentId = 'sub_indep_C3';
    const kosong = createFakeKosong('detailed reply body for the child subagent');
    await runSubagentTurn(makeDeps(kosong), agentId, makeRequest(), new AbortController().signal);

    const childLines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    const childTypes = childLines.map((r) => r['type']);
    expect(childTypes).toContain('assistant_message');

    const parentRecords = parentJournal.getRecords();
    const parentTypes = parentRecords.map((r) => r.type);
    expect(parentTypes).not.toContain('assistant_message');
    expect(parentTypes).not.toContain('user_message');
  });

  it('child wire records do NOT contain a `source` field (铁律 5 — source is transport-only)', async () => {
    const agentId = 'sub_indep_C4';
    const kosong = createFakeKosong('another reply for sourceless check');
    await runSubagentTurn(makeDeps(kosong), agentId, makeRequest(), new AbortController().signal);

    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    for (const record of lines) {
      expect(record).not.toHaveProperty('source');
      expect(record).not.toHaveProperty('_source');
      const data = record['data'];
      if (data !== undefined && typeof data === 'object' && data !== null) {
        expect(data as Record<string, unknown>).not.toHaveProperty('source');
        expect(data as Record<string, unknown>).not.toHaveProperty('_source');
      }
    }
  });

  it('two subagents spawned sequentially each get their own independent wire.jsonl', async () => {
    const kosong = createFakeKosong('hi');
    await runSubagentTurn(makeDeps(kosong), 'sub_A', makeRequest(), new AbortController().signal);
    await runSubagentTurn(makeDeps(kosong), 'sub_B', makeRequest(), new AbortController().signal);

    expect(await pathExists(join(sessionDir, 'subagents', 'sub_A', 'wire.jsonl'))).toBe(true);
    expect(await pathExists(join(sessionDir, 'subagents', 'sub_B', 'wire.jsonl'))).toBe(true);
  });
});

// ── D. Parent wire only records lifecycle references ─────────────────

describe('Scenario D — parent wire only carries lifecycle references', () => {
  it('happy path emits subagent_spawned + subagent_completed on the parent journal', async () => {
    const agentId = 'sub_happy';
    const kosong = createFakeKosong('happy path summary');
    await runSubagentTurn(makeDeps(kosong), agentId, makeRequest(), new AbortController().signal);

    const spawned = parentJournal.getRecordsByType('subagent_spawned');
    const completed = parentJournal.getRecordsByType('subagent_completed');
    const failed = parentJournal.getRecordsByType('subagent_failed');

    expect(spawned).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);

    expect(spawned[0]!.data.agent_id).toBe(agentId);
    expect(spawned[0]!.data.parent_tool_call_id).toBe('tc_parent_001');
    expect(spawned[0]!.data.run_in_background).toBe(false);

    expect(completed[0]!.data.agent_id).toBe(agentId);
    expect(completed[0]!.data.parent_tool_call_id).toBe('tc_parent_001');
    expect(typeof completed[0]!.data.result_summary).toBe('string');
  });

  it('lifecycle ordering: subagent_spawned seq < subagent_completed seq', async () => {
    const kosong = createFakeKosong('seq order check');
    await runSubagentTurn(makeDeps(kosong), 'sub_seq', makeRequest(), new AbortController().signal);

    const spawned = parentJournal.getRecordsByType('subagent_spawned');
    const completed = parentJournal.getRecordsByType('subagent_completed');
    expect(spawned[0]!.seq).toBeLessThan(completed[0]!.seq);
  });

  it('error path emits subagent_spawned + subagent_failed — NOT subagent_completed', async () => {
    const kosong = createFailingKosong();
    await expect(
      runSubagentTurn(makeDeps(kosong), 'sub_fail', makeRequest(), new AbortController().signal),
    ).rejects.toBeDefined();

    const spawned = parentJournal.getRecordsByType('subagent_spawned');
    const failed = parentJournal.getRecordsByType('subagent_failed');
    const completed = parentJournal.getRecordsByType('subagent_completed');

    expect(spawned).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(completed).toHaveLength(0);

    expect(failed[0]!.data.agent_id).toBe('sub_fail');
    expect(failed[0]!.data.parent_tool_call_id).toBe('tc_parent_001');
    expect(failed[0]!.data.error.length).toBeGreaterThan(0);
  });

  it('parent wire NEVER carries legacy subagent_event rows', async () => {
    const kosong = createFakeKosong('some child output');
    await runSubagentTurn(makeDeps(kosong), 'sub_no_legacy', makeRequest(), new AbortController().signal);

    const types = parentJournal.getRecords().map((r) => r.type);
    expect(types).not.toContain('subagent_event');
  });

  it('parent wire NEVER carries the subagent child assistant_message / tool_result / content_delta', async () => {
    const kosong = createFakeKosong('child-only payload body');
    await runSubagentTurn(makeDeps(kosong), 'sub_iso', makeRequest(), new AbortController().signal);

    const types = parentJournal.getRecords().map((r) => r.type);
    expect(types).not.toContain('assistant_message');
    expect(types).not.toContain('tool_result');
    // content_delta is an event (not a record type), but for defense
    // against accidental persistence, assert nothing beginning with
    // `content_` reaches the parent journal.
    expect(types.every((t) => !String(t).startsWith('content_'))).toBe(true);
  });

  it('background spawns flag run_in_background=true on the spawned record', async () => {
    const kosong = createFakeKosong('bg');
    await runSubagentTurn(
      makeDeps(kosong),
      'sub_bg',
      makeRequest({ runInBackground: true }),
      new AbortController().signal,
    );
    const spawned = parentJournal.getRecordsByType('subagent_spawned');
    expect(spawned[0]!.data.run_in_background).toBe(true);
  });
});
