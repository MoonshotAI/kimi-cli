/**
 * Phase 18 F.1 — `SessionManager.rollbackSession(n_turns_back)` 红条。
 *
 * 铁律复核（phase-18 F.1 + 铁律 W1-W3）:
 *   - W1: rollback 破坏性操作，必须在 SoulPlus 空闲态（SessionLifecycleStateMachine
 *     非 `active`）执行；否则报错。Slice 18-3 决策：复用 `compacting` 状态，
 *     不引入新状态。
 *   - W2: wire.jsonl 截断必须原子（写 .tmp → rename）并同时 invalidate
 *     `usageAggregator` 的缓存。
 *   - W3:
 *       - rollback 0 turn → no-op，但 `new_turn_count` 仍然返回当前值。
 *       - rollback > 总 turn 数 → 全清空（new_turn_count=0），session 自身保留。
 *   - 正常 rollback(n)：截断到倒数第 n 个 `turn_begin` 之前的字节；
 *     `new_turn_count` = 原有 turn_count - n（若 n < 总数）。
 *
 * 红色原因（实现前）：
 *   - `SessionManager.rollbackSession` 方法不存在；`mgr.rollbackSession` 会在
 *     类型检查期间报 "Property does not exist"。
 *
 * 并发 / 原子性测试：由于 MemFS-style assertion 较脆弱，
 *   1. atomic rename（写 tmp → rename）放到 `it.todo`，等实现者决定 tmp 扩展名后再写。
 *   2. `usageAggregator.invalidate` 的断言同样标 `it.todo` —— 需要实现者决定
 *      缓存失效的公共钩子（可能是 `SessionManager.invalidateUsage(sessionId)` 也
 *      可能是构造参数）。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathConfig } from '../../src/session/path-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { Runtime } from '../../src/soul/runtime.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createNoopRuntime(): Runtime {
  const kosong = new ScriptedKosongAdapter({ responses: [] });
  return createFakeRuntime({ kosong }).runtime;
}

let tmp: string;
let paths: PathConfig;
let mgr: SessionManager;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kimi-rollback-'));
  paths = new PathConfig({ home: tmp });
  mgr = new SessionManager(paths);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/**
 * Seed a wire.jsonl with `n` turn_begin / turn_end pairs via the
 * public SessionJournal API (so the WAL metadata / seq numbering is
 * realistic; rollback implementers can lean on real seq monotonicity).
 * Session stays closed afterwards so rollback runs against disk.
 */
async function seedSessionWithTurns(sessionId: string, turnCount: number): Promise<void> {
  const created = await mgr.createSession({
    workspaceDir: tmp,
    sessionId,
    runtime: createNoopRuntime(),
    tools: [],
    model: 'test-model',
  });
  for (let i = 1; i <= turnCount; i += 1) {
    await created.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: `turn_${i}`,
      agent_type: 'main',
      user_input: `prompt ${i}`,
      input_kind: 'user',
    });
    await created.sessionJournal.appendTurnEnd({
      type: 'turn_end',
      turn_id: `turn_${i}`,
      agent_type: 'main',
      success: true,
      reason: 'done',
    });
  }
  await created.journalWriter.flush();
  await mgr.closeSession(created.sessionId);
}

async function readTurnBeginCount(sessionId: string): Promise<number> {
  const wirePath = paths.wirePath(sessionId);
  const text = await readFile(wirePath, 'utf-8');
  return text.split('\n').filter((l) => {
    if (l.length === 0) return false;
    try {
      return (JSON.parse(l) as { type?: string }).type === 'turn_begin';
    } catch {
      return false;
    }
  }).length;
}

// ── F.1 cases ─────────────────────────────────────────────────────────

