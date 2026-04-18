/**
 * Slice 6.2 — Agent Type Enhancements (red bar tests).
 *
 * Two features:
 *   1. supports_background field on AgentTypeDefinition + AgentTool guard
 *   2. Summary continuation: short subagent replies trigger a follow-up prompt
 *
 * All tests are intentionally failing — implementation comes in the next step.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentTypeRegistry } from '../../src/soul-plus/agent-type-registry.js';
import type { AgentTypeDefinition } from '../../src/soul-plus/agent-type-registry.js';
import { SubagentStore } from '../../src/soul-plus/subagent-store.js';
import { runSubagentTurn } from '../../src/soul-plus/subagent-runner.js';
import type { SubagentRunnerDeps } from '../../src/soul-plus/subagent-runner.js';
import type {
  AgentResult,
  SpawnRequest,
  SubagentHandle,
  SubagentHost,
} from '../../src/soul-plus/subagent-types.js';
import type { Runtime, KosongAdapter } from '../../src/soul/runtime.js';
import type { Tool, ToolResult } from '../../src/soul/types.js';
import { AgentTool } from '../../src/tools/agent.js';
import type { AgentToolInput } from '../../src/tools/agent.js';

// ── Python-parity constants (from PYTHON_REFERENCE_slice_6_2.md) ────

const SUMMARY_MIN_LENGTH = 200;

// ── Fake kosong ──────────────────────────────────────────────────────

function createFakeKosong(responseText: string): KosongAdapter {
  return {
    chat: vi.fn().mockImplementation(async (params: { onDelta?: (d: string) => void }) => {
      if (params.onDelta) {
        params.onDelta(responseText);
      }
      return {
        message: {
          role: 'assistant' as const,
          content: responseText,
        },
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage: { input: 100, output: 50 },
        actualModel: 'test-model',
      };
    }),
  };
}

/**
 * A kosong that returns different responses on successive calls.
 * Call 1 returns responses[0], call 2 returns responses[1], etc.
 */
function createMultiCallKosong(responses: string[]): KosongAdapter {
  let callIndex = 0;
  return {
    chat: vi.fn().mockImplementation(async (params: { onDelta?: (d: string) => void }) => {
      const text = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      if (params.onDelta) {
        params.onDelta(text);
      }
      return {
        message: {
          role: 'assistant' as const,
          content: text,
        },
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage: { input: 100, output: 50 },
        actualModel: 'test-model',
      };
    }),
  };
}

/**
 * A kosong that succeeds on the first call, then throws on the second.
 */
function createFailOnSecondKosong(firstResponse: string): KosongAdapter {
  let callCount = 0;
  return {
    chat: vi.fn().mockImplementation(async (params: { onDelta?: (d: string) => void }) => {
      callCount++;
      if (callCount > 1) {
        throw new Error('continuation LLM error');
      }
      if (params.onDelta) {
        params.onDelta(firstResponse);
      }
      return {
        message: {
          role: 'assistant' as const,
          content: firstResponse,
        },
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage: { input: 100, output: 50 },
        actualModel: 'test-model',
      };
    }),
  };
}

