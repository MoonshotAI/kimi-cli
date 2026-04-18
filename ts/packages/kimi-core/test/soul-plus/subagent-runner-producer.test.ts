/**
 * Phase 22 — subagent wire producer (T5).
 *
 * Subagents share the parent process, so their child `WiredJournalWriter`
 * picks up the same module-level `getProducerInfo()` snapshot — no extra
 * plumbing needed beyond the Step 3 edit (see phase-22 Step 7). This file
 * pins that invariant so regressions in the writer path don't silently
 * skip child headers.
 *
 * Covered behaviours:
 *   T5.1  runSubagentTurn → child subagents/<id>/wire.jsonl's metadata
 *         header carries producer.kind === 'typescript'
 *   T5.2  child producer.version stays in sync with parent (same process)
 *   T5.3  replayWire over the child wire does NOT throw
 *         UnsupportedProducerError (producer hard check passes)
 *
 * Red bar until Step 3 (ensureMetadataInit writes producer) lands — the
 * writer used by subagent-runner is the same WiredJournalWriter.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentTypeRegistry } from '../../src/soul-plus/agent-type-registry.js';
import type { AgentTypeDefinition } from '../../src/soul-plus/agent-type-registry.js';
import { SubagentStore } from '../../src/soul-plus/subagent-store.js';
import { runSubagentTurn } from '../../src/soul-plus/subagent-runner.js';
import type { SubagentRunnerDeps } from '../../src/soul-plus/subagent-runner.js';
import type { SpawnRequest } from '../../src/soul-plus/subagent-types.js';
import {
  _resetProducerInfoForTest,
  setProducerInfo,
} from '../../src/storage/producer-info.js';
import { replayWire } from '../../src/storage/replay.js';
import type { KosongAdapter, Runtime } from '../../src/soul/runtime.js';
import type { Tool, ToolResult } from '../../src/soul/types.js';

function createFakeKosong(responseText: string): KosongAdapter {
  return {
    chat: vi.fn().mockImplementation(async (params: { onDelta?: (d: string) => void }) => {
      if (params.onDelta) params.onDelta(responseText);
      return {
        message: { role: 'assistant' as const, content: responseText },
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage: { input: 10, output: 5 },
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
  tmp = join(tmpdir(), `kimi-runner-producer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
  store = new SubagentStore(tmp);
  registry = new AgentTypeRegistry();
  registry.register('coder', CODER_DEF);
  parentTools = [fakeTool('Bash'), fakeTool('Read'), fakeTool('Write')];
  _resetProducerInfoForTest();
});

afterEach(async () => {
  _resetProducerInfoForTest();
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
  };
}

function makeRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    parentAgentId: 'agent_main',
    parentToolCallId: 'tc_test_001',
    agentName: 'coder',
    prompt: 'do the thing',
    description: 'child',
    ...overrides,
  };
}

describe('subagent wire — producer stamp (T5)', () => {
  it("child wire.jsonl's metadata header carries producer.kind === 'typescript'", async () => {
    setProducerInfo({ version: '0.5.0' });

    const kosong = createFakeKosong('done');
    await runSubagentTurn(
      makeDeps(kosong),
      'sub_child_1',
      makeRequest(),
      new AbortController().signal,
    );

    const childWirePath = join(tmp, 'subagents', 'sub_child_1', 'wire.jsonl');
    const text = await readFile(childWirePath, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(header['type']).toBe('metadata');
    const producer = header['producer'] as Record<string, unknown>;
    expect(producer).toBeDefined();
    expect(producer['kind']).toBe('typescript');
    expect(producer['version']).toBe('0.5.0');
  });

  it('child producer.version mirrors the parent process (same getProducerInfo)', async () => {
    setProducerInfo({ version: '1.1.1' });

    const kosong = createFakeKosong('done');
    await runSubagentTurn(
      makeDeps(kosong),
      'sub_child_2',
      makeRequest(),
      new AbortController().signal,
    );
    const childWirePath = join(tmp, 'subagents', 'sub_child_2', 'wire.jsonl');
    const header = JSON.parse(
      (await readFile(childWirePath, 'utf8')).split('\n')[0]!,
    ) as Record<string, unknown>;
    const producer = header['producer'] as Record<string, unknown>;
    expect(producer['version']).toBe('1.1.1');
  });

  it('replayWire over the child wire passes the producer hard check (no UnsupportedProducerError)', async () => {
    setProducerInfo({ version: '0.5.0' });

    const kosong = createFakeKosong('done');
    await runSubagentTurn(
      makeDeps(kosong),
      'sub_child_3',
      makeRequest(),
      new AbortController().signal,
    );
    const childWirePath = join(tmp, 'subagents', 'sub_child_3', 'wire.jsonl');
    const result = await replayWire(childWirePath, { supportedMajor: 2 });
    expect(result.health).toBe('ok');
    expect(result.producer).toEqual({
      kind: 'typescript',
      name: '@moonshot-ai/core',
      version: '0.5.0',
    });
  });
});