describe('Phase 18 F.1 — SessionManager.rollbackSession', () => {
  it('rollback(1) drops only the most recent turn', async () => {
    const sessionId = 'ses_rollback_1';
    await seedSessionWithTurns(sessionId, 3);
    expect(await readTurnBeginCount(sessionId)).toBe(3);

    const result = await mgr.rollbackSession(sessionId, 1);
    expect(result.new_turn_count).toBe(2);
    expect(await readTurnBeginCount(sessionId)).toBe(2);
  });

  it('rollback(2) drops the last two turns (FIFO from tail)', async () => {
    const sessionId = 'ses_rollback_2';
    await seedSessionWithTurns(sessionId, 5);

    const result = await mgr.rollbackSession(sessionId, 2);
    expect(result.new_turn_count).toBe(3);
    expect(await readTurnBeginCount(sessionId)).toBe(3);
  });

  it('rollback(0) is a no-op — turn count and wire.jsonl byte length unchanged', async () => {
    const sessionId = 'ses_rollback_0';
    await seedSessionWithTurns(sessionId, 2);
    const wirePath = paths.wirePath(sessionId);
    const before = await readFile(wirePath, 'utf-8');

    const result = await mgr.rollbackSession(sessionId, 0);
    expect(result.new_turn_count).toBe(2);

    const after = await readFile(wirePath, 'utf-8');
    expect(after).toBe(before);
  });

  it('rollback(N > total) clears all turns but keeps the session file alive (wire.jsonl metadata header preserved)', async () => {
    const sessionId = 'ses_rollback_big';
    await seedSessionWithTurns(sessionId, 3);

    const result = await mgr.rollbackSession(sessionId, 99);
    expect(result.new_turn_count).toBe(0);

    // wire.jsonl must still exist (session not destroyed); turn_begin
    // count drops to 0. The metadata-header record (seq=0 on write path)
    // is either preserved or deterministically regenerated — we only
    // assert the file is still readable and is empty-of-turn_begin.
    expect(await readTurnBeginCount(sessionId)).toBe(0);
    const text = await readFile(paths.wirePath(sessionId), 'utf-8');
    expect(text.length).toBeGreaterThan(0); // still has at least metadata
  });

  it('rollback on a session with an active turn → throws (lifecycle guard)', async () => {
    // Iron rule W1: SessionLifecycleStateMachine must refuse rollback
    // while state === 'active'. We simulate by keeping the session open
    // and transitioning its lifecycle into `active` before the call.
    const sessionId = 'ses_rollback_busy';
    const created = await mgr.createSession({
      workspaceDir: tmp,
      sessionId,
      runtime: createNoopRuntime(),
      tools: [],
      model: 'test-model',
    });
    await created.sessionJournal.appendTurnBegin({
      type: 'turn_begin',
      turn_id: 'turn_1',
      agent_type: 'main',
      user_input: 'hi',
      input_kind: 'user',
    });
    created.lifecycleStateMachine.transitionTo('active');

    await expect(mgr.rollbackSession(sessionId, 1)).rejects.toThrow(
      /lifecycle|active|idle|rollback/i,
    );

    // Restore to idle-ish so closeSession doesn't crash on the
    // destroying transition.
    // active → compacting → active → destroying is the allowed chain;
    // here we go active → destroying via closeSession which already
    // drives the final transition.
    await mgr.closeSession(sessionId);
  });

  it('rollback on an unknown session id throws "Session not found"', async () => {
    await expect(mgr.rollbackSession('ses_does_not_exist', 1)).rejects.toThrow(/not found|unknown/i);
  });

  it.todo(
    'wire.jsonl truncation is atomic (write .tmp → rename), never leaving a partially-written file',
    // phase-18 §F.1 风险 2 / 铁律 W2: 读 wire.jsonl → 定位截断点 → 写 .tmp →
    // rename。实现者决定 .tmp 后缀命名后再填断言（验证中间态文件不存在 /
    // 崩溃模拟后原文件完好）。
  );

  it.todo(
    'rollback invalidates the cached usageAggregator entry for this session',
    // 铁律 W2。等实现者暴露 invalidate 钩子（可能是 `mgr.invalidateUsage` /
    // 构造时注入的回调）后再写断言。
  );

  it.todo(
    'rollback is serialized against concurrent appendTurn writes (no interleave drops a turn)',
    // phase-18 §F.1 风险 4 / Round 1 Major #1：
    //   场景：rollback(n) 与下一个 turn 的 JournalWriter.append 在同一时刻
    //   到达。rollback 读文件 → 计算 keepUpToLine → atomicWrite 的窗口内，
    //   若一个 `turn_begin` / `turn_end` 已经写完磁盘但 rollback 是按旧快照
    //   计算的 keepUpToLine，rename 会覆盖掉那一行，制造"丢 turn"的幻觉。
    //   withStateLock 目前保证 rollback 之间互斥，但 JournalWriter.append
    //   没有走 state lock。
    //   修法路线：要么给 JournalWriter 也接上 state lock，要么让 rollback
    //   先停掉 wire 写入（`journalWriter.quiesce()` + resume），或者在
    //   rollback 入口先把 lifecycle 推成 `compacting`。
    //   用 it.todo 占位记录该技术债；Slice 18-4 或后续 phase 再解决。
  );
});
