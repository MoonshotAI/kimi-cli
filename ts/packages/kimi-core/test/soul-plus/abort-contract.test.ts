/**
 * Slice 4 / Phase 4 — Abort Contract（v2 §7.2 / 决策 #102）.
 *
 * TurnManager.abortTurn(turnId, reason) 必须按标准顺序执行：
 *
 *   1. approvalRuntime.cancelBySource({kind:'turn', turn_id: turnId})
 *      — 同步 void，先取消所有 pending approval waiter
 *   2. orchestrator.discardStreaming?.('aborted')
 *      — Phase 5 将真正丢弃 streaming；Phase 4 只是 no-op placeholder
 *   3. tracker.cancelTurn(turnId)
 *      — 委托 TurnLifecycleTracker 做 abort + await drain
 *
 * 用 `vi.fn().mock.invocationCallOrder` 验证三者严格按此顺序被调。
 *
 * cancelBySource 类型契约（决策 #102）：返回 `void`（同步），不 `Promise<void>`。
 * In-memory waiter 立即 reject + cancel event emit；wire 落盘 / 跨进程撤销
 * 异步追赶。
 *
 * 预计 FAIL：
 *   - TurnManager.abortTurn 方法尚不存在
 *   - TurnManagerDeps.approvalRuntime 字段尚不存在
 *   - orchestrator.discardStreaming 可选方法尚不存在
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  AlwaysAllowApprovalRuntime,
  TurnManager,
  type ApprovalRuntime,
} from '../../src/soul-plus/index.js';
import type { ApprovalSource } from '../../src/storage/wire-record.js';
import { makeTurnManagerDeps } from './fixtures/turn-manager-harness.js';

interface ExtendedTurnManager {
  abortTurn(turnId: string, reason: string): Promise<void>;
}

describe('TurnManager.abortTurn — §7.2 standard order', () => {
  it('calls approvalRuntime.cancelBySource → orchestrator.discardStreaming → tracker.cancelTurn in strict order', async () => {
    const cancelBySource = vi.fn<(source: ApprovalSource) => void>();
    const discardStreaming = vi.fn<(reason: 'aborted' | 'timeout') => void>();
    const cancelTurn = vi.fn(async (_turnId: string) => undefined);

    const approvalRuntime: ApprovalRuntime = {
      async request() {
        return { approved: true };
      },
      async recoverPendingOnStartup() {
        /* no-op */
      },
      resolve: vi.fn(),
      cancelBySource,
      async ingestRemoteRequest() {
        /* no-op */
      },
      resolveRemote: vi.fn(),
    };

    const orchestrator = {
      buildBeforeToolCall: vi.fn(),
      buildAfterToolCall: vi.fn(),
      wrapTools: vi.fn((tools: readonly unknown[]) => [...tools]),
      discardStreaming,
    };

    const h = makeTurnManagerDeps({
      subcomponents: {
        lifecycle: {
          allocateTurnId: vi.fn(() => 'turn_7'),
          getCurrentTurnId: vi.fn(() => 'turn_7'),
          registerTurn: vi.fn(),
          completeTurn: vi.fn(),
          cancelTurn,
          awaitTurn: vi.fn(async () => undefined),
          addListener: vi.fn(() => () => undefined),
          fireLifecycleEvent: vi.fn(),
        },
      },
    });

    // Phase 4: TurnManagerDeps gains `approvalRuntime` and forwards an
    // `orchestrator` with `discardStreaming`. Until the Implementer
    // widens the type, inject via cast.
    const deps = {
      ...h.deps,
      approvalRuntime,
      orchestrator,
    } as unknown as typeof h.deps;

    const manager = new TurnManager(deps);
    const extended = manager as unknown as ExtendedTurnManager;
    await extended.abortTurn('turn_7', 'user-cancel');

    expect(cancelBySource).toHaveBeenCalledTimes(1);
    expect(cancelBySource).toHaveBeenCalledWith({ kind: 'turn', turn_id: 'turn_7' });

    expect(discardStreaming).toHaveBeenCalledTimes(1);
    expect(discardStreaming).toHaveBeenCalledWith('aborted');

    expect(cancelTurn).toHaveBeenCalledWith('turn_7');

    // Strict ordering — invocationCallOrder is a process-global monotonic
    // counter; smaller = called earlier.
    const cancelBySourceOrder = cancelBySource.mock.invocationCallOrder[0];
    const discardStreamingOrder = discardStreaming.mock.invocationCallOrder[0];
    const cancelTurnOrder = cancelTurn.mock.invocationCallOrder[0];
    expect(cancelBySourceOrder).toBeDefined();
    expect(discardStreamingOrder).toBeDefined();
    expect(cancelTurnOrder).toBeDefined();
    expect(cancelBySourceOrder!).toBeLessThan(discardStreamingOrder!);
    expect(discardStreamingOrder!).toBeLessThan(cancelTurnOrder!);
  });

  it('awaits tracker.cancelTurn before resolving (abortTurn returns after drain)', async () => {
    let trackerResolved = false;
    const cancelTurn = vi.fn(async (_turnId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      trackerResolved = true;
    });

    const approvalRuntime = new AlwaysAllowApprovalRuntime();
    const discardStreaming = vi.fn();
    const orchestrator = {
      buildBeforeToolCall: vi.fn(),
      buildAfterToolCall: vi.fn(),
      wrapTools: vi.fn((tools: readonly unknown[]) => [...tools]),
      discardStreaming,
    };

    const h = makeTurnManagerDeps({
      subcomponents: {
        lifecycle: {
          allocateTurnId: vi.fn(() => 'turn_1'),
          getCurrentTurnId: vi.fn(() => 'turn_1'),
          registerTurn: vi.fn(),
          completeTurn: vi.fn(),
          cancelTurn,
          awaitTurn: vi.fn(async () => undefined),
          addListener: vi.fn(() => () => undefined),
          fireLifecycleEvent: vi.fn(),
        },
      },
    });
    const deps = { ...h.deps, approvalRuntime, orchestrator } as unknown as typeof h.deps;
    const manager = new TurnManager(deps);
    const extended = manager as unknown as ExtendedTurnManager;

    const abortPromise = extended.abortTurn('turn_1', 'user-cancel');
    expect(trackerResolved).toBe(false); // drain not complete yet
    await abortPromise;
    expect(trackerResolved).toBe(true); // drain completed before resolve
  });

  it('does not throw when orchestrator is omitted (discardStreaming is optional)', async () => {
    const cancelBySource = vi.fn<(source: ApprovalSource) => void>();
    const approvalRuntime: ApprovalRuntime = {
      async request() {
        return { approved: true };
      },
      async recoverPendingOnStartup() {},
      resolve: vi.fn(),
      cancelBySource,
      async ingestRemoteRequest() {},
      resolveRemote: vi.fn(),
    };
    const h = makeTurnManagerDeps();
    const deps = { ...h.deps, approvalRuntime } as unknown as typeof h.deps;
    const manager = new TurnManager(deps);
    const extended = manager as unknown as ExtendedTurnManager;
    await expect(extended.abortTurn('turn_1', 'user-cancel')).resolves.toBeUndefined();
    expect(cancelBySource).toHaveBeenCalledTimes(1);
  });

  it('ApprovalRuntime.cancelBySource is synchronous void (not Promise) — type-level contract', () => {
    // 决策 #102: cancelBySource 必须是 sync void 语义。只承诺 in-memory
    // waiter 立即 reject + cancel event emit；不承诺 wire.jsonl 落盘 /
    // 跨进程撤销。此测试是 TS 编译单元断言，运行期用 expectTypeOf 落实。
    expectTypeOf<ApprovalRuntime['cancelBySource']>().returns.toEqualTypeOf<void>();
    // Also a runtime smoke check — the stub returns void, so calling it
    // and assigning the result to a `void` slot must compile.
    const stub: ApprovalRuntime = new AlwaysAllowApprovalRuntime();
    const result: void = stub.cancelBySource({ kind: 'turn', turn_id: 'turn_1' });
    expect(result).toBeUndefined();
  });
});
