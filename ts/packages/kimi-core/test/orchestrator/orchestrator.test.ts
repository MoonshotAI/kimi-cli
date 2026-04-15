/**
 * Covers: ToolCallOrchestrator (v2 §9-H / D18).
 *
 * Pins:
 *   - buildBeforeToolCall returns a BeforeToolCallHook closure
 *   - buildAfterToolCall returns an AfterToolCallHook closure
 *   - Phase 1: PreToolUse hook cannot modify args (updatedInput ignored)
 *   - Phase 1: PreToolUse blockAction → {block: true, reason} from beforeToolCall
 *   - PostToolUse hook fires after successful tool execution
 *   - OnToolFailure hook fires for error results (isError=true)
 *   - OnToolFailure does NOT fire for success results
 *   - PostToolUse does NOT fire for error results
 *   - Phase 1: permission/approval stages are always-allow stubs
 */

import { describe, expect, it, vi } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import type { HookExecutor, HookInput, HookEventType } from '../../src/hooks/types.js';
import { ToolCallOrchestrator } from '../../src/soul-plus/orchestrator.js';
import type { BeforeToolCallContext, AfterToolCallContext } from '../../src/soul/types.js';
import type { SoulContextState } from '../../src/storage/context-state.js';

function makeOrchestrator(hookEngine: HookEngine): ToolCallOrchestrator {
  return new ToolCallOrchestrator({
    hookEngine,
    sessionId: 'sess_1',
    agentId: 'agent_main',
  });
}

function makeNoopEngine(): HookEngine {
  const executor: HookExecutor = {
    type: 'command',
    execute: vi.fn().mockResolvedValue({ ok: true }),
  };
  return new HookEngine({
    executors: new Map([['command', executor]]),
  });
}

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
  // Register hooks for all events
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

describe('ToolCallOrchestrator', () => {
  it('buildBeforeToolCall returns a function', () => {
    const orch = makeOrchestrator(makeNoopEngine());
    const hook = orch.buildBeforeToolCall({ turnId: 'turn_1' });
    expect(typeof hook).toBe('function');
  });

  it('buildAfterToolCall returns a function', () => {
    const orch = makeOrchestrator(makeNoopEngine());
    const hook = orch.buildAfterToolCall({ turnId: 'turn_1' });
    expect(typeof hook).toBe('function');
  });

  it('beforeToolCall with no hooks returns undefined (allow)', async () => {
    const orch = makeOrchestrator(makeNoopEngine());
    const hook = orch.buildBeforeToolCall({ turnId: 'turn_1' });
    const ctx: BeforeToolCallContext = {
      toolCall: { id: 'tc_1', name: 'Bash', args: {} },
      args: { command: 'ls' },
      assistantMessage: { role: 'assistant', content: 'running ls' },
      context: makeFakeContext(),
    };
    const result = await hook(ctx, new AbortController().signal);
    expect(result).toBeUndefined();
  });

  it('beforeToolCall with blockAction hook returns {block: true}', async () => {
    const blockingExecutor: HookExecutor = {
      type: 'command',
      execute: vi.fn().mockResolvedValue({ ok: true, blockAction: true, reason: 'policy' }),
    };
    const engine = new HookEngine({
      executors: new Map([['command', blockingExecutor]]),
    });
    engine.register({ type: 'command', event: 'PreToolUse', command: 'blocker' });
    const orch = makeOrchestrator(engine);
    const hook = orch.buildBeforeToolCall({ turnId: 'turn_1' });
    const ctx: BeforeToolCallContext = {
      toolCall: { id: 'tc_1', name: 'Bash', args: {} },
      args: { command: 'rm -rf /' },
      assistantMessage: { role: 'assistant', content: 'deleting' },
      context: makeFakeContext(),
    };
    const result = await hook(ctx, new AbortController().signal);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('policy');
  });

  it('PreToolUse cannot modify args (updatedInput is ignored)', async () => {
    const mutatingExecutor: HookExecutor = {
      type: 'command',
      execute: vi.fn().mockResolvedValue({
        ok: true,
        updatedInput: { command: 'echo safe' },
      }),
    };
    const engine = new HookEngine({
      executors: new Map([['command', mutatingExecutor]]),
    });
    engine.register({ type: 'command', event: 'PreToolUse', command: 'mutator' });
    const orch = makeOrchestrator(engine);
    const hook = orch.buildBeforeToolCall({ turnId: 'turn_1' });
    const originalArgs = { command: 'rm -rf /' };
    const ctx: BeforeToolCallContext = {
      toolCall: { id: 'tc_1', name: 'Bash', args: originalArgs },
      args: originalArgs,
      assistantMessage: { role: 'assistant', content: '' },
      context: makeFakeContext(),
    };
    const result = await hook(ctx, new AbortController().signal);
    // Phase 1 constraint: updatedInput must be ignored, args stay original
    expect(result?.updatedInput).toBeUndefined();
  });

  it('afterToolCall fires PostToolUse for success results', async () => {
    const { engine, calls } = makeTrackingEngine();
    const orch = makeOrchestrator(engine);
    const hook = orch.buildAfterToolCall({ turnId: 'turn_1' });
    const ctx: AfterToolCallContext = {
      toolCall: { id: 'tc_1', name: 'Read', args: {} },
      args: { path: '/tmp/x' },
      result: { content: 'file data' },
      context: makeFakeContext(),
    };
    await hook(ctx, new AbortController().signal);
    const postCalls = calls.filter((c) => c.event === 'PostToolUse');
    expect(postCalls).toHaveLength(1);
  });

  it('afterToolCall fires OnToolFailure for error results (isError=true)', async () => {
    const { engine, calls } = makeTrackingEngine();
    const orch = makeOrchestrator(engine);
    const hook = orch.buildAfterToolCall({ turnId: 'turn_1' });
    const ctx: AfterToolCallContext = {
      toolCall: { id: 'tc_1', name: 'Bash', args: {} },
      args: { command: 'bad' },
      result: { content: 'error message', isError: true },
      context: makeFakeContext(),
    };
    await hook(ctx, new AbortController().signal);
    const failCalls = calls.filter((c) => c.event === 'OnToolFailure');
    expect(failCalls).toHaveLength(1);
    const postCalls = calls.filter((c) => c.event === 'PostToolUse');
    expect(postCalls).toHaveLength(0);
  });

  it('PostToolUse does NOT fire for error results', async () => {
    const { engine, calls } = makeTrackingEngine();
    const orch = makeOrchestrator(engine);
    const hook = orch.buildAfterToolCall({ turnId: 'turn_1' });
    const ctx: AfterToolCallContext = {
      toolCall: { id: 'tc_1', name: 'Bash', args: {} },
      args: { command: 'fail' },
      result: { content: 'oh no', isError: true },
      context: makeFakeContext(),
    };
    await hook(ctx, new AbortController().signal);
    const postCalls = calls.filter((c) => c.event === 'PostToolUse');
    expect(postCalls).toHaveLength(0);
  });

  it('OnToolFailure does NOT fire for success results', async () => {
    const { engine, calls } = makeTrackingEngine();
    const orch = makeOrchestrator(engine);
    const hook = orch.buildAfterToolCall({ turnId: 'turn_1' });
    const ctx: AfterToolCallContext = {
      toolCall: { id: 'tc_1', name: 'Read', args: {} },
      args: { path: '/ok' },
      result: { content: 'good' },
      context: makeFakeContext(),
    };
    await hook(ctx, new AbortController().signal);
    const failCalls = calls.filter((c) => c.event === 'OnToolFailure');
    expect(failCalls).toHaveLength(0);
  });
});
