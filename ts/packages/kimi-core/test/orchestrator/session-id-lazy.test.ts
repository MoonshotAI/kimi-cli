/**
 * Covers: `ToolCallOrchestratorDeps.sessionId` late-bound closure
 * accepted in Slice 4.2 (M2). The TUI bridge constructs the
 * orchestrator before `SessionManager.createSession` allocates the
 * real session id, so `deps.sessionId` must be allowed to be a
 * `() => string` that the orchestrator evaluates fresh on each hook
 * input payload — not snapshot at construction time.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { HookEngine } from '../../src/hooks/engine.js';
import type { HookExecutor, HookInput, HookEventType } from '../../src/hooks/types.js';
import { AlwaysAllowApprovalRuntime } from '../../src/soul-plus/approval-runtime.js';
import { ToolCallOrchestrator } from '../../src/soul-plus/orchestrator.js';
import type { AfterToolCallContext, BeforeToolCallContext } from '../../src/soul/types.js';
import type { SoulContextState } from '../../src/storage/context-state.js';

// ── Tracking harness ────────────────────────────────────────────────

function makeTrackingEngine(): {
  engine: HookEngine;
  calls: Array<{ event: HookEventType; input: HookInput }>;
} {
  const calls: Array<{ event: HookEventType; input: HookInput }> = [];
  const executor: HookExecutor = {
    type: 'command',
    execute: vi.fn().mockImplementation(async (_hook, input) => {
      calls.push({ event: input.event, input });
      return { ok: true };
    }),
  };
  const engine = new HookEngine({
    executors: new Map([['command', executor]]),
  });
  engine.register({ type: 'command', event: 'PreToolUse', command: 'pre' });
  engine.register({ type: 'command', event: 'PostToolUse', command: 'post' });
  engine.register({ type: 'command', event: 'OnToolFailure', command: 'fail' });
  return { engine, calls };
}

function makeFakeContext(): SoulContextState {
  /* oxlint-disable unicorn/no-useless-undefined */
  return {
    buildMessages: vi.fn().mockReturnValue([]),
    appendUserMessage: vi.fn().mockResolvedValue(undefined),
    appendAssistantMessage: vi.fn().mockResolvedValue(undefined),
    appendToolResult: vi.fn().mockResolvedValue(undefined),
    drainSteerMessages: vi.fn().mockReturnValue([]),
    tokenCountWithPending: vi.fn().mockReturnValue(0),
    resetToSummary: vi.fn().mockResolvedValue(undefined),
  } as unknown as SoulContextState;
  /* oxlint-enable unicorn/no-useless-undefined */
}

function makeBeforeCtx(): BeforeToolCallContext {
  return {
    toolCall: { id: 'tc_1', name: 'Echo', args: {} },
    args: {},
    assistantMessage: { role: 'assistant', content: '' },
    context: makeFakeContext(),
  };
}

