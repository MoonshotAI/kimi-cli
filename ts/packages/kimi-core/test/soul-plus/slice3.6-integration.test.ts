/**
 * Slice 3.6 integration tests — wiring between TurnManager /
 * NotificationManager and the new DynamicInjectionManager + lifecycle
 * hook events. Covers the M1 / M2 gaps flagged by reviewer:
 *
 *   M1 — `drainDynamicInjectionsIntoContext` fires inside `launchTurn`
 *        with the correct InjectionContext, and only when plan mode is
 *        actually on.
 *   M2 — `UserPromptSubmit` / `Stop` / `Notification` lifecycle hooks
 *        reach the HookEngine at their real trigger sites (handlePrompt
 *        / onTurnEnd / NotificationManager.emit) with the expected
 *        payload shape.
 *
 * These tests run a real TurnManager / NotificationManager with a real
 * HookEngine + scripted kosong adapter so the assertions pin the
 * observable contract, not an isolated unit's interface.
 */

import { describe, expect, it } from 'vitest';

import { HookEngine } from '../../src/hooks/engine.js';
import type {
  HookConfig,
  HookExecutor,
  HookInput,
  HookResult,
  NotificationInput,
  StopInput,
  UserPromptSubmitInput,
} from '../../src/hooks/types.js';
import {
  DynamicInjectionManager,
  SoulLifecycleGate,
  NotificationManager,
  PlanModeInjectionProvider,
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulRegistry,
  TurnManager,
  createRuntime,
} from '../../src/soul-plus/index.js';
import type { Runtime } from '../../src/soul/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
} from './fixtures/slice3-harness.js';
import { makeRealSubcomponents } from './fixtures/real-subcomponents.js';

// ── Helpers ────────────────────────────────────────────────────────────

interface HookCall {
  readonly hook: HookConfig;
  readonly input: HookInput;
}

function makeRecordingHookEngine(): { engine: HookEngine; calls: HookCall[] } {
  const calls: HookCall[] = [];
  const executor: HookExecutor = {
    type: 'command',
    async execute(hook, input): Promise<HookResult> {
      calls.push({ hook, input });
      return { ok: true };
    },
  };
  const engine = new HookEngine({
    executors: new Map([['command', executor]]),
  });
  return { engine, calls };
}

interface BuildOpts {
  readonly kosong: ScriptedKosongAdapter;
  readonly dynamicInjectionManager?: DynamicInjectionManager;
  readonly hookEngine?: HookEngine;
  readonly planMode?: boolean;
  readonly sessionId?: string;
}

function buildManager(opts: BuildOpts): {
  manager: TurnManager;
  context: ReturnType<typeof createHarnessContextState>;
  journal: InMemorySessionJournalImpl;
  stateMachine: SessionLifecycleStateMachine;
  eventBus: SessionEventBus;
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
    tools: [],
    sessionId: opts.sessionId ?? 'sess_test',
    planMode: opts.planMode ?? false,
    ...(opts.dynamicInjectionManager !== undefined
      ? { dynamicInjectionManager: opts.dynamicInjectionManager }
      : {}),
    ...(opts.hookEngine !== undefined ? { hookEngine: opts.hookEngine } : {}),
    ...makeRealSubcomponents({
      contextState: context,
      lifecycleStateMachine: stateMachine,
      sink: eventBus,
    }),
  });
  return { manager, context, journal, stateMachine, eventBus, runtime };
}

// ── M1: Dynamic injection wiring in launchTurn ─────────────────────────

