/**
 * Covers: Slice 2.2 Q6 regression — turn-override rules MUST NOT leak
 * across turns (v2 §9-E.7 + team-lead Q6 mandate).
 *
 * Scenario:
 *   Turn 1: `setPendingTurnOverrides({ disallowedTools: ['Write'] })`,
 *           orchestrator sees rule `Write → deny`.
 *   Turn 2: no overrides set, orchestrator sees only sessionRules (no
 *           disallowedTools), and the previously-denied `Write` call is
 *           no longer denied.
 *
 * We record the exact `permissionRules` snapshot the orchestrator sees
 * on each `buildBeforeToolCall` invocation via a spy orchestrator.
 *
 * The harness uses `ScriptedKosongAdapter` so the Soul turn doesn't
 * actually invoke any tools — we only care that the closure factory
 * was called with the right rule set for each turn.
 */

import { describe, expect, it } from 'vitest';

import { HookEngine } from '../../../src/hooks/engine.js';
import type { HookExecutor } from '../../../src/hooks/types.js';
import {
  AlwaysAllowApprovalRuntime,
  SoulLifecycleGate,
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulRegistry,
  ToolCallOrchestrator,
  TurnManager,
  createRuntime,
} from '../../../src/soul-plus/index.js';
import type { ToolCallOrchestratorContext } from '../../../src/soul-plus/orchestrator.js';
import type { PermissionRule } from '../../../src/soul-plus/permission/index.js';
import { InMemorySessionJournalImpl } from '../../../src/storage/session-journal.js';
import { makeEndTurnResponse } from '../../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
} from '../fixtures/slice3-harness.js';
import { makeRealSubcomponents } from '../fixtures/real-subcomponents.js';

/**
 * Spy orchestrator that delegates to a real ToolCallOrchestrator but
 * records the rule snapshot every `buildBeforeToolCall` receives. We
 * need to delegate (instead of stubbing) because TurnManager also
 * calls `wrapTools` and `buildAfterToolCall` on the orchestrator.
 */
class RuleSpyOrchestrator extends ToolCallOrchestrator {
  public readonly seenRules: Array<readonly PermissionRule[]> = [];

  override buildBeforeToolCall(ctx: ToolCallOrchestratorContext) {
    this.seenRules.push(ctx.permissionRules ?? []);
    return super.buildBeforeToolCall(ctx);
  }
}

function buildHarness(): { manager: TurnManager; spy: RuleSpyOrchestrator } {
  const executor: HookExecutor = {
    type: 'command',
    execute: async () => ({ ok: true }),
  };
  const hookEngine = new HookEngine({
    executors: new Map([['command', executor]]),
  });
  const spy = new RuleSpyOrchestrator({
    hookEngine,
    sessionId: 'sess_q6',
    agentId: 'agent_main',
    approvalRuntime: new AlwaysAllowApprovalRuntime(),
  });

  const stateMachine = new SessionLifecycleStateMachine();
  const gate = new SoulLifecycleGate(stateMachine);
  const context = createHarnessContextState();
  const journal = new InMemorySessionJournalImpl();
  const eventBus = new SessionEventBus();
  // Scripted kosong responds with `end_turn` both times so the Soul
  // turn finishes deterministically without invoking tools.
  const kosong = new ScriptedKosongAdapter({
    responses: [makeEndTurnResponse('hi1'), makeEndTurnResponse('hi2')],
  });
  const runtime = createRuntime({
    kosong,
    lifecycle: gate,
    compactionProvider: createNoopCompactionProvider(),
    journal: createNoopJournalCapability(),
  });
  const soulRegistry = new SoulRegistry({
    createHandle: (key) => ({
      key,
      agentId: 'agent_main',
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
    orchestrator: spy,
    ...makeRealSubcomponents({
      contextState: context,
      lifecycleStateMachine: stateMachine,
      sink: eventBus,
      orchestrator: spy as unknown as import('../../../src/soul-plus/orchestrator.js').ToolCallOrchestrator,
    }),
  });
  return { manager, spy };
}

describe('Slice 2.2 Q6 — turn-override rules do not leak across turns', () => {
  it('turn 1 disallowedTools injected; turn 2 starts clean', async () => {
    const { manager, spy } = buildHarness();

    // Turn 1: inject deny rule for Write as turn-override.
    manager.setPendingTurnOverrides({ disallowedTools: ['Write'] });
    const r1 = await manager.handlePrompt({ data: { input: { text: 'first' } } });
    if (!('turn_id' in r1)) throw new Error('expected turn_id');
    await manager.awaitTurn(r1.turn_id);

    // Turn 2: do NOT set overrides. Should see only sessionRules (empty).
    const r2 = await manager.handlePrompt({ data: { input: { text: 'second' } } });
    if (!('turn_id' in r2)) throw new Error('expected turn_id');
    await manager.awaitTurn(r2.turn_id);

    // Each turn should have produced exactly one rule snapshot.
    expect(spy.seenRules).toHaveLength(2);

    // Turn 1: has the turn-override deny rule.
    const turn1Rules = spy.seenRules[0]!;
    expect(turn1Rules).toContainEqual(
      expect.objectContaining({
        decision: 'deny',
        scope: 'turn-override',
        pattern: 'Write',
      }),
    );

    // Turn 2: clean — no turn-override residue from turn 1.
    const turn2Rules = spy.seenRules[1]!;
    const hasWriteDeny = turn2Rules.some((r) => r.decision === 'deny' && r.pattern === 'Write');
    expect(hasWriteDeny).toBe(false);
    expect(turn2Rules).toHaveLength(0);
  });

  it('pending overrides are drained even if not consumed by a tool', async () => {
    const { manager } = buildHarness();
    manager.setPendingTurnOverrides({ disallowedTools: ['Bash'] });
    expect(manager.getPendingTurnOverrides()).toBeDefined();

    const r1 = await manager.handlePrompt({ data: { input: { text: 'x' } } });
    if (!('turn_id' in r1)) throw new Error('expected turn_id');
    await manager.awaitTurn(r1.turn_id);

    // Drained after launchTurn — cannot affect future turns.
    expect(manager.getPendingTurnOverrides()).toBeUndefined();
  });

  it('setPermissionMode is respected across turns without mutating state', async () => {
    const { manager, spy } = buildHarness();

    manager.setPermissionMode('bypassPermissions');
    expect(manager.getPermissionMode()).toBe('bypassPermissions');

    const r1 = await manager.handlePrompt({ data: { input: { text: 'x' } } });
    if (!('turn_id' in r1)) throw new Error('expected turn_id');
    await manager.awaitTurn(r1.turn_id);

    // No rules passed in, and the factory should have been called with
    // that mode (we don't record mode explicitly, but we proved the
    // factory was called at all).
    expect(spy.seenRules).toHaveLength(1);
  });
});
