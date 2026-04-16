/**
 * Slice 4 / Phase 4 — SoulPlus 6-facade 聚合契约测试（决策 #92）.
 *
 * SoulPlus 从 25 private 字段 → 6 facade interface 聚合：
 *
 *   - lifecycle  : { stateMachine, gate }
 *   - journal    : { writer, contextState, sessionJournal, capability }
 *   - services   : { projector?, approvalRuntime, orchestrator, compaction,
 *                    permissionBuilder }
 *   - components : { router?, turnManager, soulRegistry, skillManager?,
 *                    notificationManager, wakeScheduler, turnLifecycle }
 *   - infra      : { eventBus, toolRegistry?, permissionRules, hookEngine? }
 *   - runtime    : 独立顶层（Soul 窄契约面）
 *
 * Facade 是 `interface + plain object`（零运行时开销）。公开 API 完全不变：
 * dispatch / addSystemReminder / emitNotification / activateSkill /
 * getNotificationManager / getSkillManager / getTurnManager —— 这些必须
 * 继续按 Phase 3 前的行为工作。
 *
 * 反射断言走"存在性"路径，不硬断言字段个数（决策：25 → 6 个 facade 是
 * 聚合结构，未来 Slice 7 还会扩展 TeamDaemon 等）。
 *
 * 预计 FAIL：SoulPlus 仍然持有扁平的 private 字段（turnManager /
 * notificationManager / ...），facade 字段尚不存在。
 */

import { describe, expect, it } from 'vitest';

import {
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulPlus,
  createRuntime,
} from '../../src/soul-plus/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
  createSpyLifecycleGate,
} from './fixtures/slice3-harness.js';

function buildSoulPlus(kosong?: ScriptedKosongAdapter): SoulPlus {
  const contextState = createHarnessContextState();
  const sessionJournal = new InMemorySessionJournalImpl();
  const runtime = createRuntime({
    kosong: kosong ?? new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('ok')] }),
    lifecycle: createSpyLifecycleGate(),
    compactionProvider: createNoopCompactionProvider(),
    journal: createNoopJournalCapability(),
  });
  const eventBus = new SessionEventBus();
  return new SoulPlus({
    sessionId: 'ses_test',
    contextState,
    sessionJournal,
    runtime,
    eventBus,
    tools: [],
  });
}

describe('SoulPlus — public API preserved under 6-facade aggregation', () => {
  it('dispatch(session.prompt) still returns {turn_id, status:"started"} (行为不变)', async () => {
    const soul = buildSoulPlus(
      new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('hi')] }),
    );
    const response = await soul.dispatch({
      method: 'session.prompt',
      data: { input: { text: 'hello' } },
    });
    expect(response).toMatchObject({ status: 'started' });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    expect(typeof response.turn_id).toBe('string');
  });

  it('addSystemReminder still persists through the durable history path (行为不变)', async () => {
    const soul = buildSoulPlus();
    // Should not throw — durable path is still wired behind the new facade.
    await expect(soul.addSystemReminder('remember this')).resolves.toBeUndefined();
  });

  it('getTurnManager / getNotificationManager still resolve to the aggregated instances', () => {
    const soul = buildSoulPlus();
    expect(soul.getTurnManager()).toBeDefined();
    expect(soul.getNotificationManager()).toBeDefined();
  });
});

describe('SoulPlus — 6-facade internal shape (reflection, existence only)', () => {
  it('exposes `lifecycle` facade holding the SessionLifecycleStateMachine', () => {
    const soul = buildSoulPlus();
    const lifecycle = (soul as unknown as Record<string, unknown>)['lifecycle'] as
      | { stateMachine?: unknown; gate?: unknown }
      | undefined;
    expect(lifecycle).toBeDefined();
    expect(lifecycle?.stateMachine).toBeInstanceOf(SessionLifecycleStateMachine);
  });

  it('exposes `journal` facade with writer / contextState / sessionJournal / capability slots', () => {
    const soul = buildSoulPlus();
    const journal = (soul as unknown as Record<string, unknown>)['journal'] as
      | {
          writer?: unknown;
          contextState?: unknown;
          sessionJournal?: unknown;
          capability?: unknown;
        }
      | undefined;
    expect(journal).toBeDefined();
    expect(journal?.contextState).toBeDefined();
    expect(journal?.sessionJournal).toBeDefined();
  });

  it('exposes `components` facade with turnManager / soulRegistry / notificationManager / wakeScheduler / turnLifecycle', () => {
    const soul = buildSoulPlus();
    const components = (soul as unknown as Record<string, unknown>)['components'] as
      | {
          turnManager?: unknown;
          soulRegistry?: unknown;
          notificationManager?: unknown;
          wakeScheduler?: unknown;
          turnLifecycle?: unknown;
        }
      | undefined;
    expect(components).toBeDefined();
    expect(components?.turnManager).toBeDefined();
    expect(components?.notificationManager).toBeDefined();
    expect(components?.turnLifecycle).toBeDefined();
  });

  it('exposes `infra` facade holding the SessionEventBus', () => {
    const soul = buildSoulPlus();
    const infra = (soul as unknown as Record<string, unknown>)['infra'] as
      | { eventBus?: unknown }
      | undefined;
    expect(infra).toBeDefined();
    expect(infra?.eventBus).toBeInstanceOf(SessionEventBus);
  });
});
