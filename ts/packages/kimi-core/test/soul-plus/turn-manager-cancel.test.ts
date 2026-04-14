/**
 * Covers: `TurnManager.handleCancel` abort path (v2 §5.2.2 / §5.9).
 *
 * Pins:
 *   - `handleCancel` synchronously triggers the in-flight turn's
 *     AbortController.
 *   - A Soul turn whose LLM call was aborted settles with stopReason
 *     `aborted` and the resulting `turn_end` record carries
 *     `reason:'cancelled'` + `success:false`.
 *   - Lifecycle returns to `idle` after the cancelled turn drains.
 *   - Cancelling an unknown turn_id is a no-op (no crash).
 */

import { describe, expect, it } from 'vitest';

import {
  LifecycleGateFacade,
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulRegistry,
  TurnManager,
  createRuntime,
} from '../../src/soul-plus/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
} from './fixtures/slice3-harness.js';

function buildManager(kosong: ScriptedKosongAdapter): {
  manager: TurnManager;
  journal: InMemorySessionJournalImpl;
  stateMachine: SessionLifecycleStateMachine;
} {
  const stateMachine = new SessionLifecycleStateMachine();
  const gate = new LifecycleGateFacade(stateMachine);
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
  });
  return { manager, journal, stateMachine };
}

describe('TurnManager.handleCancel', () => {
  it('aborts an in-flight turn and the Soul turn settles with a cancelled turn_end', async () => {
    // delayMs makes the kosong call outlive the cancel, so the abort
    // signal races the pending promise.
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('never arrives')],
      delayMs: 500,
    });
    const { manager, journal, stateMachine } = buildManager(kosong);

    const started = await manager.handlePrompt({ data: { input: { text: 'long task' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');
    const { turn_id: turnId } = started;

    const cancelled = await manager.handleCancel({ data: { turn_id: turnId } });
    expect(cancelled).toBeDefined();

    await manager.awaitTurn(turnId);

    const ends = journal.getRecordsByType('turn_end');
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (!end) throw new Error('expected a turn_end record');
    expect(end.turn_id).toBe(turnId);
    expect(end.reason).toBe('cancelled');
    expect(end.success).toBe(false);

    expect(stateMachine.state).toBe('idle');
  });

  it('cancel without turn_id targets the most-recent turn', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('never')],
      delayMs: 500,
    });
    const { manager, journal } = buildManager(kosong);

    const started = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');
    const { turn_id: turnId } = started;

    await manager.handleCancel({ data: {} });
    await manager.awaitTurn(turnId);

    const end = journal.getRecordsByType('turn_end')[0];
    expect(end?.reason).toBe('cancelled');
  });

  it('cancelling an unknown turn_id is a no-op (no throw)', async () => {
    const kosong = new ScriptedKosongAdapter({ responses: [] });
    const { manager } = buildManager(kosong);
    await expect(manager.handleCancel({ data: { turn_id: 'turn_999' } })).resolves.toBeDefined();
  });

  it('cancelling when no turn is active is a no-op', async () => {
    const kosong = new ScriptedKosongAdapter({ responses: [] });
    const { manager, stateMachine } = buildManager(kosong);
    expect(stateMachine.state).toBe('idle');
    await expect(manager.handleCancel({ data: {} })).resolves.toBeDefined();
    expect(stateMachine.state).toBe('idle');
  });

  it('handleCancel returns synchronously in the happy path (no I/O required)', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('never')],
      delayMs: 500,
    });
    const { manager } = buildManager(kosong);
    const started = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');

    const t0 = Date.now();
    await manager.handleCancel({ data: { turn_id: started.turn_id } });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(100);

    await manager.awaitTurn(started.turn_id);
  });
});