function makeAfterCtx(): AfterToolCallContext {
  return {
    toolCall: { id: 'tc_1', name: 'Echo', args: {} },
    args: {},
    result: { content: 'ok' },
    context: makeFakeContext(),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('ToolCallOrchestrator — sessionId closure (Slice 4.2 M2)', () => {
  it('accepts a string and threads it onto every hook input (baseline)', async () => {
    const { engine, calls } = makeTrackingEngine();
    const orch = new ToolCallOrchestrator({
      hookEngine: engine,
      sessionId: 'ses_literal',
      agentId: 'agent_main',
      approvalRuntime: new AlwaysAllowApprovalRuntime(),
    });
    const before = orch.buildBeforeToolCall({ turnId: 'turn_1' });
    await before(makeBeforeCtx(), new AbortController().signal);
    expect(calls[0]?.input).toMatchObject({ sessionId: 'ses_literal' });
  });

  it('accepts a closure and evaluates it fresh on each PreToolUse dispatch', async () => {
    // The TUI bridge's real use case: the session id is allocated by
    // SessionManager AFTER the orchestrator is constructed. A literal
    // captured at construction time would be stale; a closure lets the
    // orchestrator read the updated slot on every hook input.
    let resolved = 'session_pending';
    const { engine, calls } = makeTrackingEngine();
    const orch = new ToolCallOrchestrator({
      hookEngine: engine,
      sessionId: () => resolved,
      agentId: 'agent_main',
      approvalRuntime: new AlwaysAllowApprovalRuntime(),
    });
    const before = orch.buildBeforeToolCall({ turnId: 'turn_1' });

    // First call sees the pre-allocation placeholder.
    await before(makeBeforeCtx(), new AbortController().signal);
    expect(calls[0]?.input).toMatchObject({ sessionId: 'session_pending' });

    // Simulate SessionManager allocating the real id, THEN the next
    // hook input must pick it up without rebuilding the orchestrator.
    resolved = 'ses_real_42';
    await before(makeBeforeCtx(), new AbortController().signal);
    expect(calls[1]?.input).toMatchObject({ sessionId: 'ses_real_42' });
  });

  it('afterToolCall PostToolUse payload also reads the closure lazily', async () => {
    // All three hook input callsites (PreToolUse / PostToolUse /
    // OnToolFailure) must honor the closure, not just the first.
    let resolved = 'session_pending';
    const { engine, calls } = makeTrackingEngine();
    const orch = new ToolCallOrchestrator({
      hookEngine: engine,
      sessionId: () => resolved,
      agentId: 'agent_main',
      approvalRuntime: new AlwaysAllowApprovalRuntime(),
    });
    const after = orch.buildAfterToolCall({ turnId: 'turn_1' });

    resolved = 'ses_post';
    await after(makeAfterCtx(), new AbortController().signal);
    const postCall = calls.find((c) => c.event === 'PostToolUse');
    expect(postCall?.input).toMatchObject({ sessionId: 'ses_post' });
  });

  it('afterToolCall OnToolFailure payload reads the closure lazily', async () => {
    let resolved = 'session_pending';
    const { engine, calls } = makeTrackingEngine();
    const orch = new ToolCallOrchestrator({
      hookEngine: engine,
      sessionId: () => resolved,
      agentId: 'agent_main',
      approvalRuntime: new AlwaysAllowApprovalRuntime(),
    });
    // Register a throwing tool via wrapTools so the orchestrator
    // records a `kind: 'throw'` outcome for this tool call id — the
    // afterToolCall branch then routes to OnToolFailure.
    const throwing = {
      name: 'Throwing',
      description: 't',
      inputSchema: z.object({}),
      execute: async (): Promise<never> => {
        throw new Error('boom');
      },
    };
    const [wrapped] = orch.wrapTools([throwing]);
    if (wrapped === undefined) throw new Error('wrapTools returned empty');
    await expect(wrapped.execute('tc_err', {}, new AbortController().signal)).rejects.toThrow(
      'boom',
    );

    resolved = 'ses_fail';
    const after = orch.buildAfterToolCall({ turnId: 'turn_1' });
    await after(
      {
        toolCall: { id: 'tc_err', name: 'Throwing', args: {} },
        args: {},
        result: { content: '', isError: true },
        context: makeFakeContext(),
      },
      new AbortController().signal,
    );
    const failCall = calls.find((c) => c.event === 'OnToolFailure');
    expect(failCall?.input).toMatchObject({ sessionId: 'ses_fail' });
  });

  it('closure fallback string survives orchestrator construction before any session exists', async () => {
    // Regression for the KimiCoreClient use case: orchestrator is
    // constructed BEFORE sessionRef.current is set. The fallback inside
    // the closure must keep the hook input well-formed so tests /
    // embedders that exercise the pipeline pre-registration still get
    // a stable sessionId (e.g. 'session_pending').
    const sessionRef: { current: { sessionId: string } | null } = { current: null };
    const { engine, calls } = makeTrackingEngine();
    const orch = new ToolCallOrchestrator({
      hookEngine: engine,
      sessionId: () => sessionRef.current?.sessionId ?? 'session_pending',
      agentId: 'agent_main',
      approvalRuntime: new AlwaysAllowApprovalRuntime(),
    });
    const before = orch.buildBeforeToolCall({ turnId: 'turn_1' });
    await before(makeBeforeCtx(), new AbortController().signal);
    expect(calls[0]?.input).toMatchObject({ sessionId: 'session_pending' });

    // Late registration — subsequent calls see the real id.
    sessionRef.current = { sessionId: 'ses_late_bound' };
    await before(makeBeforeCtx(), new AbortController().signal);
    expect(calls[1]?.input).toMatchObject({ sessionId: 'ses_late_bound' });
  });
});
