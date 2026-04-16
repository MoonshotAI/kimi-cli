/**
 * Slice 4 / Phase 4 — TurnLifecycleTracker 状态容器契约测试（决策 #109）.
 *
 * 从 TurnManager 抽出 turn handle / id counter / currentTurnId /
 * turnLifecycleListeners 所有状态管理职责。0 外部 deps。
 *
 * API:
 *   - allocateTurnId(): string — 单调递增（turn_1, turn_2, ...）
 *   - getCurrentTurnId(): string | undefined
 *   - registerTurn(turnId, controller, promise): void
 *   - completeTurn(turnId): void — 清理 in-flight 条目并把 currentTurnId 置空
 *   - cancelTurn(turnId): Promise<void> — controller.abort + await promise，
 *     promise 内部挂 .catch 防 unhandledRejection
 *   - awaitTurn(turnId): Promise<TurnResult | undefined> — settled 也可再次返回
 *   - addListener(listener): () => void — 返回 unsubscribe
 *   - fireLifecycleEvent(event): void — 同步调；listener 抛错被吃掉
 *
 * 预计 FAIL：`TurnLifecycleTracker` 还不存在（Implementer 阶段创建）。
 */

import { describe, expect, it, vi } from 'vitest';

import { TurnLifecycleTracker } from '../../src/soul-plus/turn-lifecycle-tracker.js';
import type { TurnLifecycleEvent } from '../../src/soul-plus/index.js';

function beginEvent(turnId: string): TurnLifecycleEvent {
  return {
    kind: 'begin',
    turnId,
    userInput: 'hi',
    inputKind: 'user',
    agentType: 'main',
  };
}

describe('TurnLifecycleTracker.allocateTurnId', () => {
  it('allocates strictly monotonic turn_N ids starting at turn_1', () => {
    const tracker = new TurnLifecycleTracker();
    expect(tracker.allocateTurnId()).toBe('turn_1');
    expect(tracker.allocateTurnId()).toBe('turn_2');
    expect(tracker.allocateTurnId()).toBe('turn_3');
  });
});

describe('TurnLifecycleTracker.registerTurn / getCurrentTurnId / completeTurn', () => {
  it('registerTurn updates getCurrentTurnId; completeTurn clears it when ids match', () => {
    const tracker = new TurnLifecycleTracker();
    const turnId = tracker.allocateTurnId();
    const controller = new AbortController();
    tracker.registerTurn(turnId, controller, Promise.resolve(undefined));
    expect(tracker.getCurrentTurnId()).toBe(turnId);
    tracker.completeTurn(turnId);
    expect(tracker.getCurrentTurnId()).toBeUndefined();
  });

  it('completeTurn with a non-current id does not clobber the currentTurnId', () => {
    const tracker = new TurnLifecycleTracker();
    const turnA = tracker.allocateTurnId();
    const controller = new AbortController();
    tracker.registerTurn(turnA, controller, Promise.resolve(undefined));
    expect(tracker.getCurrentTurnId()).toBe(turnA);
    tracker.completeTurn('turn_999');
    // Unknown id → no-op; currentTurnId still points at the live turn.
    expect(tracker.getCurrentTurnId()).toBe(turnA);
  });
});

describe('TurnLifecycleTracker.awaitTurn', () => {
  it('returns the registered promise and remains resolvable after the turn has settled', async () => {
    const tracker = new TurnLifecycleTracker();
    const turnId = tracker.allocateTurnId();
    const controller = new AbortController();
    const promise = Promise.resolve(undefined);
    tracker.registerTurn(turnId, controller, promise);
    await expect(tracker.awaitTurn(turnId)).resolves.toBeUndefined();
    // Second call after the turn has settled still returns a resolved promise.
    await expect(tracker.awaitTurn(turnId)).resolves.toBeUndefined();
  });

  it('returns undefined for an unknown turn_id', async () => {
    const tracker = new TurnLifecycleTracker();
    await expect(tracker.awaitTurn('turn_missing')).resolves.toBeUndefined();
  });
});

describe('TurnLifecycleTracker.cancelTurn', () => {
  it('aborts the controller and awaits the turn promise', async () => {
    const tracker = new TurnLifecycleTracker();
    const turnId = tracker.allocateTurnId();
    const controller = new AbortController();
    let resolvedAfterAbort = false;
    const promise = new Promise<undefined>((resolve) => {
      controller.signal.addEventListener('abort', () => {
        resolvedAfterAbort = true;
        resolve(undefined);
      });
    });
    tracker.registerTurn(turnId, controller, promise);
    await tracker.cancelTurn(turnId);
    expect(controller.signal.aborted).toBe(true);
    expect(resolvedAfterAbort).toBe(true);
  });

  it('swallows turn-promise rejections so cancelTurn never surfaces the underlying error', async () => {
    const tracker = new TurnLifecycleTracker();
    const turnId = tracker.allocateTurnId();
    const controller = new AbortController();
    // Register a promise that rejects after abort. Tracker must attach a
    // `.catch` internally so neither cancelTurn() nor the Node process
    // sees an unhandledRejection.
    const promise = new Promise<undefined>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error('scripted rejection after abort'));
      });
    });
    tracker.registerTurn(turnId, controller, promise);
    await expect(tracker.cancelTurn(turnId)).resolves.toBeUndefined();
  });

  it('cancelTurn on an unknown id is a no-op (resolves without throwing)', async () => {
    const tracker = new TurnLifecycleTracker();
    await expect(tracker.cancelTurn('turn_missing')).resolves.toBeUndefined();
  });
});

describe('TurnLifecycleTracker.addListener / fireLifecycleEvent', () => {
  it('fires events synchronously to all subscribed listeners', () => {
    const tracker = new TurnLifecycleTracker();
    const seenA: TurnLifecycleEvent[] = [];
    const seenB: TurnLifecycleEvent[] = [];
    tracker.addListener((event) => seenA.push(event));
    tracker.addListener((event) => seenB.push(event));
    tracker.fireLifecycleEvent(beginEvent('turn_1'));
    // Synchronous firing: both listeners must have observed the event by
    // the time fireLifecycleEvent returns (no microtask queue hop).
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
  });

  it('isolates listener exceptions — a throwing listener does not break the others', () => {
    const tracker = new TurnLifecycleTracker();
    const seen: TurnLifecycleEvent[] = [];
    tracker.addListener(() => {
      throw new Error('boom');
    });
    tracker.addListener((event) => seen.push(event));
    expect(() => tracker.fireLifecycleEvent(beginEvent('turn_1'))).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('the returned unsubscribe handle stops further event delivery', () => {
    const tracker = new TurnLifecycleTracker();
    const seen: TurnLifecycleEvent[] = [];
    const unsubscribe = tracker.addListener((event) => seen.push(event));
    unsubscribe();
    tracker.fireLifecycleEvent(beginEvent('turn_1'));
    expect(seen).toHaveLength(0);
  });
});
