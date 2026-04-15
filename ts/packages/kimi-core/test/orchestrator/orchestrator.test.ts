/**
 * Covers: ToolCallOrchestrator (v2 §9-H / D18).
 *
 * Pins:
 *   - buildBeforeToolCall returns a BeforeToolCallHook closure
 *   - buildAfterToolCall returns an AfterToolCallHook closure
 *   - Phase 1: PreToolUse hook cannot modify args (updatedInput ignored)
 *   - Phase 1: PreToolUse blockAction → {block: true, reason} from beforeToolCall
 *   - PostToolUse hook fires after successful tool execution
 *   - PostToolUse hook fires for soft isError results (no throw)
 *   - OnToolFailure fires ONLY on execute throw — NOT on result.isError=true
 *   - OnToolFailure passes original error object to hook
 *   - Abort does not fire any hooks (M5)
 *   - wrapTools intercepts execute throws and registers them
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { HookEngine } from '../../src/hooks/engine.js';
import type { HookExecutor, HookInput, HookEventType } from '../../src/hooks/types.js';
import { AlwaysAllowApprovalRuntime } from '../../src/soul-plus/approval-runtime.js';
import { ToolCallOrchestrator } from '../../src/soul-plus/orchestrator.js';
import type {
  BeforeToolCallContext,
  AfterToolCallContext,
  Tool,
  ToolResult,
} from '../../src/soul/types.js';
import type { SoulContextState } from '../../src/storage/context-state.js';

function makeOrchestrator(hookEngine: HookEngine): ToolCallOrchestrator {
  return new ToolCallOrchestrator({
    hookEngine,
    sessionId: 'sess_1',
    agentId: 'agent_main',
    approvalRuntime: new AlwaysAllowApprovalRuntime(),
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

function makeFakeTool(overrides?: Partial<Tool>): Tool {
  return {
    name: 'FakeTool',
    description: 'test',
    inputSchema: z.object({}),
    execute: vi.fn().mockResolvedValue({ content: 'ok' }),
    ...overrides,
  };
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

  // ── M5 regression: OnToolFailure fires ONLY on execute throw ────────

  it('soft isError=true result (no throw) fires PostToolUse, NOT OnToolFailure', async () => {
    const { engine, calls } = makeTrackingEngine();
    const orch = makeOrchestrator(engine);
    const hook = orch.buildAfterToolCall({ turnId: 'turn_1' });
    // No toolOutcome registered → orchestrator treats it as normal return.
    const ctx: AfterToolCallContext = {
      toolCall: { id: 'tc_soft', name: 'Bash', args: {} },
      args: { command: 'bad' },
      result: { content: 'not found', isError: true },
      context: makeFakeContext(),
    };
    await hook(ctx, new AbortController().signal);
    expect(calls.filter((c) => c.event === 'PostToolUse')).toHaveLength(1);
    expect(calls.filter((c) => c.event === 'OnToolFailure')).toHaveLength(0);
  });

  it('execute throw fires OnToolFailure with original error object', async () => {
    const { engine, calls } = makeTrackingEngine();
    const orch = makeOrchestrator(engine);
    const throwingTool = makeFakeTool({
      execute: vi.fn().mockRejectedValue(new TypeError('bad input')),
    });
    const wrappedTools = orch.wrapTools([throwingTool]);
    const wrapped = wrappedTools[0]!;
    // Execute the wrapped tool — it rethrows after registering the outcome.
    await expect(wrapped.execute('tc_throw', {}, new AbortController().signal)).rejects.toThrow(
      'bad input',
    );

    // Now afterToolCall should route to OnToolFailure, passing original error.
    const hook = orch.buildAfterToolCall({ turnId: 'turn_1' });
    const ctx: AfterToolCallContext = {
      toolCall: { id: 'tc_throw', name: 'FakeTool', args: {} },
      args: {},
      result: { content: 'Tool failed: bad input', isError: true },
      context: makeFakeContext(),
    };
    await hook(ctx, new AbortController().signal);
    const failCalls = calls.filter((c) => c.event === 'OnToolFailure');
    expect(failCalls).toHaveLength(1);
    const postCalls = calls.filter((c) => c.event === 'PostToolUse');
    expect(postCalls).toHaveLength(0);

    // Original error preserved (not a synthetic Error(content) wrapper).
    const failInput = failCalls[0]!.input;
    expect(failInput.event).toBe('OnToolFailure');
    if (failInput.event === 'OnToolFailure') {
      expect(failInput.error).toBeInstanceOf(TypeError);
      expect(failInput.error.message).toBe('bad input');
    }
  });

  it('AbortError throw does not fire OnToolFailure or PostToolUse', async () => {
    const { engine, calls } = makeTrackingEngine();
    const orch = makeOrchestrator(engine);
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const abortingTool = makeFakeTool({
      execute: vi.fn().mockRejectedValue(abortError),
    });
    const wrappedAbort = orch.wrapTools([abortingTool]);
    const wrapped = wrappedAbort[0]!;
    await expect(wrapped.execute('tc_abort', {}, new AbortController().signal)).rejects.toThrow();

    const hook = orch.buildAfterToolCall({ turnId: 'turn_1' });
    const ctx: AfterToolCallContext = {
      toolCall: { id: 'tc_abort', name: 'FakeTool', args: {} },
      args: {},
      result: { content: 'Tool was aborted', isError: true },
      context: makeFakeContext(),
    };
    await hook(ctx, new AbortController().signal);
    expect(calls.filter((c) => c.event === 'OnToolFailure')).toHaveLength(0);
    expect(calls.filter((c) => c.event === 'PostToolUse')).toHaveLength(0);
  });

  it('wrapTools preserves name, description, and inputSchema', () => {
    const orch = makeOrchestrator(makeNoopEngine());
    const tool = makeFakeTool({ name: 'Read', description: 'read file' });
    const wrappedArr = orch.wrapTools([tool]);
    const wrapped = wrappedArr[0]!;
    expect(wrapped.name).toBe('Read');
    expect(wrapped.description).toBe('read file');
    expect(wrapped.inputSchema).toBe(tool.inputSchema);
  });

  it('wrapTools passes through normal returns unchanged', async () => {
    const orch = makeOrchestrator(makeNoopEngine());
    const expectedResult: ToolResult = { content: 'data', output: { n: 42 } };
    const tool = makeFakeTool({ execute: vi.fn().mockResolvedValue(expectedResult) });
    const wrappedArr = orch.wrapTools([tool]);
    const wrapped = wrappedArr[0]!;
    const result = await wrapped.execute('tc_ok', {}, new AbortController().signal);
    expect(result).toBe(expectedResult);
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
