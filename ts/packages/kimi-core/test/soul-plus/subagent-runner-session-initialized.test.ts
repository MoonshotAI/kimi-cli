/**
 * Phase 23 — child (subagent) wire.jsonl session_initialized (T6).
 *
 * Contract under test (spec §Step 7 + §T6):
 *   - After `runSubagentTurn` creates the child JournalWriter, it immediately
 *     appends a `session_initialized` record with `agent_type='sub'` and the
 *     parent blood lineage as its first body line.
 *   - Line 1 is the existing metadata header (Phase 22 producer stamp).
 *   - Line 2 is the new `session_initialized` record.
 *   - Subsequent records (turn_begin, assistant_message, …) append at line 3+.
 *   - Required sub-branch fields: agent_id, parent_session_id,
 *     parent_tool_call_id, run_in_background.
 *   - Optional: agent_name (from request.agentName), parent_agent_id (when
 *     the spawn is itself nested inside a subagent).
 *   - On resume, child wire's session_initialized.agent_type MUST be 'sub'
 *     (main-wire replay path rejects otherwise; see T5.5).
 *
 * Red bar until Phase 23 Step 7 lands (runSubagentTurn writes the record;
 * RunSubagentRequest / SubagentRunnerDeps extended to carry parent_session_id
 * + systemPrompt/model baseline fields).
 *
 * Spec references:
 *   - phase-23-session-initialized.md §Step 7 + §T6 (line 720-726)
 *   - C7 (discriminated union by agent_type)
 *
 * Integration note:
 *   The runner today receives `parentSessionId` nowhere — the spec §Step 7
 *   adds it to `RunSubagentRequest` (extending SpawnRequest or via deps).
 *   These tests thread the value through a light-cast on deps so the test
 *   can compile against today's interface and fail at runtime. The
 *   Implementer will lift the cast once the interface is updated.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentTypeRegistry } from '../../src/soul-plus/agent-type-registry.js';
import type { AgentTypeDefinition } from '../../src/soul-plus/agent-type-registry.js';
import { SessionEventBus } from '../../src/soul-plus/index.js';
import { SubagentStore } from '../../src/soul-plus/subagent-store.js';
import { runSubagentTurn } from '../../src/soul-plus/subagent-runner.js';
import type { SubagentRunnerDeps } from '../../src/soul-plus/subagent-runner.js';
import type { SpawnRequest } from '../../src/soul-plus/subagent-types.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { replayWire } from '../../src/storage/replay.js';
import type { KosongAdapter, Runtime } from '../../src/soul/runtime.js';
import type { Tool, ToolResult } from '../../src/soul/types.js';

// ── fixtures ────────────────────────────────────────────────────────

const CODER_DEF: AgentTypeDefinition = {
  name: 'coder',
  description: 'Code agent',
  whenToUse: 'For coding',
  systemPromptSuffix: 'You are a coder subagent.',
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

let sessionDir: string;
let store: SubagentStore;
let registry: AgentTypeRegistry;
let parentTools: Tool[];
let parentEventBus: SessionEventBus;
let parentJournal: InMemorySessionJournalImpl;

beforeEach(async () => {
  sessionDir = join(
    tmpdir(),
    `kimi-sub-init-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(sessionDir, { recursive: true });
  store = new SubagentStore(sessionDir);
  registry = new AgentTypeRegistry();
  registry.register('coder', CODER_DEF);
  parentTools = [fakeTool('Read'), fakeTool('Grep')];
  parentEventBus = new SessionEventBus();
  parentJournal = new InMemorySessionJournalImpl();
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

// Deps builder — Phase 23 parentSessionId threads into the child
// session_initialized record so the child wire has full blood lineage
// without a cross-process lookup.
function makeDeps(
  kosong: KosongAdapter,
  opts: { parentSessionId: string },
): SubagentRunnerDeps {
  return {
    store,
    typeRegistry: registry,
    parentTools,
    parentRuntime: createFakeRuntime(kosong),
    parentEventBus,
    parentSessionJournal: parentJournal,
    sessionDir,
    parentModel: 'test-model',
    parentSessionId: opts.parentSessionId,
  };
}

function makeRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    parentAgentId: 'agent_main',
    parentToolCallId: 'tc_parent_001',
    agentName: 'coder',
    prompt: 'do coding',
    description: 'sub for T6',
    ...overrides,
  };
}

// ── T6.1 — child wire line 2 is session_initialized with sub lineage ─

describe('Phase 23 T6.1 — child wire line 2 is session_initialized', () => {
  it('writes session_initialized with agent_type="sub" + parent_session_id + parent_tool_call_id', async () => {
    const agentId = 'sub_t6_1';
    const kosong = createFakeKosong('child output');

    await runSubagentTurn(
      makeDeps(kosong, { parentSessionId: 'ses_parent_alpha' }),
      agentId,
      makeRequest({ parentToolCallId: 'tc_abc' }),
      new AbortController().signal,
    );

    const childWire = join(sessionDir, 'subagents', agentId, 'wire.jsonl');
    const lines = await readLines(childWire);

    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]!['type']).toBe('metadata');

    const init = lines[1]!;
    expect(init['type']).toBe('session_initialized');
    expect(init['agent_type']).toBe('sub');
    expect(init['agent_id']).toBe(agentId);
    expect(init['parent_session_id']).toBe('ses_parent_alpha');
    expect(init['parent_tool_call_id']).toBe('tc_abc');
    expect(typeof init['run_in_background']).toBe('boolean');
  });

  it('stamps agent_name from request.agentName when present', async () => {
    const agentId = 'sub_t6_2';
    const kosong = createFakeKosong('ok');
    await runSubagentTurn(
      makeDeps(kosong, { parentSessionId: 'ses_p' }),
      agentId,
      makeRequest({ agentName: 'coder' }),
      new AbortController().signal,
    );
    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    expect(lines[1]!['agent_name']).toBe('coder');
  });

  it('run_in_background=true propagates into session_initialized', async () => {
    const agentId = 'sub_t6_bg';
    const kosong = createFakeKosong('bg');
    await runSubagentTurn(
      makeDeps(kosong, { parentSessionId: 'ses_p' }),
      agentId,
      makeRequest({ runInBackground: true }),
      new AbortController().signal,
    );
    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    expect(lines[1]!['run_in_background']).toBe(true);
  });

  it('threads parent_agent_id when parentAgentId is a real subagent id (nested spawn)', async () => {
    const agentId = 'sub_t6_nested';
    const kosong = createFakeKosong('nested');
    await runSubagentTurn(
      makeDeps(kosong, { parentSessionId: 'ses_root' }),
      agentId,
      makeRequest({ parentAgentId: 'sub_outer_12' }),
      new AbortController().signal,
    );
    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    expect(lines[1]!['parent_agent_id']).toBe('sub_outer_12');
  });

  it('omits parent_agent_id when parentAgentId is the synthetic "agent_main" marker', async () => {
    const agentId = 'sub_t6_root';
    const kosong = createFakeKosong('ok');
    await runSubagentTurn(
      makeDeps(kosong, { parentSessionId: 'ses_p' }),
      agentId,
      makeRequest({ parentAgentId: 'agent_main' }),
      new AbortController().signal,
    );
    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    // 'agent_main' is the sentinel for "I'm spawned by the top-level
    // session, not another subagent" — no parent_agent_id field.
    expect(lines[1]).not.toHaveProperty('parent_agent_id');
  });

  it('carries the child system_prompt / model baseline in session_initialized', async () => {
    const agentId = 'sub_t6_baseline';
    const kosong = createFakeKosong('ok');
    await runSubagentTurn(
      makeDeps(kosong, { parentSessionId: 'ses_p' }),
      agentId,
      makeRequest(),
      new AbortController().signal,
    );
    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    const init = lines[1]!;
    // coder's systemPromptSuffix = "You are a coder subagent." → baseline
    expect(init['system_prompt']).toBe('You are a coder subagent.');
    // Falls back to parentModel ('test-model') when typeDef has no default.
    expect(init['model']).toBe('test-model');
    expect(Array.isArray(init['active_tools'])).toBe(true);
    expect(init['permission_mode']).toBe('default');
    expect(init['plan_mode']).toBe(false);
  });
});

// ── T6.2 — subsequent records append at line 3+ ─────────────────────

describe('Phase 23 T6.2 — child body records land after session_initialized', () => {
  it('assistant_message appears at line 3+, never line 2', async () => {
    const agentId = 'sub_t6_order';
    const kosong = createFakeKosong('reply body');
    await runSubagentTurn(
      makeDeps(kosong, { parentSessionId: 'ses_p' }),
      agentId,
      makeRequest(),
      new AbortController().signal,
    );
    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    expect(lines[0]!['type']).toBe('metadata');
    expect(lines[1]!['type']).toBe('session_initialized');
    const assistant = lines.findIndex((r) => r['type'] === 'assistant_message');
    expect(assistant).toBeGreaterThanOrEqual(2);
  });
});

// ── T6.3 — replayWire over child wire yields sub session_initialized ─

describe('Phase 23 T6.3 — child wire replay surfaces sub session_initialized', () => {
  it('replayWire → result.sessionInitialized.agent_type === "sub" with parent lineage', async () => {
    const agentId = 'sub_t6_replay';
    const kosong = createFakeKosong('ok');
    await runSubagentTurn(
      makeDeps(kosong, { parentSessionId: 'ses_parent_beta' }),
      agentId,
      makeRequest({ parentToolCallId: 'tc_replay' }),
      new AbortController().signal,
    );
    const childWire = join(sessionDir, 'subagents', agentId, 'wire.jsonl');
    const result = await replayWire(childWire, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.sessionInitialized.agent_type).toBe('sub');
    if (result.sessionInitialized.agent_type === 'sub') {
      expect(result.sessionInitialized.agent_id).toBe(agentId);
      expect(result.sessionInitialized.parent_session_id).toBe('ses_parent_beta');
      expect(result.sessionInitialized.parent_tool_call_id).toBe('tc_replay');
    }
  });

  it('records[] does NOT include session_initialized (extracted to its own field)', async () => {
    const agentId = 'sub_t6_not_in_records';
    const kosong = createFakeKosong('ok');
    await runSubagentTurn(
      makeDeps(kosong, { parentSessionId: 'ses_p' }),
      agentId,
      makeRequest(),
      new AbortController().signal,
    );
    const result = await replayWire(
      join(sessionDir, 'subagents', agentId, 'wire.jsonl'),
      { supportedMajor: 2 },
    );
    expect(result.records.every((r) => r.type !== 'session_initialized')).toBe(true);
  });
});

// ── T6.4 — child wire source field isolation (铁律 5) still holds ─

describe('Phase 23 T6.4 — session_initialized on child wire never leaks "source" field', () => {
  it('the session_initialized record does not carry a source envelope', async () => {
    const agentId = 'sub_t6_no_source';
    const kosong = createFakeKosong('ok');
    await runSubagentTurn(
      makeDeps(kosong, { parentSessionId: 'ses_p' }),
      agentId,
      makeRequest(),
      new AbortController().signal,
    );
    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    const init = lines[1]!;
    expect(init).not.toHaveProperty('source');
    expect(init).not.toHaveProperty('_source');
  });
});
