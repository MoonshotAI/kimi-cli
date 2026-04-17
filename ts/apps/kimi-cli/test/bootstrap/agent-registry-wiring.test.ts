/**
 * App bootstrap smoke test — AgentTool wiring (Slice 5.3 T4).
 *
 * Red bar today: `KimiCoreClientDeps` does not yet accept
 * `agentTypeRegistry` (gap G5 / Change C2.1); typechecking this file
 * fails at the `new KimiCoreClient({...})` call. That is the intended
 * red bar per the Coordinator brief — once C2.1 + C2.2 + C1 land, the
 * test should pass.
 *
 * The test wires a REAL `SessionManager` over a tmpdir and a REAL
 * `AgentTypeRegistry` with a `coder` type, runs `KimiCoreClient.
 * createSession`, then asserts the resulting ManagedSession's
 * `soulPlus.getTools()` contains a tool named `Agent` — proving the
 * end-to-end bootstrap path (app → KimiCoreClient → SessionManager →
 * SoulPlus → AgentTool) is live.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentTypeRegistry,
  PathConfig,
  SessionManager,
  type AgentTypeDefinition,
  type KimiConfig,
  type Runtime,
  type Tool,
} from '@moonshot-ai/core';
import type { Kaos } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KimiCoreClient } from '../../src/wire/kimi-core-client.js';

// Minimal stubs for the host-side deps KimiCoreClient needs beyond
// SessionManager + Runtime.
const fakeKaos = { spawn: vi.fn() } as unknown as Kaos;
const fakeConfig = { hooks: [] } as unknown as KimiConfig;

// ── Minimal Runtime stub (mirrors wire/kimi-core-client.test.ts) ─────

function fakeRuntime(): Runtime {
  return {
    kosong: { chat: vi.fn() },
    compactionProvider: { run: vi.fn() },
    lifecycle: { transitionTo: vi.fn() },
    journal: { rotate: vi.fn() },
  } as unknown as Runtime;
}

const CODER_DEF: AgentTypeDefinition = {
  name: 'coder',
  description: 'Code agent',
  whenToUse: 'For coding tasks',
  systemPromptSuffix: 'You are a coder subagent.',
  allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
  excludeTools: ['Agent'],
  defaultModel: null,
};

let tmp: string;
let sessionManager: SessionManager;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kimi-bootstrap-agent-'));
  sessionManager = new SessionManager(new PathConfig({ home: tmp }));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('App bootstrap wires AgentTool through KimiCoreClient (Slice 5.3 T4)', () => {
  it('createSession registers Agent when agentTypeRegistry is supplied', async () => {
    const agentTypeRegistry = new AgentTypeRegistry();
    agentTypeRegistry.register('coder', CODER_DEF);

    const client = new KimiCoreClient({
      sessionManager,
      runtime: fakeRuntime(),
      model: 'test-model',
      systemPrompt: 'test',
      buildTools: (): Tool[] => [],
      kaos: fakeKaos,
      config: fakeConfig,
      agentTypeRegistry,
    });

    const { session_id } = await client.createSession(tmp);
    const managed = sessionManager.get(session_id);
    if (managed === undefined) {
      throw new Error('ManagedSession must be live after createSession');
    }
    expect(managed).toBeDefined();
    const names = managed.soulPlus.getTools().map((t) => t.name);
    expect(names).toContain('Agent');

    await client.dispose();
  });

  it('createSession omits Agent when agentTypeRegistry is absent', async () => {
    const client = new KimiCoreClient({
      sessionManager,
      runtime: fakeRuntime(),
      model: 'test-model',
      systemPrompt: 'test',
      buildTools: (): Tool[] => [],
      kaos: fakeKaos,
      config: fakeConfig,
    });

    const { session_id } = await client.createSession(tmp);
    const managed = sessionManager.get(session_id);
    expect(managed).toBeDefined();
    const names = managed!.soulPlus.getTools().map((t) => t.name);
    expect(names).not.toContain('Agent');

    await client.dispose();
  });
});
