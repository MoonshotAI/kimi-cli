/**
 * Covers: `TurnManager.handleCancel` abort path (v2 §5.2.2 / §5.9 / D17).
 *
 * Pins:
 *   - `handleCancel` aborts the in-flight turn AND awaits its drain
 *     before returning — matches the v2 §5.9.2 / D17 L2752-2764
 *     contract and the Python `soul/__init__.py:205-211` pattern
 *     `cancel(); await soul_task`. (Slice 3 audit M1.)
 *   - A Soul turn whose LLM call was aborted settles with stopReason
 *     `aborted` and the resulting `turn_end` record carries
 *     `reason:'cancelled'` + `success:false`.
 *   - Lifecycle returns to `idle` *before* `handleCancel` resolves, so
 *     the caller can immediately start a new turn without having to
 *     `awaitTurn` first.
 *   - Cancelling an unknown turn_id is a no-op (no crash).
 */

import { describe, expect, it } from 'vitest';

import {
  SoulLifecycleGate,
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
import { makeRealSubcomponents } from './fixtures/real-subcomponents.js';

function buildManager(kosong: ScriptedKosongAdapter): {
  manager: TurnManager;
  journal: InMemorySessionJournalImpl;
  stateMachine: SessionLifecycleStateMachine;
} {
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
    ...makeRealSubcomponents({
      contextState: context,
      lifecycleStateMachine: stateMachine,
      sink: eventBus,
    }),
  });
  return { manager, journal, stateMachine };
}

describe('TurnManager.handleCancel', () => {
  it('aborts an in-flight turn and the Soul turn settles with a cancelled turn_end', async () => {
    // delayMs makes the kosong call outlive the cancel, so the abort
    // signal races the pending promise.
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('never arrives')],
      delayMs: 50,
    });
    const { manager, journal, stateMachine } = buildManager(kosong);

    const started = await manager.handlePrompt({ data: { input: { text: 'long task' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');
    const { turn_id: turnId } = started;

    // Slice 3 audit M1: handleCancel must await the turn drain. After
    // it resolves, the turn_end record is already durable and the
    // lifecycle is already back to `idle` — NO extra `awaitTurn` is
    // needed to observe those post-conditions.
    const cancelled = await manager.handleCancel({ data: { turn_id: turnId } });
    expect(cancelled).toBeDefined();

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
      delayMs: 50,
    });
    const { manager, journal } = buildManager(kosong);

    const started = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');

    await manager.handleCancel({ data: {} });

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

  it('handleCancel awaits turn drain — caller can start a new turn immediately after it resolves', async () => {
    // Slice 3 audit M1: this is the regression guard for the old bug
    // where `handleCancel` only called `abort()` and returned. The
    // prior test asserted "cancel returns in < 100ms" (i.e. BEFORE the
    // turn drained), which locked in the wrong semantics. After the
    // fix, the caller must be able to issue a fresh `handlePrompt`
    // the moment `handleCancel` resolves.
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('first'), makeEndTurnResponse('second')],
      delayMs: 50,
    });
    const { manager, journal, stateMachine } = buildManager(kosong);

    const first = await manager.handlePrompt({ data: { input: { text: 'first' } } });
    if (!('turn_id' in first)) throw new Error('expected turn_id');

    await manager.handleCancel({ data: { turn_id: first.turn_id } });

    // Post-conditions observable synchronously after cancel resolves:
    // (a) lifecycle is back to idle
    expect(stateMachine.state).toBe('idle');
    // (b) turn_end has been persisted
    expect(journal.getRecordsByType('turn_end')).toHaveLength(1);
    // (c) a fresh prompt is accepted (no `agent_busy`)
    const second = await manager.handlePrompt({ data: { input: { text: 'second' } } });
    expect(second).toMatchObject({ status: 'started' });
    if ('turn_id' in second) {
      await manager.awaitTurn(second.turn_id);
    }
    expect(journal.getRecordsByType('turn_begin')).toHaveLength(2);
  });
});
