/**
 * R-6 regression guard (Phase 20 Slice 20-C).
 *
 * Pins `ToolCallOrchestrator.wrapSingle` (and `wrapTools`) field pass-through
 * for the three Slice 5 optional fields on `Tool`:
 *
 *   - `maxResultSizeChars` (number | undefined)
 *   - `display`            (ToolDisplayHooks | undefined)
 *   - `isConcurrencySafe`  (bound predicate | undefined)
 *
 * If wrapSingle drops any of these on the floor, Phase 18 A.2 `tool.call`
 * reverse-RPC (external tool wrapper) silently observes `undefined` and
 * the feature collapses without a test failure. This file exists so that
 * regression is caught immediately instead of surfacing via downstream
 * observability. See Slice 5 review (Blocker 1) for the original incident.
 *
 * These tests are regression guards — they should pass green on the
 * current implementation. A red here means wrapSingle lost the forward,
 * not that the tests need adjusting.
 *
 * Note: wrapSingle is private; exercised here through the public
 * wrapTools([inner]) entry (the sole caller). Any future `wrapSingle`
 * signature change must update wrapTools first.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { HookEngine } from '../../src/hooks/engine.js';
import type { HookExecutor } from '../../src/hooks/types.js';
import { AlwaysAllowApprovalRuntime } from '../../src/soul-plus/approval-runtime.js';
import { ToolCallOrchestrator } from '../../src/soul-plus/orchestrator.js';
import type { Tool, ToolDisplayHooks } from '../../src/soul/types.js';

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
    sessionId: 'sess_regression',
    agentId: 'agent_main',
    approvalRuntime: new AlwaysAllowApprovalRuntime(),
  });
}

function makeBaseTool(overrides?: Partial<Tool>): Tool {
  return {
    name: 'FakeTool',
    description: 'test',
    inputSchema: z.object({}),
    execute: vi.fn().mockResolvedValue({ content: 'ok' }),
    ...overrides,
  };
}

describe('ToolCallOrchestrator.wrapSingle — Slice 5 field pass-through', () => {
  it('forwards maxResultSizeChars when inner declares it (50_000)', () => {
    const orch = makeOrchestrator();
    const inner = makeBaseTool({ maxResultSizeChars: 50_000 });
    const [wrapped] = orch.wrapTools([inner]);
    expect(wrapped?.maxResultSizeChars).toBe(50_000);
  });

  it('forwards maxResultSizeChars === Infinity verbatim (self-limited tools)', () => {
    const orch = makeOrchestrator();
    const inner = makeBaseTool({ maxResultSizeChars: Number.POSITIVE_INFINITY });
    const [wrapped] = orch.wrapTools([inner]);
    expect(wrapped?.maxResultSizeChars).toBe(Number.POSITIVE_INFINITY);
  });

  it('leaves maxResultSizeChars unset (not a spurious undefined) when inner omits it', () => {
    const orch = makeOrchestrator();
    const inner = makeBaseTool();
    const [wrapped] = orch.wrapTools([inner]);
    // `exactOptionalPropertyTypes` contract: missing field, not `undefined` value.
    expect('maxResultSizeChars' in (wrapped ?? {})).toBe(false);
    expect(wrapped?.maxResultSizeChars).toBeUndefined();
  });

  it('forwards display hook bundle by reference', () => {
    const orch = makeOrchestrator();
    const display: ToolDisplayHooks = {
      getUserFacingName: () => 'Pretty',
      getActivityDescription: () => 'doing a thing',
    };
    const inner = makeBaseTool({ display });
    const [wrapped] = orch.wrapTools([inner]);
    expect(wrapped?.display).toBe(display);
    expect(wrapped?.display?.getUserFacingName?.({})).toBe('Pretty');
  });

  it('leaves display unset when inner omits it', () => {
    const orch = makeOrchestrator();
    const inner = makeBaseTool();
    const [wrapped] = orch.wrapTools([inner]);
    expect('display' in (wrapped ?? {})).toBe(false);
    expect(wrapped?.display).toBeUndefined();
  });

  it('forwards isConcurrencySafe and preserves its `this`-binding to inner', () => {
    const orch = makeOrchestrator();
    // Predicate references a sibling field on `inner` via `this` so we
    // can detect a bind-loss regression (unbound call would read
    // `undefined.allowList`).
    interface Inputs {
      op: string;
    }
    const innerWithState = {
      name: 'ConcurTool',
      description: 'c',
      inputSchema: z.object({ op: z.string() }),
      allowList: ['read', 'list'] as readonly string[],
      execute: vi.fn().mockResolvedValue({ content: 'ok' }),
      isConcurrencySafe(input: Inputs): boolean {
        return this.allowList.includes(input.op);
      },
    };
    const [wrapped] = orch.wrapTools([innerWithState as unknown as Tool]);
    expect(typeof wrapped?.isConcurrencySafe).toBe('function');
    // Must not throw (would throw if `this` were lost).
    expect(wrapped?.isConcurrencySafe?.({ op: 'read' })).toBe(true);
    expect(wrapped?.isConcurrencySafe?.({ op: 'write' })).toBe(false);
    // Parity with the inner — same input, same boolean.
    expect(wrapped?.isConcurrencySafe?.({ op: 'list' })).toBe(
      innerWithState.isConcurrencySafe({ op: 'list' }),
    );
  });

  it('leaves isConcurrencySafe unset when inner omits it (default-deny for streaming)', () => {
    const orch = makeOrchestrator();
    const inner = makeBaseTool();
    const [wrapped] = orch.wrapTools([inner]);
    expect('isConcurrencySafe' in (wrapped ?? {})).toBe(false);
    expect(wrapped?.isConcurrencySafe).toBeUndefined();
  });

  it('wrapTools forwards all three fields per-tool without cross-tool bleed', () => {
    const orch = makeOrchestrator();
    const displayA: ToolDisplayHooks = { getUserFacingName: () => 'A' };
    const toolA = makeBaseTool({
      name: 'A',
      maxResultSizeChars: 10_000,
      display: displayA,
    });
    // B: no fields at all.
    const toolB = makeBaseTool({ name: 'B' });
    const toolC = makeBaseTool({
      name: 'C',
      maxResultSizeChars: Number.POSITIVE_INFINITY,
      isConcurrencySafe: () => true,
    });

    const [wrappedA, wrappedB, wrappedC] = orch.wrapTools([toolA, toolB, toolC]);

    // A — maxResultSizeChars + display forwarded, no isConcurrencySafe.
    expect(wrappedA?.maxResultSizeChars).toBe(10_000);
    expect(wrappedA?.display).toBe(displayA);
    expect('isConcurrencySafe' in (wrappedA ?? {})).toBe(false);

    // B — nothing set; fields do NOT leak in from neighbours.
    expect('maxResultSizeChars' in (wrappedB ?? {})).toBe(false);
    expect('display' in (wrappedB ?? {})).toBe(false);
    expect('isConcurrencySafe' in (wrappedB ?? {})).toBe(false);

    // C — maxResultSizeChars=Infinity + isConcurrencySafe forwarded, no display.
    expect(wrappedC?.maxResultSizeChars).toBe(Number.POSITIVE_INFINITY);
    expect(wrappedC?.isConcurrencySafe?.({})).toBe(true);
    expect('display' in (wrappedC ?? {})).toBe(false);
  });
});
