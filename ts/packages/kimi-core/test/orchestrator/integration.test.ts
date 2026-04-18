/**
 * Covers: TurnManager + ToolCallOrchestrator + real tool integration (Slice 3 + Slice 4).
 *
 * Pins:
 *   - TurnManager.handlePrompt → Soul → tool.execute → PostToolUse hook fires
 *   - Tool failure → tool_result isError=true → OnToolFailure hook fires
 *   - ToolCallOrchestrator replaces TurnManager's always-allow stubs from Slice 3
 *
 * These tests confirm that Slice 4's orchestrator integrates cleanly with
 * Slice 3's TurnManager without breaking the existing Soul turn flow.
 */

import { describe, expect, it, vi } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import type { HookEventType, HookExecutor, HookInput } from '../../src/hooks/types.js';
import {
  AlwaysAllowApprovalRuntime,
  SoulLifecycleGate,
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulRegistry,
  TurnManager,
  createRuntime,
  ToolCallOrchestrator,
} from '../../src/soul-plus/index.js';
import type { Tool } from '../../src/soul/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
} from '../soul-plus/fixtures/slice3-harness.js';
import { makeRealSubcomponents } from '../soul-plus/fixtures/real-subcomponents.js';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from '../soul/fixtures/common.js';
import { EchoTool, FailingTool } from '../soul/fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

function buildIntegrationHarness(opts: {
  readonly kosong: ScriptedKosongAdapter;
  readonly tools?: readonly Tool[];
  readonly hookExecutor?: HookExecutor;
}): {
  manager: TurnManager;
  hookCalls: Array<{ event: HookEventType; input: HookInput }>;
  stateMachine: SessionLifecycleStateMachine;
} {
  const hookCalls: Array<{ event: HookEventType; input: HookInput }> = [];
  const executor: HookExecutor = opts.hookExecutor ?? {
    type: 'command',
    execute: vi.fn().mockImplementation(async (_hook, input) => {
      hookCalls.push({ event: input.event, input });
      return { ok: true };
    }),
  };

  const hookEngine = new HookEngine({
    executors: new Map([['command', executor]]),
  });
  hookEngine.register({ type: 'command', event: 'PostToolUse', command: 'post_hook' });
  hookEngine.register({ type: 'command', event: 'OnToolFailure', command: 'fail_hook' });

  const orchestrator = new ToolCallOrchestrator({
    hookEngine,
    sessionId: 'sess_integration',
    agentId: 'agent_main',
    approvalRuntime: new AlwaysAllowApprovalRuntime(),
  });

  const stateMachine = new SessionLifecycleStateMachine();
  const gate = new SoulLifecycleGate(stateMachine);
  const context = createHarnessContextState();
  const journal = new InMemorySessionJournalImpl();
  const eventBus = new SessionEventBus();
  const runtime = createRuntime({
    kosong: opts.kosong,
    lifecycle: gate,
    compactionProvider: createNoopCompactionProvider(),
    journal: createNoopJournalCapability(),
  });
  const soulRegistry = new SoulRegistry({
    createHandle: (key, agentDepth) => ({
      key,
      agentId: 'agent_main',
      abortController: new AbortController(),
      agentDepth,
    }),
  });
  const manager = new TurnManager({
    contextState: context,
    sessionJournal: journal,
    runtime,
    sink: eventBus,
    lifecycleStateMachine: stateMachine,
    soulRegistry,
    tools: opts.tools ?? [],
    orchestrator,
    ...makeRealSubcomponents({
      contextState: context,
      lifecycleStateMachine: stateMachine,
      sink: eventBus,
      orchestrator,
    }),
  });

  return { manager, hookCalls, stateMachine };
}

describe('TurnManager + ToolCallOrchestrator integration', () => {
  it('handlePrompt → Soul → tool.execute → PostToolUse hook fires', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hello' }, 'tc_1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { manager, hookCalls } = buildIntegrationHarness({
      kosong,
      tools: [new EchoTool()],
    });

    const response = await manager.handlePrompt({ data: { input: { text: 'test' } } });
    expect(response).toMatchObject({ status: 'started' });

    // Wait for the turn to complete
    if ('turn_id' in response) {
      await manager.awaitTurn(response.turn_id);
    }

    // PostToolUse hook should have been called
    const postCalls = hookCalls.filter((c) => c.event === 'PostToolUse');
    expect(postCalls).toHaveLength(1);
  });

  it('tool failure → OnToolFailure hook fires, PostToolUse does not', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('fail', {}, 'tc_1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { manager, hookCalls } = buildIntegrationHarness({
      kosong,
      tools: [new FailingTool()],
    });

    const response = await manager.handlePrompt({ data: { input: { text: 'trigger fail' } } });
    if ('turn_id' in response) {
      await manager.awaitTurn(response.turn_id);
    }

    const failCalls = hookCalls.filter((c) => c.event === 'OnToolFailure');
    const postCalls = hookCalls.filter((c) => c.event === 'PostToolUse');
    expect(failCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(0);
  });

  it('lifecycle returns to idle after tool turn with hooks', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc_1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { manager, stateMachine } = buildIntegrationHarness({
      kosong,
      tools: [new EchoTool()],
    });

    const response = await manager.handlePrompt({ data: { input: { text: 'go' } } });
    if ('turn_id' in response) {
      await manager.awaitTurn(response.turn_id);
    }

    expect(stateMachine.isIdle()).toBe(true);
  });
});