function createFakeRuntime(kosong: KosongAdapter): Runtime {
  // Phase 2: Runtime narrowed to `{kosong}`. Compaction / lifecycle /
  // journal capabilities live on TurnManagerDeps now, not here.
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

// ── Test fixtures ────────────────────────────────────────────────────

const CODER_DEF: AgentTypeDefinition = {
  name: 'coder',
  description: 'Code agent',
  whenToUse: 'For coding',
  systemPromptSuffix: 'You are a coder subagent.',
  allowedTools: ['Bash', 'Read', 'Write'],
  excludeTools: ['Agent'],
  defaultModel: null,
};

let tmp: string;
let store: SubagentStore;
let registry: AgentTypeRegistry;
let parentTools: Tool[];

beforeEach(async () => {
  tmp = join(tmpdir(), `kimi-enhance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
  store = new SubagentStore(tmp);
  registry = new AgentTypeRegistry();
  registry.register('coder', CODER_DEF);
  parentTools = [
    fakeTool('Bash'),
    fakeTool('Read'),
    fakeTool('Write'),
    fakeTool('Edit'),
    fakeTool('Agent'),
  ];
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeDeps(kosong: KosongAdapter): SubagentRunnerDeps {
  return {
    store,
    typeRegistry: registry,
    parentTools,
    parentRuntime: createFakeRuntime(kosong),
    sessionDir: tmp,
    parentModel: 'test-model',
    parentSessionId: 'ses_test_parent',
  };
}

function makeRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    parentAgentId: 'agent_main',
    parentToolCallId: 'tc_test_001',
    agentName: 'coder',
    prompt: 'Write hello world',
    description: 'test subagent',
    ...overrides,
  };
}

// ── Mock host for AgentTool tests ────────────────────────────────────

function makeResult(text: string): AgentResult {
  return { result: text, usage: { input: 100, output: 50 } };
}

interface MockHost extends SubagentHost {
  readonly spawnSpy: ReturnType<typeof vi.fn>;
}

function makeHost(handler?: (req: SpawnRequest) => SubagentHandle): MockHost {
  const defaultHandler = (req: SpawnRequest): SubagentHandle => ({
    agentId: `sub_test_${req.agentName}`,
    parentToolCallId: req.parentToolCallId,
    completion: Promise.resolve(makeResult('done')),
  });
  const fn = handler ?? defaultHandler;
  const spy = vi.fn(async (req: SpawnRequest) => fn(req));
  return { spawn: spy, spawnSpy: spy };
}

// ══════════════════════════════════════════════════════════════════════
// 1. supports_background field
// ══════════════════════════════════════════════════════════════════════

describe('supportsBackground field on AgentTypeDefinition', () => {
  it('AgentTypeDefinition accepts supportsBackground field (defaults to true)', () => {
    // After implementation, AgentTypeDefinition should have a
    // `supportsBackground` field that defaults to `true`.
    const def: AgentTypeDefinition = {
      ...CODER_DEF,
      name: 'bg-test',
    };

    const r = new AgentTypeRegistry();
    r.register('bg-test', def);
    const resolved = r.resolve('bg-test');

    // The field should exist and default to true when not explicitly set.
    // This will fail because the interface does not yet have supportsBackground.
    expect(resolved.supportsBackground).toBe(true);
  });

  it('buildTypeDescriptions includes Background status for each type', () => {
    // After implementation, buildTypeDescriptions() should include
    // "Background: yes" or "Background: no" for each registered type,
    // matching Python's _builtin_type_lines() behavior.
    const r = new AgentTypeRegistry();
    r.register('coder', {
      ...CODER_DEF,
      supportsBackground: true,
    } as AgentTypeDefinition);
    r.register('planner', {
      ...CODER_DEF,
      name: 'planner',
      supportsBackground: false,
    } as AgentTypeDefinition);

    const desc = r.buildTypeDescriptions();

    expect(desc).toContain('Background: yes');
    expect(desc).toContain('Background: no');
  });
});

describe('AgentTool — supportsBackground guard', () => {
  it('returns error when runInBackground=true and type supportsBackground=false', async () => {
    // When the agent type does not support background execution,
    // AgentTool.execute should return an isError result instead of spawning.
    //
    // This requires AgentTool to have access to the type registry (or the
    // host to expose type metadata). The current AgentTool constructor does
    // not accept a type registry — implementation must add this.
    const host = makeHost();

    // Create a registry with a type that disallows background
    const typeRegistry = new AgentTypeRegistry();
    typeRegistry.register('no-bg-agent', {
      ...CODER_DEF,
      name: 'no-bg-agent',
      supportsBackground: false,
    } as AgentTypeDefinition);

    // AgentTool will need access to typeRegistry (new constructor arg or via host)
    const tool = new AgentTool(host, 'agent_main', undefined, typeRegistry as never);
    const signal = new AbortController().signal;

    const result = await tool.execute(
      'tc_bg_block',
      {
        prompt: 'Do work',
        description: 'Should be blocked',
        agentName: 'no-bg-agent',
        runInBackground: true,
      },
      signal,
    );

    // Should get an error result, NOT a successful background spawn
    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not support background');

    // spawn() should NOT have been called
    expect(host.spawnSpy).not.toHaveBeenCalled();
  });

  it('allows background when runInBackground=true and type supportsBackground=true', async () => {
    const host = makeHost();

    const typeRegistry = new AgentTypeRegistry();
    typeRegistry.register('bg-ok', {
      ...CODER_DEF,
      name: 'bg-ok',
      supportsBackground: true,
    } as AgentTypeDefinition);

    const tool = new AgentTool(host, 'agent_main', undefined, typeRegistry as never);
    const signal = new AbortController().signal;

    const result = await tool.execute(
      'tc_bg_ok',
      {
        prompt: 'Do work',
        description: 'Should work',
        agentName: 'bg-ok',
        runInBackground: true,
      },
      signal,
    );

    // Should succeed — no error, spawn was called
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('status: running');
    expect(host.spawnSpy).toHaveBeenCalled();
  });

  it('does not check supportsBackground when runInBackground is false', async () => {
    // Foreground execution should never consult supportsBackground.
    // Even an agent type with supportsBackground=false should work in foreground.
    const host = makeHost();

    const typeRegistry = new AgentTypeRegistry();
    typeRegistry.register('no-bg-agent', {
      ...CODER_DEF,
      name: 'no-bg-agent',
      supportsBackground: false,
    } as AgentTypeDefinition);

    const tool = new AgentTool(host, 'agent_main', undefined, typeRegistry as never);
    const signal = new AbortController().signal;

    const result = await tool.execute(
      'tc_fg',
      {
        prompt: 'Do work in foreground',
        description: 'Foreground task',
        agentName: 'no-bg-agent',
        runInBackground: false,
      },
      signal,
    );

    // Foreground should work fine regardless of supportsBackground
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('done');
    expect(host.spawnSpy).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. Summary continuation
// ══════════════════════════════════════════════════════════════════════

describe('runSubagentTurn — summary continuation', () => {
  it('returns response directly when >= 200 chars (no continuation)', async () => {
    // A response that meets the minimum length should NOT trigger continuation.
    const longResponse = 'A'.repeat(SUMMARY_MIN_LENGTH); // exactly 200 chars
    const kosong = createFakeKosong(longResponse);
    const deps = makeDeps(kosong);
    const request = makeRequest();

    const result = await runSubagentTurn(deps, 'sub_long_001', request, new AbortController().signal);

    // Response should be the original long text
    expect(result.result).toBe(longResponse);

    // kosong.chat should only have been called once (the initial turn)
    expect((kosong.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('triggers continuation when response < 200 chars', async () => {
    // A short response should cause a second kosong.chat call with the
    // continuation prompt.
    const shortResponse = 'Done.'; // way under 200 chars
    const longContinuation = 'B'.repeat(SUMMARY_MIN_LENGTH);

    const kosong = createMultiCallKosong([shortResponse, longContinuation]);
    const deps = makeDeps(kosong);
    const request = makeRequest();

    const result = await runSubagentTurn(deps, 'sub_short_001', request, new AbortController().signal);

    // The final result should be the continuation response (second call)
    expect(result.result).toBe(longContinuation);

    // kosong.chat should have been called twice:
    // 1. Initial turn (short response)
    // 2. Continuation turn
    expect((kosong.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('continuation runs at most 1 time (even if still short)', async () => {
    // Even if the continuation response is also under 200 chars,
    // no further continuation attempts should be made (SUMMARY_CONTINUATION_ATTEMPTS = 1).
    const shortResponse1 = 'Short.';
    const shortResponse2 = 'Still short.';
    const shortResponse3 = 'Never reached.';

    const kosong = createMultiCallKosong([shortResponse1, shortResponse2, shortResponse3]);
    const deps = makeDeps(kosong);
    const request = makeRequest();

    const result = await runSubagentTurn(deps, 'sub_max_001', request, new AbortController().signal);

    // Should get the second response (after one continuation), not the third
    expect(result.result).toBe(shortResponse2);

    // Exactly 2 calls: initial + 1 continuation (no more)
    expect((kosong.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('falls back to first response when continuation fails', async () => {
    // If the continuation LLM call throws, the runner should degrade
    // gracefully and return the first (short) response.
    const shortResponse = 'Brief answer.';

    const kosong = createFailOnSecondKosong(shortResponse);
    const deps = makeDeps(kosong);
    const request = makeRequest();

    const result = await runSubagentTurn(deps, 'sub_fail_001', request, new AbortController().signal);

    // Should fall back to the first response (not throw)
    expect(result.result).toBe(shortResponse);

    // Status should still be completed (not failed)
    const instances = await store.listInstances();
    expect(instances[0]!.status).toBe('completed');
  });
});