describe('Slice 3.6 M1 — dynamic injection in launchTurn', () => {
  it('durably writes a plan-mode system_reminder when plan mode is on', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('ok')],
    });
    const dynamicInjectionManager = new DynamicInjectionManager({
      initialProviders: [new PlanModeInjectionProvider()],
    });
    const { manager, context } = buildManager({
      kosong,
      dynamicInjectionManager,
      planMode: true,
    });

    const response = await manager.handlePrompt({
      data: { input: { text: 'hi' } },
    });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);

    // Phase 1: the PlanMode provider writes durably via
    // appendSystemReminder. Verify the content appears in
    // buildMessages() output.
    const messages = context.buildMessages();
    const joined = messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(joined).toContain('Plan mode is active');
    expect(joined).toContain('<system-reminder>');

    // Sanity — the injection was also visible to the Soul turn's
    // LLM call via the normal buildMessages path.
    const userMessages = kosong.calls[0]?.messages.filter((m) => m.role === 'user') ?? [];
    const kosongJoined = userMessages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(kosongJoined).toContain('Plan mode is active');
    expect(kosongJoined).toContain('<system-reminder>');
  });

  it('writes nothing when plan mode is off (no-op path)', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('ok')],
    });
    const dynamicInjectionManager = new DynamicInjectionManager({
      initialProviders: [new PlanModeInjectionProvider()],
    });
    const { manager, context } = buildManager({
      kosong,
      dynamicInjectionManager,
      planMode: false,
    });

    const response = await manager.handlePrompt({
      data: { input: { text: 'hi' } },
    });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);

    // No plan-mode system_reminder should appear in buildMessages().
    const messages = context.buildMessages();
    const joined = messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(joined).not.toContain('Plan mode is active');
  });

  it('reads the live plan-mode flag via setPlanMode between turns', async () => {
    // Second turn only sees the injection if `setPlanMode(true)` between
    // turn 1 and turn 2 is honored — pins the TurnManager.setPlanMode
    // fan-out that SessionControl relies on.
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('first'), makeEndTurnResponse('second')],
    });
    const dynamicInjectionManager = new DynamicInjectionManager({
      initialProviders: [new PlanModeInjectionProvider()],
    });
    const { manager, context } = buildManager({
      kosong,
      dynamicInjectionManager,
      planMode: false,
    });

    const r1 = await manager.handlePrompt({ data: { input: { text: 'first' } } });
    if (!('turn_id' in r1)) throw new Error('expected turn_id');
    await manager.awaitTurn(r1.turn_id);

    // After turn 1 with plan mode off: no plan-mode reminder in history.
    const messagesAfterT1 = context.buildMessages();
    const joinedT1 = messagesAfterT1
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(joinedT1).not.toContain('Plan mode is active');

    manager.setPlanMode(true);

    const r2 = await manager.handlePrompt({ data: { input: { text: 'second' } } });
    if (!('turn_id' in r2)) throw new Error('expected turn_id');
    await manager.awaitTurn(r2.turn_id);

    // After turn 2 with plan mode on: plan-mode reminder should now appear.
    const messagesAfterT2 = context.buildMessages();
    const joinedT2 = messagesAfterT2
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(joinedT2).toContain('Plan mode is active');
  });
});

// ── M2: Lifecycle hook triggers ────────────────────────────────────────

