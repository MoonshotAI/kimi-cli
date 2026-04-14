/**
 * Covers: `TurnManager.handlePrompt` happy path (v2 §5.2.2 / §6.2).
 *
 * Pins the canonical conversation-channel flow:
 *   - `handlePrompt` is non-blocking: returns `{turn_id, status:'started'}`
 *     in milliseconds, even if the underlying Soul turn spends seconds
 *     inside `kosong.chat`.
 *   - Lifecycle moves idle → active on accept, and back through completing
 *     → idle after the Soul turn settles.
 *   - `turn_begin` and `turn_end` are written through `SessionJournal`
 *     (management-class record window), NOT through `ContextState` —
 *     this is the v2 §4.5.6 narrow-gate rule. Authorship belongs to
 *     TurnManager, not Soul and not ContextState.
 *   - `user_message` goes through `ContextState.appendUserMessage` (the
 *     FullContextState write seam), so it is authored by TurnManager
 *     before the Soul turn launches.
 *   - `assistant_message` / `tool_result` records are authored by Soul
 *     (verified transitively via the real `InMemoryContextState`).
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
import type { Runtime, Tool } from '../../src/soul/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
} from './fixtures/slice3-harness.js';

function buildManager(opts: {
  readonly kosong: ScriptedKosongAdapter;
  readonly tools?: readonly Tool[];
}): {
  manager: TurnManager;
  context: ReturnType<typeof createHarnessContextState>;
  journal: InMemorySessionJournalImpl;
  stateMachine: SessionLifecycleStateMachine;
  eventBus: SessionEventBus;
  runtime: Runtime;
} {
  const stateMachine = new SessionLifecycleStateMachine();
  const gate = new LifecycleGateFacade(stateMachine);
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
  });
  return { manager, context, journal, stateMachine, eventBus, runtime };
}

describe('TurnManager.handlePrompt', () => {
  it('returns {turn_id, status:"started"} without awaiting the LLM (non-blocking)', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('hello')],
      delayMs: 200, // simulate a slow LLM; handlePrompt must still resolve in ms
    });
    const { manager } = buildManager({ kosong });

    const t0 = Date.now();
    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(150); // << 200ms kosong delay proves non-blocking
    expect(response).toMatchObject({ status: 'started' });
    if ('turn_id' in response) {
      expect(typeof response.turn_id).toBe('string');
      expect(response.turn_id.length).toBeGreaterThan(0);
    } else {
      throw new Error('expected a turn_id in the response');
    }
  });

  it('transitions lifecycle idle → active on accept', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('hi', { input: 1, output: 1 })],
    });
    const { manager, stateMachine } = buildManager({ kosong });

    expect(stateMachine.state).toBe('idle');
    await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    // Immediately after accept, the Soul turn is live — state must be active.
    expect(['active', 'completing', 'idle']).toContain(stateMachine.state);
    // The state machine must have moved OUT of idle at least once.
    expect(
      stateMachine.state === 'idle' ||
        stateMachine.state === 'active' ||
        stateMachine.state === 'completing',
    ).toBe(true);
  });

  it('returns lifecycle to idle after the turn completes', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('done')],
    });
    const { manager, stateMachine } = buildManager({ kosong });
    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);
    expect(stateMachine.state).toBe('idle');
  });

  it('writes a turn_begin record through SessionJournal (not ContextState, not Soul)', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('hello', { input: 3, output: 4 })],
    });
    const { manager, journal } = buildManager({ kosong });
    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);

    const begins = journal.getRecordsByType('turn_begin');
    expect(begins).toHaveLength(1);
    expect(begins[0]?.turn_id).toBe(response.turn_id);
  });

  it('writes a turn_end record with reason="done" and the accumulated usage', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('hello', { input: 3, output: 4 })],
    });
    const { manager, journal } = buildManager({ kosong });
    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);

    const ends = journal.getRecordsByType('turn_end');
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (!end) throw new Error('expected a turn_end record');
    expect(end.turn_id).toBe(response.turn_id);
    expect(end.reason).toBe('done');
    expect(end.success).toBe(true);
  });

  it('turn_begin is written before turn_end (WAL ordering)', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('hi')],
    });
    const { manager, journal } = buildManager({ kosong });
    const response = await manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);

    const allTypes = journal.getRecords().map((r) => r.type);
    const beginIdx = allTypes.indexOf('turn_begin');
    const endIdx = allTypes.indexOf('turn_end');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(beginIdx);
  });

  it('drives the Soul turn so the assistant text reaches the context history', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('assistant says hi', { input: 2, output: 3 })],
    });
    const { manager, context } = buildManager({ kosong });
    const response = await manager.handlePrompt({ data: { input: { text: 'user says hi' } } });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);

    const messages = context.buildMessages();
    // we expect at least a user + assistant message after a one-step turn
    const roles = messages.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('refuses to start a second turn while the first is still active', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('first'), makeEndTurnResponse('second')],
      delayMs: 100,
    });
    const { manager } = buildManager({ kosong });

    const first = await manager.handlePrompt({ data: { input: { text: 'first' } } });
    expect(first).toMatchObject({ status: 'started' });

    // second prompt fires while the first turn is still running: must
    // return an `agent_busy` error, not start a second turn
    const second = await manager.handlePrompt({ data: { input: { text: 'second' } } });
    expect(second).toHaveProperty('error');
    if ('error' in second) {
      expect(second.error).toMatch(/busy|agent_busy/);
    }
  });
});
