/**
 * SessionManager — AgentTool wiring tests (Slice 5.3 T1).
 *
 * Red-bar tests that pin the end-to-end behaviour described in
 * agent-tool-wiring-plan.md §4 T1:
 *   1. Without `agentTypeRegistry` → SoulPlus does NOT register `Agent`.
 *   2. With `agentTypeRegistry` → SoulPlus registers `Agent`.
 *   3. With `agentTypeRegistry` → per-session SubagentStore is constructed
 *      (listInstances() returns [] on a fresh session).
 *   4. `resumeSession` with `agentTypeRegistry` → `Agent` is registered.
 *   5. `resumeSession` marks a seeded `status='running'` subagent record
 *      as `'lost'` (v2 §8.2 — NOT `'failed'`; calls out the plan-book
 *      wording drift explicitly).
 *
 * These cases intentionally fail today because `CreateSessionOptions` /
 * `ResumeSessionOptions` do not yet carry `agentTypeRegistry` (gap G1 /
 * G2 / C1) and `cleanupStaleSubagents` currently writes `'failed'`
 * instead of `'lost'` (iron rule 7 / v2 §8.2). See migration-report.md
 * for the mapping.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import {
  AgentTypeRegistry,
  type AgentTypeDefinition,
} from '../../src/soul-plus/agent-type-registry.js';
import { SubagentStore } from '../../src/soul-plus/subagent-store.js';
import type { Runtime } from '../../src/soul/runtime.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

// ── helpers ──────────────────────────────────────────────────────────

function createNoopRuntime(): Runtime {
  const kosong = new ScriptedKosongAdapter({ responses: [] });
  return createFakeRuntime({ kosong }).runtime;
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

function createAgentTypeRegistry(): AgentTypeRegistry {
  const registry = new AgentTypeRegistry();
  registry.register('coder', CODER_DEF);
  return registry;
}

let tmp: string;
let paths: PathConfig;
let mgr: SessionManager;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kimi-sm-subagent-wiring-'));
  paths = new PathConfig({ home: tmp });
  mgr = new SessionManager(paths);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ── T1-1 ─────────────────────────────────────────────────────────────

describe('SessionManager AgentTool wiring (Slice 5.3 T1)', () => {
  it('T1-1: createSession without agentTypeRegistry does NOT register Agent', async () => {
    const managed = await mgr.createSession({
      workspaceDir: tmp,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    const names = managed.soulPlus.getTools().map((t) => t.name);
    expect(names).not.toContain('Agent');
    await mgr.closeSession(managed.sessionId);
  });

  // ── T1-2 ───────────────────────────────────────────────────────────

  it('T1-2: createSession with agentTypeRegistry registers Agent', async () => {
    const registry = createAgentTypeRegistry();
    const managed = await mgr.createSession({
      workspaceDir: tmp,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
      agentTypeRegistry: registry,
    });
    const names = managed.soulPlus.getTools().map((t) => t.name);
    expect(names).toContain('Agent');
    await mgr.closeSession(managed.sessionId);
  });

  // ── T1-3 ───────────────────────────────────────────────────────────

  it('T1-3: createSession with agentTypeRegistry yields an empty SubagentStore', async () => {
    const registry = createAgentTypeRegistry();
    const managed = await mgr.createSession({
      workspaceDir: tmp,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
      agentTypeRegistry: registry,
    });

    // SessionManager constructs the store internally (per D1); we
    // reconstruct the same view over the session dir here to assert
    // it resolves cleanly and returns []. listInstances() is
    // tolerant of a missing subagents/ dir (it returns []), so this
    // also doubles as a safe no-op when the dir was not created.
    const store = new SubagentStore(paths.sessionDir(managed.sessionId));
    const records = await store.listInstances();
    expect(records).toEqual([]);

    await mgr.closeSession(managed.sessionId);
  });

  // ── T1-4 ───────────────────────────────────────────────────────────

  it('T1-4: resumeSession with agentTypeRegistry registers Agent', async () => {
    const registry = createAgentTypeRegistry();
    // Seed a session on disk first.
    const created = await mgr.createSession({
      workspaceDir: tmp,
      sessionId: 'ses_resume_wire',
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    // Ensure wire.jsonl exists (metadata header is only flushed on
    // first append) so resumeSession's replay has something to read.
    await created.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 'turn_seed',
      agent_type: 'main',
      user_input: 'seed',
      input_kind: 'user',
    });
    await created.journalWriter.flush();
    await mgr.closeSession(created.sessionId);

    const resumed = await mgr.resumeSession('ses_resume_wire', {
      runtime: createNoopRuntime(),
      tools: [],
      agentTypeRegistry: registry,
    });
    const names = resumed.soulPlus.getTools().map((t) => t.name);
    expect(names).toContain('Agent');
    await mgr.closeSession(resumed.sessionId);
  });

  // ── T1-5 ───────────────────────────────────────────────────────────

  it(
    "T1-5: resumeSession marks a seeded status='running' subagent record as 'lost' (v2 §8.2)",
    async () => {
      const registry = createAgentTypeRegistry();
      // Seed a session on disk first.
      const created = await mgr.createSession({
        workspaceDir: tmp,
        sessionId: 'ses_stale_subagent',
        runtime: createNoopRuntime(),
        tools: [],
        model: 'test-model',
      });
      // Force a wire.jsonl so replay has a file to open. `user_input`
      // is a string in `TurnBeginRecord` (wire-record.ts); match the
      // shape T1-4 above already uses.
      await created.sessionJournal.appendTurnBegin({
        type: 'turn_begin',
        turn_id: 'turn_seed',
        agent_type: 'main',
        user_input: 'seed',
        input_kind: 'user',
      });
      await mgr.closeSession(created.sessionId);

      // Pre-seed a running subagent record (simulates a crash mid-turn).
      const store = new SubagentStore(paths.sessionDir('ses_stale_subagent'));
      const record = await store.createInstance({
        agentId: 'sub_zombie',
        subagentType: 'coder',
        description: 'pre-crash work',
        parentToolCallId: 'tc_parent',
      });
      await store.updateInstance(record.agent_id, { status: 'running' });

      // Sanity check: seeded as running.
      const beforeResume = await store.listInstances();
      expect(beforeResume).toHaveLength(1);
      expect(beforeResume[0]!.status).toBe('running');

      const resumed = await mgr.resumeSession('ses_stale_subagent', {
        runtime: createNoopRuntime(),
        tools: [],
        agentTypeRegistry: registry,
      });

      // v2 §8.2: status='running' residue is marked **'lost'** (NOT
      // 'failed' — despite plan-book T1-5 wording; v2 wins).
      const afterResume = await store.listInstances();
      expect(afterResume).toHaveLength(1);
      expect(afterResume[0]!.status).toBe('lost');

      await mgr.closeSession(resumed.sessionId);

      // v2 §8.2 also requires `task.lost` NotificationEvent be emitted
      // out-of-band so the UI can surface the zombie. Verify via the
      // durable wire.jsonl (notifications WAL-write through
      // ContextState.appendNotification).
      const wirePath = join(paths.sessionDir('ses_stale_subagent'), 'wire.jsonl');
      const wireLines = (await readFile(wirePath, 'utf-8'))
        .split('\n')
        .filter((line) => line.length > 0);
      const taskLostRecords = wireLines
        .map((line) => JSON.parse(line) as { type?: string; data?: { type?: string; source_id?: string } })
        .filter((r) => r.type === 'notification' && r.data?.type === 'task.lost');
      expect(taskLostRecords).toHaveLength(1);
      expect(taskLostRecords[0]?.data?.source_id).toBe('sub_zombie');
    },
  );
});
