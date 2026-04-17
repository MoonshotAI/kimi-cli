/**
 * Covers: `TurnManager.addTurnLifecycleListener` (Slice 4.2).
 *
 * Replaces the Slice 4.1 40 ms setInterval poll in the TUI bridge with
 * a synchronous observer that fires at two well-defined edges:
 *
 *   - `{kind:'begin'}` — inside `handlePrompt`, immediately after
 *     `transitionTo('active')` and before `launchTurn` kicks off the
 *     Soul loop. Carries the user input text and the TurnManager's
 *     agent type.
 *   - `{kind:'end'}` — inside `onTurnEnd`'s `finally`, AFTER the 3-hop
 *     drain lands on `idle`. Carries the settled reason, success, and
 *     accumulated usage when available.
 *
 * The observer is the backbone of Slice 4.2's "no more back-to-back
 * races" guarantee: consecutive prompts must see `end#N` strictly
 * before `begin#N+1`.
 */

import { describe, expect, it } from 'vitest';

import {
  SoulLifecycleGate,
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulRegistry,
  TurnManager,
  createRuntime,
  type TurnLifecycleEvent,
} from '../../src/soul-plus/index.js';
import type { Runtime, Tool } from '../../src/soul/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
} from './fixtures/slice3-harness.js';
import { makeRealSubcomponents } from './fixtures/real-subcomponents.js';

function buildManager(opts: {
  readonly kosong: ScriptedKosongAdapter;
  readonly tools?: readonly Tool[];
}): {
  manager: TurnManager;
  runtime: Runtime;
} {
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
    tools: opts.tools ?? [],
    ...makeRealSubcomponents({
      contextState: context,
      lifecycleStateMachine: stateMachine,
      sink: eventBus,
    }),
  });
  return { manager, runtime };
}

describe('TurnManager.addTurnLifecycleListener', () => {
  it('fires a begin event with the user input before the Soul turn runs', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('hi back')],
      delayMs: 50,
    });
    const { manager } = buildManager({ kosong });
    const events: TurnLifecycleEvent[] = [];
    manager.addTurnLifecycleListener((event) => events.push(event));

    const response = await manager.handlePrompt({ data: { input: { text: 'hi there' } } });
    if (!('turn_id' in response)) throw new Error('expected turn_id');

    // `begin` must have fired by now — handlePrompt is non-blocking so
    // the listener should already have observed it. `end` has not yet
    // fired because the Soul turn is still running.
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'begin',
      turnId: response.turn_id,
      userInput: 'hi there',
      inputKind: 'user',
      agentType: 'main',
    });
  });

  it('fires an end event after the Soul turn drains to idle', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done', { input: 5, output: 7 })],
    });
    const { manager } = buildManager({ kosong });
    const events: TurnLifecycleEvent[] = [];
    manager.addTurnLifecycleListener((event) => events.push(event));

    const response = await manager.handlePrompt({ data: { input: { text: 'go' } } });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);

    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('begin');
    const endEvent = events[1];
    if (endEvent?.kind !== 'end') throw new Error('expected end event');
    expect(endEvent.turnId).toBe(response.turn_id);
    expect(endEvent.reason).toBe('done');
    expect(endEvent.success).toBe(true);
    expect(endEvent.usage).toMatchObject({ input: 5, output: 7 });
  });

  it('back-to-back prompts see end#N strictly before begin#N+1 (no race)', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('first'), makeEndTurnResponse('second')],
    });
    const { manager } = buildManager({ kosong });
    const events: TurnLifecycleEvent[] = [];
    manager.addTurnLifecycleListener((event) => events.push(event));

    const first = await manager.handlePrompt({ data: { input: { text: 'first' } } });
    if (!('turn_id' in first)) throw new Error('expected turn_id');
    await manager.awaitTurn(first.turn_id);

    const second = await manager.handlePrompt({ data: { input: { text: 'second' } } });
    if (!('turn_id' in second)) throw new Error('expected turn_id');
    await manager.awaitTurn(second.turn_id);

    // Events must be emitted in strict order: b1 → e1 → b2 → e2.
    expect(events.map((e) => e.kind)).toEqual(['begin', 'end', 'begin', 'end']);
    // Each begin carries the matching turn_id.
    expect(events[0]?.turnId).toBe(first.turn_id);
    expect(events[1]?.turnId).toBe(first.turn_id);
    expect(events[2]?.turnId).toBe(second.turn_id);
    expect(events[3]?.turnId).toBe(second.turn_id);
  });

  it('unsubscribe handle stops further event delivery', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('ok')],
    });
    const { manager } = buildManager({ kosong });
    const events: TurnLifecycleEvent[] = [];
    const unsubscribe = manager.addTurnLifecycleListener((event) => events.push(event));
    unsubscribe();

    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);
    expect(events).toHaveLength(0);
  });

  it('listener throws are isolated and do not brick the turn', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('ok')],
    });
    const { manager } = buildManager({ kosong });
    const seen: TurnLifecycleEvent[] = [];
    manager.addTurnLifecycleListener(() => {
      throw new Error('boom');
    });
    manager.addTurnLifecycleListener((event) => {
      seen.push(event);
    });

    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);
    // The second listener still gets both events despite the first
    // listener throwing.
    expect(seen.map((e) => e.kind)).toEqual(['begin', 'end']);
  });
});
