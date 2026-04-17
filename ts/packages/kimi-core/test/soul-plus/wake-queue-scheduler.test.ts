/**
 * Slice 4 / Phase 4 — WakeQueueScheduler 契约 + FIFO 不变量测试（决策 #109）.
 *
 * 纯内存 FIFO 队列，0 外部 deps。本 slice 只建基础，Phase 7 TeamDaemon 落
 * 地 auto-wake 时再接入 TurnManager 的启动循环。
 *
 * API:
 *   - enqueue(trigger)
 *   - drain(): TurnTrigger[] — 按 FIFO 顺序返回所有，并清空队列
 *   - isEmpty(): boolean
 *   - peek(): TurnTrigger | undefined — 不消费
 *
 * 预计 FAIL：`WakeQueueScheduler` 还不存在（Implementer 阶段创建）。
 */

import { describe, expect, it } from 'vitest';

import { WakeQueueScheduler } from '../../src/soul-plus/wake-queue-scheduler.js';
import type { TurnTrigger } from '../../src/soul-plus/index.js';
import type { UserInput } from '../../src/storage/context-state.js';

function userTrigger(text: string): TurnTrigger {
  const input: UserInput = { text };
  return { kind: 'user_prompt', input };
}

describe('WakeQueueScheduler', () => {
  it('new scheduler is empty (isEmpty=true, peek=undefined, drain returns [])', () => {
    const scheduler = new WakeQueueScheduler();
    expect(scheduler.isEmpty()).toBe(true);
    expect(scheduler.peek()).toBeUndefined();
    expect(scheduler.drain()).toEqual([]);
  });

  it('enqueue → isEmpty flips to false and peek returns the head without consuming', () => {
    const scheduler = new WakeQueueScheduler();
    const trigger = userTrigger('first');
    scheduler.enqueue(trigger);
    expect(scheduler.isEmpty()).toBe(false);
    expect(scheduler.peek()).toBe(trigger);
    // Peek must be non-destructive: queue still holds the same head.
    expect(scheduler.isEmpty()).toBe(false);
    expect(scheduler.peek()).toBe(trigger);
  });

  it('drain returns triggers in FIFO order and empties the queue', () => {
    const scheduler = new WakeQueueScheduler();
    const a = userTrigger('a');
    const b = userTrigger('b');
    const c = userTrigger('c');
    scheduler.enqueue(a);
    scheduler.enqueue(b);
    scheduler.enqueue(c);
    expect(scheduler.drain()).toEqual([a, b, c]);
    expect(scheduler.isEmpty()).toBe(true);
    expect(scheduler.peek()).toBeUndefined();
  });

  it('drain after drain returns an empty array (idempotent on an empty queue)', () => {
    const scheduler = new WakeQueueScheduler();
    scheduler.enqueue(userTrigger('only'));
    scheduler.drain();
    expect(scheduler.drain()).toEqual([]);
    expect(scheduler.isEmpty()).toBe(true);
  });

  it('accepts system_trigger shape alongside user_prompt', () => {
    const scheduler = new WakeQueueScheduler();
    const userT = userTrigger('user');
    const sysT: TurnTrigger = {
      kind: 'system_trigger',
      input: { text: 'wake' },
      reason: 'auto',
      source: 'timer',
    };
    scheduler.enqueue(userT);
    scheduler.enqueue(sysT);
    const drained = scheduler.drain();
    expect(drained).toEqual([userT, sysT]);
    expect(drained[1]?.kind).toBe('system_trigger');
  });
});
