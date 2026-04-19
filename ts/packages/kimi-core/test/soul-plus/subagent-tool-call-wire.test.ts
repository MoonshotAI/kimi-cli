/**
 * Covers R6 (Phase 25 Stage C 结构性断裂的补丁):
 *
 *   Phase 25 Stage C (slice 25c-3) moved the `appendToolCall` write from
 *   Soul's main loop into the orchestrator's `beforeToolCall` hook. Main
 *   agents get their `beforeToolCall` from `Orchestrator.buildBeforeToolCall`;
 *   subagents were left without an equivalent. The symptom: when a subagent
 *   invokes a tool, its `wire.jsonl` contains a `tool_result` row but NO
 *   `tool_call` row, so the replayed `buildMessages` emits an assistant
 *   message with an empty `toolCalls[]` while the next user payload carries
 *   a `role='tool'` item with a `tool_call_id` that references nothing.
 *   Moonshot rejects this with `400 tool_call_id is not found`.
 *
 *   The fix wires a minimal `beforeToolCall` hook into the child
 *   `SoulConfig` that mirrors the orchestrator's atomic write. These tests
 *   pin the observable contract: after a subagent turn that invokes a tool,
 *   the child `wire.jsonl` MUST contain a `tool_call` record whose
 *   `data.tool_call_id` matches the LLM-emitted id.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
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
import type { ChatParams, ChatResponse, KosongAdapter, Runtime } from '../../src/soul/runtime.js';
import type { Tool, ToolCall, ToolResult } from '../../src/soul/types.js';

// ── Test harness ─────────────────────────────────────────────────────

// Agent type definition that lets `Echo` through (parentTools carries an
// `Echo` tool; `allowedTools: ['Echo']` puts it on the child's filtered
// tool set so the scripted kosong can invoke it).
const ECHO_CODER_DEF: AgentTypeDefinition = {
  name: 'coder',
  description: 'Code agent',
  whenToUse: 'For coding',
  systemPromptSuffix: 'You are a coder.',
  allowedTools: ['Echo'],
  excludeTools: ['Agent'],
  defaultModel: null,
};

/**
 * Two-round scripted KosongAdapter:
 *   Round 1 — returns a single `tool_use` toolCall.
 *   Round 2 — returns `end_turn` with no further toolCalls.
 *
 * Mirrors `streaming-kosong-wrapper.test.ts:makeScriptedAdapter` — no
 * onDelta / onToolCallReady side effects needed for R6's plain run-turn
 * path (the `beforeToolCall` hook writes unconditionally whenever
 * turnId/stepNumber/stepUuid are threaded).
 */
function createToolCallingKosong(toolCall: ToolCall): KosongAdapter {
  let round = 0;
  return {
    async chat(_params: ChatParams): Promise<ChatResponse> {
      round += 1;
      if (round === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [toolCall],
          },
          toolCalls: [toolCall],
          stopReason: 'tool_use',
          usage: { input: 10, output: 5 },
          actualModel: 'test-model',
        };
      }
      return {
        message: { role: 'assistant', content: 'done' },
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { input: 5, output: 2 },
        actualModel: 'test-model',
      };
    },
  };
}

function createFakeRuntime(kosong: KosongAdapter): Runtime {
  return { kosong };
}

function echoTool(): Tool {
  return {
    name: 'Echo',
    description: 'Echo back the input',
    inputSchema: z.object({ text: z.string().optional() }),
    execute: async (input): Promise<ToolResult> => ({
      content: String((input as { text?: string }).text ?? ''),
    }),
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
    `kimi-sub-tc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(sessionDir, { recursive: true });
  store = new SubagentStore(sessionDir);
  registry = new AgentTypeRegistry();
  registry.register('coder', ECHO_CODER_DEF);
  parentTools = [echoTool()];
  parentEventBus = new SessionEventBus();
  parentJournal = new InMemorySessionJournalImpl();
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
  vi.restoreAllMocks();
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
    parentSessionId: 'ses_test_parent',
  };
}

function makeRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    parentAgentId: 'agent_main',
    parentToolCallId: 'tc_parent_001',
    agentName: 'coder',
    prompt: 'echo hello please',
    description: 'test subagent',
    ...overrides,
  };
}

// ── R6 — child wire must contain a tool_call record ─────────────────

describe('R6 — subagent writes tool_call WAL row', () => {
  it('child wire.jsonl contains a tool_call record matching the LLM-emitted tool_call_id', async () => {
    const tc: ToolCall = { id: 'call_abc123', name: 'Echo', args: { text: 'hi' } };
    const kosong = createToolCallingKosong(tc);
    const agentId = 'sub_tc_A';

    await runSubagentTurn(
      makeDeps(kosong),
      agentId,
      makeRequest(),
      new AbortController().signal,
    );

    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    const toolCallRecords = lines.filter((r) => r['type'] === 'tool_call');
    expect(toolCallRecords).toHaveLength(1);

    const rec = toolCallRecords[0]!;
    const data = rec['data'] as Record<string, unknown>;
    expect(data['tool_call_id']).toBe('call_abc123');
    expect(data['tool_name']).toBe('Echo');
  });

  it('child wire emits the tool_call BEFORE its matching tool_result (replay-ordering invariant)', async () => {
    const tc: ToolCall = { id: 'call_order_1', name: 'Echo', args: {} };
    const kosong = createToolCallingKosong(tc);
    const agentId = 'sub_tc_B';

    await runSubagentTurn(
      makeDeps(kosong),
      agentId,
      makeRequest(),
      new AbortController().signal,
    );

    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    // `tool_call` stores the id under `data.tool_call_id`; `tool_result`
    // pulls it up to a top-level field per the §4.3 wire schema.
    const callIdx = lines.findIndex(
      (r) =>
        r['type'] === 'tool_call' &&
        (r['data'] as Record<string, unknown> | undefined)?.['tool_call_id'] === 'call_order_1',
    );
    const resultIdx = lines.findIndex(
      (r) => r['type'] === 'tool_result' && r['tool_call_id'] === 'call_order_1',
    );
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeLessThan(resultIdx);
  });

  it('tool_result`s parent_uuid points at the tool_call`s uuid (linkage preserved)', async () => {
    // Regression guard for the Phase 25 Stage C contract: the same wire
    // uuid the `beforeToolCall` hook assigns to the tool_call row must
    // be threaded into the tool_result row via `toolCallByProviderId`.
    const tc: ToolCall = { id: 'call_link_1', name: 'Echo', args: {} };
    const kosong = createToolCallingKosong(tc);
    const agentId = 'sub_tc_C';

    await runSubagentTurn(
      makeDeps(kosong),
      agentId,
      makeRequest(),
      new AbortController().signal,
    );

    const lines = await readLines(join(sessionDir, 'subagents', agentId, 'wire.jsonl'));
    const call = lines.find(
      (r) =>
        r['type'] === 'tool_call' &&
        (r['data'] as Record<string, unknown> | undefined)?.['tool_call_id'] === 'call_link_1',
    );
    const result = lines.find(
      (r) => r['type'] === 'tool_result' && r['tool_call_id'] === 'call_link_1',
    );
    expect(call).toBeDefined();
    expect(result).toBeDefined();
    const callUuid = (call as Record<string, unknown>)['uuid'];
    const resultParent = (result as Record<string, unknown>)['parent_uuid'];
    expect(typeof callUuid).toBe('string');
    expect(resultParent).toBe(callUuid);
  });
});
