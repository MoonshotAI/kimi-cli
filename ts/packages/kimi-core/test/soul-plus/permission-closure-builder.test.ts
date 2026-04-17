/**
 * Slice 4 / Phase 4 — PermissionClosureBuilder 纯函数契约测试（决策 #109）.
 *
 * 从 TurnManager 抽出 `buildBeforeToolCall` / `buildAfterToolCall` /
 * `computeTurnRules` 三个纯方法。依赖最多 2 项：
 *
 *   - orchestrator?: ToolCallOrchestrator
 *   - hookEngine?: HookEngine
 *
 * 方法签名：
 *   - computeTurnRules(sessionRules, pendingOverrides?) → 合并 activeTools
 *     (allow) + disallowedTools (deny) 为 turn-override scope 规则，追加在
 *     sessionRules 之后
 *   - buildBeforeToolCall(ctx) → 有 orchestrator 时委托其 buildBeforeToolCall；
 *     无 orchestrator 时返回 always-allow (async () => undefined)
 *   - buildAfterToolCall(ctx) → 同上
 *
 * 预计 FAIL：`PermissionClosureBuilder` 还不存在（Implementer 阶段创建）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PermissionClosureBuilder,
  type PermissionClosureBuilderDeps,
  type PermissionClosureContext,
} from '../../src/soul-plus/permission-closure-builder.js';
import type { PermissionRule } from '../../src/soul-plus/index.js';
import type { ApprovalSource } from '../../src/storage/wire-record.js';

function sessionRule(pattern: string, decision: 'allow' | 'deny' = 'allow'): PermissionRule {
  return { decision, scope: 'project', pattern };
}

function baseCtx(overrides: Partial<PermissionClosureContext> = {}): PermissionClosureContext {
  const approvalSource: ApprovalSource = { kind: 'soul', agent_id: 'agent_main' };
  return {
    turnId: 'turn_1',
    permissionRules: [],
    permissionMode: 'default',
    approvalSource,
    ...overrides,
  };
}

describe('PermissionClosureBuilder.computeTurnRules', () => {
  it('returns sessionRules unchanged when no pendingOverrides are set', () => {
    const builder = new PermissionClosureBuilder({});
    const sessionRules = [sessionRule('Read'), sessionRule('Bash', 'deny')];
    const result = builder.computeTurnRules(sessionRules, undefined);
    expect(result).toEqual(sessionRules);
  });

  it('appends turn-override allow rules for activeTools', () => {
    const builder = new PermissionClosureBuilder({});
    const sessionRules = [sessionRule('Read')];
    const result = builder.computeTurnRules(sessionRules, {
      activeTools: ['Edit', 'Write'],
    });
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({ decision: 'allow', scope: 'turn-override', pattern: 'Edit' });
    expect(result[2]).toMatchObject({ decision: 'allow', scope: 'turn-override', pattern: 'Write' });
  });

  it('appends turn-override deny rules for disallowedTools', () => {
    const builder = new PermissionClosureBuilder({});
    const sessionRules = [sessionRule('Read')];
    const result = builder.computeTurnRules(sessionRules, {
      disallowedTools: ['Bash', 'Execute'],
    });
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({ decision: 'deny', scope: 'turn-override', pattern: 'Bash' });
    expect(result[2]).toMatchObject({ decision: 'deny', scope: 'turn-override', pattern: 'Execute' });
  });

  it('merges sessionRules + activeTools allow + disallowedTools deny (sessionRules first, overrides last)', () => {
    const builder = new PermissionClosureBuilder({});
    const sessionRules = [sessionRule('Read'), sessionRule('Grep')];
    const result = builder.computeTurnRules(sessionRules, {
      activeTools: ['Edit'],
      disallowedTools: ['Bash'],
    });
    expect(result.map((r) => r.pattern)).toEqual(['Read', 'Grep', 'Edit', 'Bash']);
    expect(result[2]?.decision).toBe('allow');
    expect(result[3]?.decision).toBe('deny');
  });
});

describe('PermissionClosureBuilder.buildBeforeToolCall', () => {
  it('delegates to orchestrator.buildBeforeToolCall when an orchestrator is supplied', () => {
    const returnedHook = vi.fn(async () => undefined);
    const orchestratorBuildBefore = vi.fn(() => returnedHook);
    const orchestrator = {
      buildBeforeToolCall: orchestratorBuildBefore,
      buildAfterToolCall: vi.fn(),
      wrapTools: vi.fn(),
    };
    const deps = {
      orchestrator,
    } as unknown as PermissionClosureBuilderDeps;
    const builder = new PermissionClosureBuilder(deps);
    const hook = builder.buildBeforeToolCall(baseCtx());
    expect(orchestratorBuildBefore).toHaveBeenCalledTimes(1);
    expect(hook).toBe(returnedHook);
  });

  it('returns an always-allow closure (resolves to undefined) when no orchestrator is supplied', async () => {
    const builder = new PermissionClosureBuilder({});
    const hook = builder.buildBeforeToolCall(baseCtx());
    expect(hook).toBeDefined();
    if (hook === undefined) throw new Error('unreachable');
    const result = await hook(
      {
        toolCall: { id: 'call_1', name: 'Read', args: {} },
        args: {},
        assistantMessage: {} as never,
        context: {} as never,
      },
      new AbortController().signal,
    );
    expect(result).toBeUndefined();
  });
});

describe('PermissionClosureBuilder.buildAfterToolCall', () => {
  it('delegates to orchestrator.buildAfterToolCall when an orchestrator is supplied', () => {
    const returnedHook = vi.fn(async () => undefined);
    const orchestratorBuildAfter = vi.fn(() => returnedHook);
    const orchestrator = {
      buildBeforeToolCall: vi.fn(),
      buildAfterToolCall: orchestratorBuildAfter,
      wrapTools: vi.fn(),
    };
    const deps = {
      orchestrator,
    } as unknown as PermissionClosureBuilderDeps;
    const builder = new PermissionClosureBuilder(deps);
    const hook = builder.buildAfterToolCall(baseCtx());
    expect(orchestratorBuildAfter).toHaveBeenCalledTimes(1);
    expect(hook).toBe(returnedHook);
  });

  it('returns an always-allow closure when no orchestrator is supplied', async () => {
    const builder = new PermissionClosureBuilder({});
    const hook = builder.buildAfterToolCall(baseCtx());
    expect(hook).toBeDefined();
    if (hook === undefined) throw new Error('unreachable');
    const result = await hook(
      {
        toolCall: { id: 'call_1', name: 'Read', args: {} },
        args: {},
        result: { content: [] } as never,
        context: {} as never,
      },
      new AbortController().signal,
    );
    expect(result).toBeUndefined();
  });
});
