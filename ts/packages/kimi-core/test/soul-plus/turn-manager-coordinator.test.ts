/**
 * Slice 4 / Phase 4 — TurnManager coordinator 级回归测试（决策 #109）.
 *
 * Phase 4 拆分后，TurnManager 只是协调者：
 *   - handlePrompt → tracker.allocateTurnId + tracker.registerTurn +
 *     tracker.fireLifecycleEvent('begin') + permissionBuilder.*（三件套）+
 *     launchTurn
 *   - runTurn 的 while-loop 在 needs_compaction 时委托
 *     `components.compaction.executeCompaction(signal)`
 *   - onTurnEnd → tracker.completeTurn + tracker.fireLifecycleEvent('end')
 *   - handleCancel → 通过 abortTurn（§7.2）→ tracker.cancelTurn
 *
 * 这些测试用 makeTurnManagerDeps() harness 一行构造子组件 stub，断言
 * TurnManager 对每个子组件的委托行为。既有 turn-manager-prompt /
 * -cancel / -steer / -lifecycle-observer / -compaction-loop 测试保留不动
 * 作为"外部行为不变"的第二道闸门；这里只复刻"委托关系"断言。
 *
 * 预计 FAIL：TurnManager 仍然自己持有 turn 状态 + compaction 方法，
 * 拆分完成后 subcomponent stubs 才会被调用。
 */

import { describe, expect, it, vi } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { TurnResult } from '../../src/soul/index.js';
import { TurnManager } from '../../src/soul-plus/index.js';
import { makeTurnManagerDeps } from './fixtures/turn-manager-harness.js';

vi.mock('../../src/soul/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/soul/index.js')>();
  return {
    ...mod,
    runSoulTurn: vi.fn(),
  };
});

function zeroUsage(): TurnResult['usage'] {
  return { input: 0, output: 0 };
}

function endTurnResult(): TurnResult {
  return { stopReason: 'end_turn', steps: 1, usage: zeroUsage() };
}

function needsCompactionResult(): TurnResult {
  return {
    stopReason: 'needs_compaction' as TurnResult['stopReason'],
    steps: 0,
    usage: zeroUsage(),
  };
}

describe('TurnManager coordinator — handlePrompt delegates to subcomponents', () => {
  it('allocates the turn id through TurnLifecycleTracker and registers the in-flight turn', async () => {
    vi.mocked(runSoulTurn).mockReset();
    vi.mocked(runSoulTurn).mockResolvedValue(endTurnResult());
    const h = makeTurnManagerDeps();
    h.subcomponents.lifecycle.allocateTurnId.mockReturnValueOnce('turn_42');
    const manager = new TurnManager(h.deps);

    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in response)) throw new Error('expected turn_id');

    expect(response.turn_id).toBe('turn_42');
    expect(h.subcomponents.lifecycle.allocateTurnId).toHaveBeenCalledTimes(1);
    expect(h.subcomponents.lifecycle.registerTurn).toHaveBeenCalledTimes(1);
    // First arg of registerTurn is the turnId string.
    expect(h.subcomponents.lifecycle.registerTurn.mock.calls[0]?.[0]).toBe('turn_42');
  });

  it('fires a lifecycle begin event via the tracker before the Soul turn launches', async () => {
    vi.mocked(runSoulTurn).mockReset();
    vi.mocked(runSoulTurn).mockResolvedValue(endTurnResult());
    const h = makeTurnManagerDeps();
    const manager = new TurnManager(h.deps);
    await manager.handlePrompt({ data: { input: { text: 'hello coordinator' } } });
    const calls = h.subcomponents.lifecycle.fireLifecycleEvent.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const firstEvent = calls[0]?.[0] as { kind?: string; userInput?: string };
    expect(firstEvent?.kind).toBe('begin');
    expect(firstEvent?.userInput).toBe('hello coordinator');
  });

  it('consults PermissionClosureBuilder (computeTurnRules + buildBeforeToolCall + buildAfterToolCall)', async () => {
    vi.mocked(runSoulTurn).mockReset();
    vi.mocked(runSoulTurn).mockResolvedValue(endTurnResult());
    const h = makeTurnManagerDeps();
    const manager = new TurnManager(h.deps);
    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if ('turn_id' in response) {
      await manager.awaitTurn(response.turn_id).catch(() => undefined);
    }
    expect(h.subcomponents.permissionBuilder.computeTurnRules).toHaveBeenCalledTimes(1);
    expect(h.subcomponents.permissionBuilder.buildBeforeToolCall).toHaveBeenCalledTimes(1);
    expect(h.subcomponents.permissionBuilder.buildAfterToolCall).toHaveBeenCalledTimes(1);
  });

  it('delegates compaction to CompactionOrchestrator inside the runTurn while-loop', async () => {
    vi.mocked(runSoulTurn).mockReset();
    // First call signals needs_compaction, second call ends the turn.
    vi.mocked(runSoulTurn)
      .mockResolvedValueOnce(needsCompactionResult())
      .mockResolvedValueOnce(endTurnResult());

    const h = makeTurnManagerDeps();
    const manager = new TurnManager(h.deps);
    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if ('turn_id' in response) {
      await manager.awaitTurn(response.turn_id);
    }

    expect(h.subcomponents.compaction.executeCompaction).toHaveBeenCalledTimes(1);
    // First argument is the AbortSignal — must be live (not aborted) at
    // the time coordinator delegates.
    const signalArg = h.subcomponents.compaction.executeCompaction.mock.calls[0]?.[0] as
      | AbortSignal
      | undefined;
    expect(signalArg).toBeInstanceOf(AbortSignal);
  });

  it('onTurnEnd delegates to tracker.completeTurn + fires end lifecycle event', async () => {
    vi.mocked(runSoulTurn).mockReset();
    vi.mocked(runSoulTurn).mockResolvedValue(endTurnResult());
    const h = makeTurnManagerDeps();
    const manager = new TurnManager(h.deps);
    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if ('turn_id' in response) {
      await manager.awaitTurn(response.turn_id);
    }
    expect(h.subcomponents.lifecycle.completeTurn).toHaveBeenCalledTimes(1);
    const endCalls = h.subcomponents.lifecycle.fireLifecycleEvent.mock.calls;
    const endEvent = endCalls.at(-1)?.[0] as { kind?: string; reason?: string };
    expect(endEvent?.kind).toBe('end');
  });

  it('handleCancel routes through the tracker (via abortTurn)', async () => {
    vi.mocked(runSoulTurn).mockReset();
    vi.mocked(runSoulTurn).mockResolvedValue(endTurnResult());
    const h = makeTurnManagerDeps();
    h.subcomponents.lifecycle.allocateTurnId.mockReturnValueOnce('turn_77');
    h.subcomponents.lifecycle.getCurrentTurnId.mockReturnValue('turn_77');
    const manager = new TurnManager(h.deps);
    await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    await manager.handleCancel({ data: { turn_id: 'turn_77' } });
    expect(h.subcomponents.lifecycle.cancelTurn).toHaveBeenCalledWith('turn_77');
  });
});