describe('Slice 3.6 M2 — lifecycle hook trigger sites', () => {
  it('dispatches UserPromptSubmit on handlePrompt with the prompt text', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('ok')],
    });
    const { engine, calls } = makeRecordingHookEngine();
    engine.register({ type: 'command', event: 'UserPromptSubmit', command: 'noop' });

    const { manager } = buildManager({ kosong, hookEngine: engine, sessionId: 'sess_ups' });

    const response = await manager.handlePrompt({
      data: { input: { text: 'hello world' } },
    });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);

    const upsCalls = calls.filter((c) => c.input.event === 'UserPromptSubmit');
    expect(upsCalls).toHaveLength(1);
    const input = upsCalls[0]?.input as UserPromptSubmitInput;
    expect(input.prompt).toBe('hello world');
    expect(input.sessionId).toBe('sess_ups');
    expect(input.turnId).toBe(response.turn_id);
    expect(input.agentId).toBe('agent_main');
  });

  it('UserPromptSubmit matcher filters on the prompt text', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('ok'), makeEndTurnResponse('ok2')],
    });
    const { engine, calls } = makeRecordingHookEngine();
    // Matcher only matches prompts starting with "deploy".
    engine.register({
      type: 'command',
      event: 'UserPromptSubmit',
      command: 'noop',
      matcher: '^deploy',
    });

    const { manager } = buildManager({ kosong, hookEngine: engine });

    const r1 = await manager.handlePrompt({
      data: { input: { text: 'hello world' } },
    });
    if (!('turn_id' in r1)) throw new Error('expected turn_id');
    await manager.awaitTurn(r1.turn_id);
    expect(calls.filter((c) => c.input.event === 'UserPromptSubmit')).toHaveLength(0);

    const r2 = await manager.handlePrompt({
      data: { input: { text: 'deploy now' } },
    });
    if (!('turn_id' in r2)) throw new Error('expected turn_id');
    await manager.awaitTurn(r2.turn_id);
    expect(calls.filter((c) => c.input.event === 'UserPromptSubmit')).toHaveLength(1);
  });

  it('dispatches Stop after onTurnEnd with reason="done"', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('ok')],
    });
    const { engine, calls } = makeRecordingHookEngine();
    engine.register({ type: 'command', event: 'Stop', command: 'noop' });

    const { manager } = buildManager({ kosong, hookEngine: engine, sessionId: 'sess_stop' });

    const response = await manager.handlePrompt({
      data: { input: { text: 'hi' } },
    });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);
    // Fire-and-forget — yield one microtask tick so the dispatched
    // hook has a chance to settle before assertion.
    await new Promise<void>((r) => setImmediate(r));

    const stopCalls = calls.filter((c) => c.input.event === 'Stop');
    expect(stopCalls).toHaveLength(1);
    const input = stopCalls[0]?.input as StopInput;
    expect(input.reason).toBe('done');
    expect(input.sessionId).toBe('sess_stop');
    expect(input.turnId).toBe(response.turn_id);
  });

  it('Stop matcher filters on the reason string', async () => {
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('ok')],
    });
    const { engine, calls } = makeRecordingHookEngine();
    // Only fire on reason === error (so this happy-path turn should NOT match).
    engine.register({
      type: 'command',
      event: 'Stop',
      command: 'noop',
      matcher: '^error$',
    });

    const { manager } = buildManager({ kosong, hookEngine: engine });

    const response = await manager.handlePrompt({
      data: { input: { text: 'hi' } },
    });
    if (!('turn_id' in response)) throw new Error('expected turn_id');
    await manager.awaitTurn(response.turn_id);
    await new Promise<void>((r) => setImmediate(r));

    expect(calls.filter((c) => c.input.event === 'Stop')).toHaveLength(0);
  });

  it('dispatches Notification after NotificationManager three-way fan-out', async () => {
    const { engine, calls } = makeRecordingHookEngine();
    engine.register({ type: 'command', event: 'Notification', command: 'noop' });

    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const llmSeen: string[] = [];
    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: (n) => llmSeen.push(n.id),
      hookEngine: engine,
      sessionId: 'sess_notif',
      agentId: 'agent_main',
      currentTurnId: () => 'turn_42',
    });

    await manager.emit({
      category: 'task',
      type: 'task.succeeded',
      source_kind: 'bg',
      source_id: 'bg_1',
      title: 'done',
      body: 'build passed',
      severity: 'success',
    });

    // Fire-and-forget — let the hook dispatch microtask settle.
    await new Promise<void>((r) => setImmediate(r));

    expect(llmSeen).toHaveLength(1);
    const notifCalls = calls.filter((c) => c.input.event === 'Notification');
    expect(notifCalls).toHaveLength(1);
    const input = notifCalls[0]?.input as NotificationInput;
    expect(input.notificationType).toBe('task.succeeded');
    expect(input.sessionId).toBe('sess_notif');
    expect(input.turnId).toBe('turn_42');
    expect(input.title).toBe('done');
    expect(input.body).toBe('build passed');
    expect(input.severity).toBe('success');
  });

  it('Notification matcher filters on notificationType', async () => {
    const { engine, calls } = makeRecordingHookEngine();
    engine.register({
      type: 'command',
      event: 'Notification',
      command: 'noop',
      matcher: '^approval\\.',
    });

    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {
        /* noop */
      },
      hookEngine: engine,
      sessionId: 'sess_notif',
    });

    await manager.emit({
      category: 'task',
      type: 'task.succeeded',
      source_kind: 'bg',
      source_id: 'bg_1',
      title: 't',
      body: 'b',
      severity: 'info',
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(calls.filter((c) => c.input.event === 'Notification')).toHaveLength(0);

    await manager.emit({
      category: 'task',
      type: 'approval.request',
      source_kind: 'tool',
      source_id: 'tool_1',
      title: 't',
      body: 'b',
      severity: 'warning',
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(calls.filter((c) => c.input.event === 'Notification')).toHaveLength(1);
  });
});
