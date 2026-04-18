/**
 * Phase 18 Section E+F — wire method 注册 + 行为 red-bar 测试。
 *
 * 覆盖点（一条测试 pin 住一个方法）:
 *   E.3  session.getBackgroundTasks   — BPM + SubagentStore 合并输出
 *   E.4  session.stopBackgroundTask   — BPM.stop()
 *   E.5  session.getBackgroundTaskOutput — BPM.getOutput()
 *   F.1  session.rollback             — 在 wire 层桥接 SessionManager.rollbackSession
 *   F.2  session.listSkills           — SkillManager.listInvocableSkills()
 *   F.3  session.activateSkill        — SoulPlus.activateSkill()（inline 模式）
 *
 * 红色原因（实现前）：
 *   - 以上 6 个方法名都 **不在** `WireMethod` 联合类型里 —— 因此 dispatch
 *     走 fallback 路径抛 `Method not found`，wire 层映射成 `error.code = -32601`。
 *   - default-handlers.ts 也没有对应 handler。
 *
 * 策略：
 *   - 用 `requestOn(method as string, ...)` 以字符串形式下发，绕开 WireMethod
 *     编译期 union 检查 —— 测试在「方法注册前」要能正常 compile，运行期再红。
 *   - 每个 case 断言 `response.error?.code !== -32601` + 断言一个关键字段存在；
 *     `it.todo` 负责等实现者决定 response 细节后再补全 schema。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildInitializeRequest,
  buildSessionCreateRequest,
  createTestApproval,
  createWireE2EHarness,
  FakeKosongAdapter,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import type { WireMessage } from '../../src/wire-protocol/types.js';

// ── boot helper（复刻 phase18-a 模式） ──────────────────────────────────

let harness: WireE2EInMemoryHarness | undefined;

async function boot(opts?: { kosong?: FakeKosongAdapter }): Promise<{ sessionId: string }> {
  const approval = createTestApproval({ yolo: true });
  harness = await createWireE2EHarness({
    ...(opts?.kosong !== undefined ? { kosong: opts.kosong } : {}),
    approval,
  });

  const init = buildInitializeRequest();
  await harness.send(init);
  await harness.collectUntilResponse(init.id);

  const create = buildSessionCreateRequest({ model: 'test-model' });
  await harness.send(create);
  const { response } = await harness.collectUntilResponse(create.id);
  const sessionId = (response.data as { session_id: string }).session_id;
  return { sessionId };
}

async function requestOn(method: string, sessionId: string, data: unknown): Promise<WireMessage> {
  if (harness === undefined) throw new Error('harness not booted');
  return harness.request(method, data, { sessionId });
}

afterEach(async () => {
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

// ── E.3 session.getBackgroundTasks ──────────────────────────────────

describe('Phase 18 E.3 — session.getBackgroundTasks', () => {
  it('dispatches (not -32601) and returns `background_tasks` + `agent_instances` arrays', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.getBackgroundTasks', sessionId, {});
    // Method must be registered: not "Method not found".
    expect(resp.error?.code).not.toBe(-32601);
    expect(resp.error).toBeUndefined();

    const data = resp.data as {
      background_tasks?: unknown[];
      agent_instances?: unknown[];
    };
    // Fresh session has no bash/agent background tasks and no subagents.
    expect(Array.isArray(data.background_tasks)).toBe(true);
    expect(data.background_tasks).toHaveLength(0);
    expect(Array.isArray(data.agent_instances)).toBe(true);
    expect(data.agent_instances).toHaveLength(0);
  });
});

// ── E.4 session.stopBackgroundTask ──────────────────────────────────

describe('Phase 18 E.4 — session.stopBackgroundTask', () => {
  it('dispatches; unknown task id surfaces a well-formed error (NOT -32601)', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.stopBackgroundTask', sessionId, {
      task_id: 'bash-deadbeef',
    });
    // The method must be registered — method-not-found means handler
    // not wired.
    expect(resp.error?.code).not.toBe(-32601);
    // Unknown task id is a legit error but must be a handler-level error
    // (e.g. -32000 / custom code), not method-not-found.
    if (resp.error !== undefined) {
      expect(resp.error.message).toMatch(/task|not found|unknown/i);
    }
  });
});

// ── E.5 session.getBackgroundTaskOutput ─────────────────────────────

describe('Phase 18 E.5 — session.getBackgroundTaskOutput', () => {
  it('dispatches for a known (or unknown) task id without -32601', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.getBackgroundTaskOutput', sessionId, {
      task_id: 'bash-deadbeef',
      tail: 50,
    });
    expect(resp.error?.code).not.toBe(-32601);
    // Implementer decision: unknown id returns `{ output: '' }` OR an
    // error — either is acceptable; pin only that the method is wired.
  });

  it.todo('known bash task → returns buffered stdout tail',
    // Once BPM is exposed to the wire harness (currently only the tool
    // factory wires it), seed a task and assert `output`.
  );
});

// ── F.1 session.rollback ────────────────────────────────────────────

describe('Phase 18 F.1 — session.rollback (wire)', () => {
  it('dispatches and returns `new_turn_count`', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.rollback', sessionId, { n_turns_back: 0 });
    expect(resp.error?.code).not.toBe(-32601);
    expect(resp.error).toBeUndefined();

    const data = resp.data as { new_turn_count?: number };
    expect(typeof data.new_turn_count).toBe('number');
    expect(data.new_turn_count).toBeGreaterThanOrEqual(0);
  });

  it.todo(
    'rollback during active turn → wire error (not silent truncation)',
    // Direct SessionManager lifecycle test lives in
    // session-rollback.test.ts; this wire-level case pins the mapping
    // to a stable error code once the handler is wired.
  );
});

// ── F.2 session.listSkills ──────────────────────────────────────────

describe('Phase 18 F.2 — session.listSkills', () => {
  it('dispatches and returns an array (filtered to invocable subset)', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.listSkills', sessionId, {});
    expect(resp.error?.code).not.toBe(-32601);
    expect(resp.error).toBeUndefined();

    const data = resp.data as { skills?: unknown[] };
    expect(Array.isArray(data.skills)).toBe(true);
    // Fresh harness has no SkillManager wired → list is empty.
    expect(data.skills).toHaveLength(0);
  });

  it.todo(
    'a skill with `disable_model_invocation: true` is hidden from session.listSkills',
    // Requires wiring SkillManager into the harness. Direct unit tests
    // for listInvocableSkills already pin the filter; this wire-level
    // case is forward-looking once the harness grows a SkillManager
    // option.
  );
});

// ── F.3 session.activateSkill ───────────────────────────────────────

describe('Phase 18 F.3 — session.activateSkill', () => {
  it('dispatches; unknown skill surfaces a well-formed error (not -32601)', async () => {
    const { sessionId } = await boot();

    const resp = await requestOn('session.activateSkill', sessionId, {
      name: 'not-a-real-skill',
      args: '',
    });
    expect(resp.error?.code).not.toBe(-32601);
    // Either a handler-level error (skill not found) or a session-level
    // error is OK; only method-not-found is a failure.
    if (resp.error !== undefined) {
      expect(resp.error.message).toMatch(/skill|not found|unknown/i);
    }
  });

  it.todo(
    'activating a real skill appends the inline user-message on ContextState',
    // Requires SkillManager wiring in harness. Direct
    // SoulPlus.activateSkill unit test already pins inline mode; the
    // wire-level behavioural test waits on the harness extension.
  );
});
