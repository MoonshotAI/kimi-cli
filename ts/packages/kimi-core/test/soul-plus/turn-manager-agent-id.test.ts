/**
 * Slice 2.3 regression for Slice 2.2 reviewer N1 — TurnManager no longer
 * hardcodes `agent_main` for `approvalSource.agent_id`; it uses the
 * TurnManagerDeps.agentId (defaulting to 'agent_main' only when omitted).
 */

import { describe, expect, it } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import type { HookExecutor } from '../../src/hooks/types.js';
import {
  SoulLifecycleGate,
  SessionLifecycleStateMachine,
  SoulRegistry,
  TurnManager,
  createRuntime,
  ToolCallOrchestrator,
  AlwaysAllowApprovalRuntime,
  SessionEventBus,
} from '../../src/soul-plus/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
} from './fixtures/slice3-harness.js';
import { makeRealSubcomponents } from './fixtures/real-subcomponents.js';

function buildManager(opts: { agentType?: 'main' | 'sub' | 'independent'; agentId?: string }): {
  manager: TurnManager;
  sourceCaptured: { kind: string; agent_id?: string }[];
} {
  const hookExecutor: HookExecutor = {
    type: 'command',
    execute: async () => ({ ok: true }),
  };
  const hookEngine = new HookEngine({
    executors: new Map([['command', hookExecutor]]),
  });

  const sourceCaptured: { kind: string; agent_id?: string }[] = [];
  const approvalRuntime = new AlwaysAllowApprovalRuntime();

  const orchestrator = new ToolCallOrchestrator({
    hookEngine,
    sessionId: 'sess_regression',
    agentId: opts.agentId ?? 'agent_main',
    approvalRuntime,
  });
  // Snoop on buildBeforeToolCall to capture the approvalSource it sees.
  const origBuild = orchestrator.buildBeforeToolCall.bind(orchestrator);
  orchestrator.buildBeforeToolCall = (ctx): ReturnType<typeof origBuild> => {
    const src = ctx.approvalSource;
    if (src !== undefined) {
      sourceCaptured.push(
        src.kind === 'soul' || src.kind === 'subagent'
          ? { kind: src.kind, agent_id: src.agent_id }
          : { kind: src.kind },
      );
    }
    return origBuild(ctx);
  };

  const kosong = new ScriptedKosongAdapter({
    responses: [makeEndTurnResponse('done')],
  });
  const stateMachine = new SessionLifecycleStateMachine();
  const gate = new SoulLifecycleGate(stateMachine);
  const context = createHarnessContextState();
  const journal = new InMemorySessionJournalImpl();
  const eventBus = new SessionEventBus();
  const runtime = createRuntime({
    kosong,
    lifecycle: gate,
    compactionProvider: createNoopCompactionProvider(),
    journal: createNoopJournalCapability(),
  });
  const soulRegistry = new SoulRegistry({
    createHandle: (key) => ({
      key,
      agentId: opts.agentId ?? 'agent_main',
      abortController: new AbortController(),
    }),
  });
  const manager = new TurnManager({
    contextState: context,
    sessionJournal: journal,
    runtime,
    sink: eventBus,
    lifecycleStateMachine: stateMachine,
    soulRegistry,
    tools: [],
    orchestrator,
    agentId: opts.agentId,
    agentType: opts.agentType,
    ...makeRealSubcomponents({
      contextState: context,
      lifecycleStateMachine: stateMachine,
      sink: eventBus,
      orchestrator,
    }),
  });

  return { manager, sourceCaptured };
}

describe('TurnManager — real agent id threading (Slice 2.2 N1)', () => {
  it('main soul uses the injected agentId, not the hardcoded placeholder', async () => {
    const { manager, sourceCaptured } = buildManager({ agentId: 'real_main_agent_42' });
    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if ('turn_id' in response) {
      await manager.awaitTurn(response.turn_id);
    }
    expect(sourceCaptured).toHaveLength(1);
    expect(sourceCaptured[0]).toMatchObject({
      kind: 'soul',
      agent_id: 'real_main_agent_42',
    });
  });

  it('subagent TurnManager uses subagent kind + provided id', async () => {
    const { manager, sourceCaptured } = buildManager({
      agentType: 'sub',
      agentId: 'sub_7',
    });
    const response = await manager.handlePrompt({ data: { input: { text: 'go' } } });
    if ('turn_id' in response) {
      await manager.awaitTurn(response.turn_id);
    }
    expect(sourceCaptured[0]).toMatchObject({
      kind: 'subagent',
      agent_id: 'sub_7',
    });
  });

  it('defaults agentId to "agent_main" when not supplied (back-compat)', () => {
    const { manager } = buildManager({});
    expect(manager.getAgentId()).toBe('agent_main');
  });

  it('addSessionRule appends without breaking getSessionRules()', () => {
    const { manager } = buildManager({});
    manager.addSessionRule({
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Bash',
      reason: 'approve_for_session: run command',
    });
    const rules = manager.getSessionRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pattern).toBe('Bash');
  });
});
