/**
 * E2E: Full foreground subagent flow.
 *
 * Wires AgentTool → SoulRegistry → SubagentRunner → runSoulTurn
 * with a fake kosong to verify the complete spawn→run→result path,
 * including that the store agentId matches the handle agentId (M1 fix).
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SoulRegistry } from '../../src/soul-plus/soul-registry.js';
import { AgentTypeRegistry } from '../../src/soul-plus/agent-type-registry.js';
import { SubagentStore } from '../../src/soul-plus/subagent-store.js';
import { runSubagentTurn } from '../../src/soul-plus/subagent-runner.js';
import { AgentTool } from '../../src/tools/agent.js';
import type { KosongAdapter, Runtime } from '../../src/soul/runtime.js';
import type { Tool, ToolResult } from '../../src/soul/types.js';
import type { SubagentHost } from '../../src/soul-plus/subagent-types.js';

// ── Fake infrastructure ─────────────────────────────────────────────

function createFakeKosong(responseText: string): KosongAdapter {
  return {
    chat: vi.fn().mockImplementation(async (params: { onDelta?: (d: string) => void }) => {
      if (params.onDelta) params.onDelta(responseText);
      return {
        message: { role: 'assistant' as const, content: responseText },
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage: { input: 100, output: 50 },
        actualModel: 'test-model',
      };
    }),
  };
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}),
    execute: async (): Promise<ToolResult> => ({ content: '' }),
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = join(tmpdir(), `kimi-e2e-subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('Foreground subagent E2E', () => {
  it('AgentTool → SoulRegistry → SubagentRunner → result, with consistent agentId', async () => {
    const kosong = createFakeKosong('I found 3 bugs');
    const parentRuntime: Runtime = {
      kosong,
    };

    const store = new SubagentStore(tmp);
    const registry = new AgentTypeRegistry();
    registry.register('coder', {
      name: 'coder',
      description: 'Code agent',
      whenToUse: 'For coding',
      systemPromptSuffix: 'You are a coder.',
      allowedTools: ['Bash', 'Read'],
      excludeTools: ['Agent'],
      defaultModel: null,
    });

    const parentTools = [fakeTool('Bash'), fakeTool('Read'), fakeTool('Agent')];

    // Wire SoulRegistry with real runSubagentTurn callback
    const soulRegistry = new SoulRegistry({
      createHandle: (key, agentDepth) => ({
        key,
        agentId: key === 'main' ? 'agent_main' : key.replace('sub:', ''),
        abortController: new AbortController(),
        agentDepth,
      }),
      runSubagentTurn: (agentId, request, signal) =>
        runSubagentTurn(
          {
            store,
            typeRegistry: registry,
            parentTools,
            parentRuntime,
            sessionDir: tmp,
            parentModel: 'test-model',
          },
          agentId,
          request,
          signal,
        ),
    });

    // Create AgentTool with SoulRegistry as host
    const agentTool = new AgentTool(
      soulRegistry as unknown as SubagentHost,
      'agent_main',
    );

    // Execute foreground spawn
    const result = await agentTool.execute(
      'tc_e2e_001',
      { prompt: 'Find bugs', description: 'Bug hunt', agentName: 'coder' },
      new AbortController().signal,
    );

    // Verify result content
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('I found 3 bugs');
    expect(result.content).toContain('status: completed');

    // Extract agent_id from the tool output
    const agentIdMatch = /agent_id: (\S+)/.exec(result.content as string);
    expect(agentIdMatch).not.toBeNull();
    const reportedAgentId = agentIdMatch![1]!;

    // KEY ASSERTION (M1 fix): The agentId in the tool output matches
    // what's in the SubagentStore
    const instances = await store.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.agent_id).toBe(reportedAgentId);
    expect(instances[0]!.status).toBe('completed');
  });

  it('child tool set is filtered (no Agent tool)', async () => {
    // Track which tools the child kosong sees
    let chatCallTools: string[] = [];
    const kosong: KosongAdapter = {
      chat: vi.fn().mockImplementation(async (params: { tools?: Array<{ name: string }>; onDelta?: (d: string) => void }) => {
        chatCallTools = (params.tools ?? []).map(t => t.name);
        if (params.onDelta) params.onDelta('done');
        return {
          message: { role: 'assistant' as const, content: 'done' },
          toolCalls: [],
          stopReason: 'end_turn' as const,
          usage: { input: 10, output: 5 },
        };
      }),
    };

    const store = new SubagentStore(tmp);
    const registry = new AgentTypeRegistry();
    registry.register('coder', {
      name: 'coder',
      description: 'Code agent',
      whenToUse: 'For coding',
      systemPromptSuffix: '',
      allowedTools: ['Bash', 'Read'],
      excludeTools: ['Agent'],
      defaultModel: null,
    });

    const parentTools = [fakeTool('Bash'), fakeTool('Read'), fakeTool('Agent')];
    const parentRuntime: Runtime = {
      kosong,
    };

    const soulRegistry = new SoulRegistry({
      createHandle: (key, agentDepth) => ({
        key,
        agentId: key === 'main' ? 'agent_main' : key.replace('sub:', ''),
        abortController: new AbortController(),
        agentDepth,
      }),
      runSubagentTurn: (agentId, request, signal) =>
        runSubagentTurn(
          {
            store,
            typeRegistry: registry,
            parentTools,
            parentRuntime,
            sessionDir: tmp,
            parentModel: 'test-model',
          },
          agentId,
          request,
          signal,
        ),
    });

    const agentTool = new AgentTool(soulRegistry as unknown as SubagentHost, 'agent_main');
    await agentTool.execute(
      'tc_filter_001',
      { prompt: 'test', description: 'tool filter test', agentName: 'coder' },
      new AbortController().signal,
    );

    // Child should see Bash + Read but NOT Agent
    expect(chatCallTools).toContain('Bash');
    expect(chatCallTools).toContain('Read');
    expect(chatCallTools).not.toContain('Agent');
  });
});
