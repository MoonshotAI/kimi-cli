/**
 * Phase 18 E.1 — AgentInstanceRecord 持久化 + resume-lost 语义。
 *
 * 铁律复核（v2 §8.2 / phase-18 E.1 / 铁律 U1-U5）：
 *   - U3: 进程重启 → `status='running'` 的 record 统一改 `'lost'`（不是 `'failed'`）。
 *   - `completed` / `failed` / `killed` / `lost` 的历史 record 禁止被改写。
 *   - `task.lost` NotificationEvent 按 agent 去重（dedupe_key 拼 sessionId + agentId），
 *     对每个 lost 子 agent 都 emit 一次。
 *
 * 红色原因（实现前）：
 *   - 现有 `cleanupStaleSubagents` 只处理单一 record 的简单路径；T1-5 的
 *     既有测试（session-manager-subagent-wiring.test.ts）只覆盖一个
 *     running record。本文件把多 record 的交叉场景固定下来，以及 **completed
 *     不被误改**、**多条 task.lost 事件都落 wire** 的组合条件。
 *   - `it.todo`: phase-18 风险 4（pid liveness 查活）—— 真实检测 detached 子进程
 *     存活与否的策略仍在讨论，当前实现无条件把所有 running 改 lost；先用 todo
 *     占位，等决策落地再转绿。
 *
 * 命名备注（Slice 18-3 决策）：
 *   - phase-18 todo §E.1 写的是「新建 agent-instance-store.ts」，本 slice
 *     团队决策是复用已有 `SubagentStore`（同类职责已具备 atomic write /
 *     listInstances / updateInstance）。migration-report.md 有说明。
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

// ── Helpers ──────────────────────────────────────────────────────────

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
  tmp = await mkdtemp(join(tmpdir(), 'kimi-resume-lost-'));
  paths = new PathConfig({ home: tmp });
  mgr = new SessionManager(paths);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ── E.1 cases ─────────────────────────────────────────────────────────

describe('Phase 18 E.1 — Subagent resume `running` → `lost` (multi-record)', () => {
  it('multiple running subagents are ALL marked lost on resume (not just the first)', async () => {
    const sessionId = 'ses_multi_lost';
    const created = await mgr.createSession({
      workspaceDir: tmp,
      sessionId,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    // Force wire.jsonl to exist.
    await created.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 'turn_seed',
      agent_type: 'main',
      user_input: 'seed',
      input_kind: 'user',
    });
    await mgr.closeSession(created.sessionId);

    // Seed three running records + one completed + one failed.
    const store = new SubagentStore(paths.sessionDir(sessionId));
    const ids = ['sub_zombie_a', 'sub_zombie_b', 'sub_zombie_c'];
    for (const id of ids) {
      const rec = await store.createInstance({
        agentId: id,
        subagentType: 'coder',
        description: `work ${id}`,
        parentToolCallId: `tc_${id}`,
      });
      await store.updateInstance(rec.agent_id, { status: 'running' });
    }
    const done = await store.createInstance({
      agentId: 'sub_done',
      subagentType: 'coder',
      description: 'old finished job',
      parentToolCallId: 'tc_done',
    });
    await store.updateInstance(done.agent_id, { status: 'completed' });

    const failed = await store.createInstance({
      agentId: 'sub_failed',
      subagentType: 'coder',
      description: 'old failed job',
      parentToolCallId: 'tc_failed',
    });
    await store.updateInstance(failed.agent_id, { status: 'failed' });

    const resumed = await mgr.resumeSession(sessionId, {
      runtime: createNoopRuntime(),
      tools: [],
      agentTypeRegistry: createAgentTypeRegistry(),
    });

    const after = await store.listInstances();
    const byId = new Map(after.map((r) => [r.agent_id, r] as const));

    for (const id of ids) {
      expect(byId.get(id)?.status).toBe('lost');
    }
    // Completed / failed records must NOT be rewritten.
    expect(byId.get('sub_done')?.status).toBe('completed');
    expect(byId.get('sub_failed')?.status).toBe('failed');

    await mgr.closeSession(resumed.sessionId);
  });

  it('emits ONE `task.lost` notification per lost agent (dedupe_key unique per agent)', async () => {
    const sessionId = 'ses_multi_notif';
    const created = await mgr.createSession({
      workspaceDir: tmp,
      sessionId,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    await created.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 'turn_seed',
      agent_type: 'main',
      user_input: 'seed',
      input_kind: 'user',
    });
    await mgr.closeSession(created.sessionId);

    const store = new SubagentStore(paths.sessionDir(sessionId));
    const ids = ['sub_lost_x', 'sub_lost_y'];
    for (const id of ids) {
      const rec = await store.createInstance({
        agentId: id,
        subagentType: 'coder',
        description: `work ${id}`,
        parentToolCallId: `tc_${id}`,
      });
      await store.updateInstance(rec.agent_id, { status: 'running' });
    }

    const resumed = await mgr.resumeSession(sessionId, {
      runtime: createNoopRuntime(),
      tools: [],
      agentTypeRegistry: createAgentTypeRegistry(),
    });
    await mgr.closeSession(resumed.sessionId);

    const wirePath = join(paths.sessionDir(sessionId), 'wire.jsonl');
    const wireLines = (await readFile(wirePath, 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0);
    const taskLost = wireLines
      .map(
        (l) =>
          JSON.parse(l) as {
            type?: string;
            data?: { type?: string; source_id?: string; dedupe_key?: string };
          },
      )
      .filter((r) => r.type === 'notification' && r.data?.type === 'task.lost');

    expect(taskLost.map((r) => r.data?.source_id).sort()).toEqual([...ids].sort());
    // Dedupe-key must be session-scoped + agent-scoped so re-resumes don't
    // spam new events.
    for (const rec of taskLost) {
      expect(rec.data?.dedupe_key).toMatch(new RegExp(`^task\\.lost:${sessionId}:sub_lost_[xy]$`));
    }
  });

  it('resume without any running record is a silent no-op (no task.lost spam)', async () => {
    const sessionId = 'ses_clean_resume';
    const created = await mgr.createSession({
      workspaceDir: tmp,
      sessionId,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    await created.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 'turn_seed',
      agent_type: 'main',
      user_input: 'seed',
      input_kind: 'user',
    });
    await mgr.closeSession(created.sessionId);

    // Seed ONLY a completed record — no zombies.
    const store = new SubagentStore(paths.sessionDir(sessionId));
    const rec = await store.createInstance({
      agentId: 'sub_done_solo',
      subagentType: 'coder',
      description: 'done',
      parentToolCallId: 'tc_done',
    });
    await store.updateInstance(rec.agent_id, { status: 'completed' });

    const resumed = await mgr.resumeSession(sessionId, {
      runtime: createNoopRuntime(),
      tools: [],
      agentTypeRegistry: createAgentTypeRegistry(),
    });
    await mgr.closeSession(resumed.sessionId);

    const after = await store.listInstances();
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('completed');

    const wirePath = join(paths.sessionDir(sessionId), 'wire.jsonl');
    const wireLines = (await readFile(wirePath, 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0);
    const taskLost = wireLines
      .map(
        (l) =>
          JSON.parse(l) as {
            type?: string;
            data?: { type?: string };
          },
      )
      .filter((r) => r.type === 'notification' && r.data?.type === 'task.lost');
    expect(taskLost).toHaveLength(0);
  });

  it.todo(
    'detached subagent process still alive → resume keeps `running` (phase-18 风险 4 pid liveness)',
    // Phase 18 决策日志 2026-04-18: 当前实现无条件把所有 running 改 lost。
    // 风险 4 要求先查 kaos process 存活（或等 IPC 心跳）再改 status，避免把
    // 真正在后台跑的子 agent 误判为丢失。等 liveness 策略定稿再把这条从
    // `it.todo` 转为正式红条。
  );
});
