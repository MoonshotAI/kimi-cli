/**
 * Covers: `TurnManager.handleSteer` → `FullContextState.pushSteer`
 * (v2 §5.2.2 / Slice 1 decision #6).
 *
 * Slice 3 scope: steer buffer ingress only. The Soul-side drain was
 * already tested in Slice 2 (`test/soul/steer.test.ts`). Here we verify
 * that TurnManager does NOT call `addUserMessages` (which would race
 * against a running Soul's `buildMessages()`), and instead pushes into
 * the steer buffer for the next step's drain.
 *
 * §6 偏离清单 (2026-04-14, Slice 3): v2 §5.2.2 L2031 伪代码 wrote
 * `addUserMessages` — we diverge for the race-safety reason above.
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
import type { FullContextState, UserInput } from '../../src/storage/context-state.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
} from './fixtures/slice3-harness.js';
import { makeRealSubcomponents } from './fixtures/real-subcomponents.js';

/**
 * A tiny `FullContextState` recorder that tracks whether `pushSteer` or
 * `addUserMessages` was called. Wraps a real `InMemoryContextState` so
 * the behaviour under test (state, reads, turn execution) is unchanged.
 */
class RecordingContextState implements FullContextState {
  readonly pushSteerCalls: UserInput[] = [];
  readonly addUserMessagesCalls: UserInput[][] = [];

  constructor(private readonly inner: FullContextState) {}

  get journalWriter(): FullContextState['journalWriter'] {
    return this.inner.journalWriter;
  }
  get model(): string {
    return this.inner.model;
  }
  get systemPrompt(): string {
    return this.inner.systemPrompt;
  }
  get activeTools(): ReadonlySet<string> {
    return this.inner.activeTools;
  }
  get tokenCountWithPending(): number {
    return this.inner.tokenCountWithPending;
  }
  buildMessages(): ReturnType<FullContextState['buildMessages']> {
    return this.inner.buildMessages();
  }
  drainSteerMessages(): UserInput[] {
    return this.inner.drainSteerMessages();
  }
  pushSteer(input: UserInput): void {
    this.pushSteerCalls.push({ ...input });
    this.inner.pushSteer(input);
  }
  appendNotification(...args: Parameters<FullContextState['appendNotification']>): Promise<void> {
    return this.inner.appendNotification(...args);
  }
  appendSystemReminder(...args: Parameters<FullContextState['appendSystemReminder']>): Promise<void> {
    return this.inner.appendSystemReminder(...args);
  }
  getHistory(): ReturnType<FullContextState['getHistory']> {
    return this.inner.getHistory();
  }
  appendUserMessage(...args: Parameters<FullContextState['appendUserMessage']>): Promise<void> {
    return this.inner.appendUserMessage(...args);
  }
  appendAssistantMessage(
    ...args: Parameters<FullContextState['appendAssistantMessage']>
  ): Promise<void> {
    return this.inner.appendAssistantMessage(...args);
  }
  appendToolResult(...args: Parameters<FullContextState['appendToolResult']>): Promise<void> {
    return this.inner.appendToolResult(...args);
  }
  async addUserMessages(steers: UserInput[]): Promise<void> {
    this.addUserMessagesCalls.push([...steers]);
    await this.inner.addUserMessages(steers);
  }
  applyConfigChange(...args: Parameters<FullContextState['applyConfigChange']>): Promise<void> {
    return this.inner.applyConfigChange(...args);
  }
  resetToSummary(...args: Parameters<FullContextState['resetToSummary']>): Promise<void> {
    return this.inner.resetToSummary(...args);
  }
  setBeforeStepHook(fn: (() => void) | undefined): void {
    this.inner.setBeforeStepHook(fn);
  }
  get beforeStep(): (() => void) | undefined {
    return this.inner.beforeStep;
  }
}

function buildManager(kosong: ScriptedKosongAdapter): {
  manager: TurnManager;
  context: RecordingContextState;
  stateMachine: SessionLifecycleStateMachine;
} {
  const stateMachine = new SessionLifecycleStateMachine();
  const gate = new SoulLifecycleGate(stateMachine);
  const context = new RecordingContextState(createHarnessContextState());
  const journal = new InMemorySessionJournalImpl();
  const eventBus = new SessionEventBus();
  const runtime = createRuntime({
    kosong,
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
    tools: [],
    ...makeRealSubcomponents({
      contextState: context,
      lifecycleStateMachine: stateMachine,
      sink: eventBus,
    }),
  });
  return { manager, context, stateMachine };
}

describe('TurnManager.handleSteer', () => {
  it('calls FullContextState.pushSteer with the steer input', async () => {
    const kosong = new ScriptedKosongAdapter({ responses: [] });
    const { manager, context } = buildManager(kosong);

    await manager.handleSteer({ data: { input: { text: 'please focus on foo' } } });

    expect(context.pushSteerCalls).toHaveLength(1);
    expect(context.pushSteerCalls[0]).toEqual({ text: 'please focus on foo' });
  });

  it('does NOT call addUserMessages (race-safety vs Soul buildMessages)', async () => {
    const kosong = new ScriptedKosongAdapter({ responses: [] });
    const { manager, context } = buildManager(kosong);

    await manager.handleSteer({ data: { input: { text: 'steer 1' } } });
    await manager.handleSteer({ data: { input: { text: 'steer 2' } } });

    expect(context.addUserMessagesCalls).toHaveLength(0);
    expect(context.pushSteerCalls).toHaveLength(2);
  });

  it('does not start a new turn (lifecycle stays idle)', async () => {
    const kosong = new ScriptedKosongAdapter({ responses: [] });
    const { manager, stateMachine } = buildManager(kosong);

    expect(stateMachine.state).toBe('idle');
    await manager.handleSteer({ data: { input: { text: 'hi' } } });
    expect(stateMachine.state).toBe('idle');
  });

  it('pushes multiple steers in order — drain next step sees them FIFO', async () => {
    const kosong = new ScriptedKosongAdapter({ responses: [] });
    const { manager, context } = buildManager(kosong);

    await manager.handleSteer({ data: { input: { text: 'a' } } });
    await manager.handleSteer({ data: { input: { text: 'b' } } });
    await manager.handleSteer({ data: { input: { text: 'c' } } });

    // drain order must match push order — FIFO semantics are part of
    // the §4.5.2 contract and the Slice 2 drain tests already pin
    // Soul's side. Here we pin the TurnManager side.
    const drained = context.drainSteerMessages();
    expect(drained.map((m) => m.text)).toEqual(['a', 'b', 'c']);
  });

  it('handleSteer during an active turn pushes into the buffer for next drain (race-safe)', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('end')],
      delayMs: 100,
    });
    const { manager, context } = buildManager(kosong);

    const started = await manager.handlePrompt({ data: { input: { text: 'start turn' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');

    // steer arrives while the Soul turn is still in-flight
    await manager.handleSteer({ data: { input: { text: 'mid-flight steer' } } });
    // pushSteer must have been invoked immediately
    expect(context.pushSteerCalls.some((i) => i.text === 'mid-flight steer')).toBe(true);
    // addUserMessages must NOT have been invoked from the steer path
    // (appendUserMessage from the initial user prompt is a different path)
    expect(context.addUserMessagesCalls).toHaveLength(0);

    await manager.awaitTurn(started.turn_id);
  });
});
