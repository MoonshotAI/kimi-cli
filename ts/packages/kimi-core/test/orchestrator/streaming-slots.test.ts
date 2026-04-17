/**
 * Slice 5 / 决策 #97: ToolCallOrchestrator streaming method slots.
 *
 * Pins (Phase 5 ONLY reserves these — no runtime behaviour yet):
 *   - `executeStreaming?(toolCall, signal): void` slot exists (optional).
 *   - `drainPrefetched?(): ReadonlyMap<string, ToolResult>` slot exists
 *     (optional).
 *   - `discardStreaming?(reason: 'fallback' | 'aborted' | 'timeout'): void`
 *     slot exists — Slice 4 already added a no-op `discardStreaming` on
 *     orchestrator.ts with the `'aborted' | 'timeout'` union; Phase 5 must
 *     NOT narrow or remove the existing method (Phase 4 tests rely on it).
 *
 * Phase 5 is free to land either:
 *   (a) the methods as literal class methods with empty bodies, OR
 *   (b) leave them as `undefined` on the prototype and have the optional
 *       `?.` chain in future callers short-circuit.
 *
 * The test accepts both: it only asserts that when the method IS present,
 * it is a function that returns without throwing under a defensible call
 * shape.
 *
 * Expected to FAIL before Phase 5 (soft): executeStreaming / drainPrefetched
 * do not exist on the current class. discardStreaming already exists and
 * the corresponding assertion will pass — kept as a regression guard.
 */

import { describe, expect, it, vi } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import { AlwaysAllowApprovalRuntime } from '../../src/soul-plus/approval-runtime.js';
import { ToolCallOrchestrator } from '../../src/soul-plus/orchestrator.js';
import type { HookExecutor } from '../../src/hooks/types.js';
import type { ToolCall } from '../../src/soul/types.js';

function makeOrchestrator(): ToolCallOrchestrator {
  const executor: HookExecutor = {
    type: 'command',
    execute: vi.fn().mockResolvedValue({ ok: true }),
  };
  const hookEngine = new HookEngine({
    executors: new Map([['command', executor]]),
  });
  return new ToolCallOrchestrator({
    hookEngine,
    sessionId: 'sess_1',
    agentId: 'agent_main',
    approvalRuntime: new AlwaysAllowApprovalRuntime(),
  });
}

function asMethodSlot(
  target: object,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  const slot = (target as unknown as Record<string, unknown>)[name];
  return typeof slot === 'function' ? (slot as (...args: unknown[]) => unknown) : undefined;
}

describe('ToolCallOrchestrator — streaming method slots (决策 #97 reservation)', () => {
  it('executeStreaming is either absent (phase-gated) or a callable method', () => {
    const orch = makeOrchestrator();
    const slot = asMethodSlot(orch, 'executeStreaming');
    if (slot === undefined) {
      // Phase 5 allowed stance — flip to `expect(slot).toBeTypeOf('function')`
      // once the method is wired. The test exists to document the slot.
      return;
    }
    const toolCall: ToolCall = { id: 'tc_1', name: 'echo', args: {} };
    const signal = new AbortController().signal;
    // Phase 5 body may be a no-op; it just must NOT throw.
    expect(() => {
      slot.call(orch, toolCall, signal);
    }).not.toThrow();
  });

  it('drainPrefetched is either absent (phase-gated) or returns a ReadonlyMap', () => {
    const orch = makeOrchestrator();
    const slot = asMethodSlot(orch, 'drainPrefetched');
    if (slot === undefined) return;
    const out = slot.call(orch);
    expect(out).toBeInstanceOf(Map);
    // After Phase 5, draining an orchestrator that never ran streaming must
    // return an empty map — NOT undefined — so Soul can call .get() safely.
    expect((out as Map<unknown, unknown>).size).toBe(0);
  });

  it('discardStreaming already exists (Slice 4 no-op) and must remain callable', () => {
    const orch = makeOrchestrator();
    // Intentionally reach .discardStreaming directly (not via `?.`) — a
    // Phase 5 regression that removes the method would fail here.
    expect(typeof orch.discardStreaming).toBe('function');
    // The Phase-4 union is `'aborted' | 'timeout'`. Phase 5 MAY widen it to
    // include `'fallback'` for streaming fallback; the regression pin
    // enforces the existing calls still compile.
    expect(() => {
      orch.discardStreaming('aborted');
    }).not.toThrow();
    expect(() => {
      orch.discardStreaming('timeout');
    }).not.toThrow();
  });
});
