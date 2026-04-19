/**
 * Slice 5 / 决策 #96 (L3): TurnManager reactive recovery from
 * ContextOverflowError thrown by Soul's runtime layer.
 *
 * Pins (v2 §6.4 runTurn catch):
 *   - When `runSoulTurn` throws `ContextOverflowError`, TurnManager must
 *     behave exactly like the `needs_compaction` branch:
 *       compactionCount += 1
 *       if (compactionCount > MAX_COMPACTIONS_PER_TURN) → session.error +
 *         stopReason='error'; break
 *       else → executeCompaction(signal) + retry runSoulTurn on the same
 *         turn_id.
 *   - ContextOverflowError and `needs_compaction` share the SAME
 *     compactionCount counter. Mixing them (e.g. 2× needs_compaction then
 *     2× ContextOverflowError) still trips the circuit breaker at 4 total
 *     rounds, not at 4-of-each.
 *
 * This file is the mirror image of turn-manager-compaction-loop.test.ts
 * for the overflow path.
 *
 * Expected to FAIL before Phase 5: runTurn's catch block currently
 * collapses any throw into `reason='error'` without attempting compaction;
 * ContextOverflowError itself does not even exist yet.
 */

import type { Message } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type {
  CompactionOptions,
  CompactionProvider,
  JournalCapability,
  KosongAdapter,
  Runtime,
  SummaryMessage,
  TurnResult,
} from '../../src/soul/index.js';
import { ContextOverflowError } from '../../src/soul/errors.js';
import {
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulLifecycleGate,
  SoulRegistry,
  TurnManager,
} from '../../src/soul-plus/index.js';
import type { TurnManagerDeps } from '../../src/soul-plus/index.js';
import {
  CompactionOrchestrator,
  STATIC_DEFAULT_RUNTIME_STATE,
  STATIC_NO_PENDING_TURN,
} from '../../src/soul-plus/compaction-orchestrator.js';
import { PermissionClosureBuilder } from '../../src/soul-plus/permission-closure-builder.js';
import { TurnLifecycleTracker } from '../../src/soul-plus/turn-lifecycle-tracker.js';
import { WakeQueueScheduler } from '../../src/soul-plus/wake-queue-scheduler.js';
import { InMemoryContextState } from '../../src/storage/context-state.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';

vi.mock('../../src/soul/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/soul/index.js')>();
  return {
    ...mod,
    runSoulTurn: vi.fn(),
  };
});

// ── spies / fakes ─────────────────────────────────────────────────────

const noopKosong: KosongAdapter = {
  async chat() {
    throw new Error('kosong.chat should not be reached — runSoulTurn is mocked');
  },
};

function makeSpyCompactionProvider(): CompactionProvider & {
  calls: { messagesLength: number; options: CompactionOptions | undefined }[];
} {
  const calls: { messagesLength: number; options: CompactionOptions | undefined }[] = [];
  return {
    calls,
    async run(messages: Message[], _s, options) {
      calls.push({ messagesLength: messages.length, options });
      const summary: SummaryMessage = { content: 'compacted', original_turn_count: 1 };
      return summary;
    },
  };
}

function makeSpyJournalCapability(): JournalCapability & { rotations: unknown[] } {
  const rotations: unknown[] = [];
  return {
    rotations,
    async rotate(record) {
      rotations.push(record);
      return { archiveFile: `wire.${rotations.length}.jsonl` };
    },
    async readSessionInitialized() {
      return {
        type: 'session_initialized',
        seq: 1,
        time: 0,
        agent_type: 'main',
        session_id: 'ses_test',
        system_prompt: '',
        model: 'test-model',
        active_tools: [],
        permission_mode: 'default',
        plan_mode: false,
        workspace_dir: '/tmp/ws',
      };
    },
    async appendBoundary() {
      // no-op
    },
  };
}

interface Harness {
  manager: TurnManager;
  stateMachine: SessionLifecycleStateMachine;
  compactionProvider: ReturnType<typeof makeSpyCompactionProvider>;
  journalCapability: ReturnType<typeof makeSpyJournalCapability>;
  sinkEmitSpy: ReturnType<typeof vi.fn>;
}

function buildHarness(): Harness {
  const stateMachine = new SessionLifecycleStateMachine();
  const gateFacade = new SoulLifecycleGate(stateMachine);
  const contextState = new InMemoryContextState({ initialModel: 'test-model' });
  const sessionJournal = new InMemorySessionJournalImpl();
  const sink = new SessionEventBus();
  const sinkEmitSpy = vi.fn(sink.emit.bind(sink));
  (sink as unknown as { emit: typeof sinkEmitSpy }).emit = sinkEmitSpy;

  const compactionProvider = makeSpyCompactionProvider();
  const journalCapability = makeSpyJournalCapability();
  const runtime = {
    kosong: noopKosong,
    compactionProvider,
    lifecycle: gateFacade,
    journal: journalCapability,
  } as unknown as Runtime;

  const soulRegistry = new SoulRegistry({
    createHandle: (key, agentDepth) => ({
      key,
      agentId: 'agent_main',
      abortController: new AbortController(),
      agentDepth,
    }),
  });

  const compaction = new CompactionOrchestrator({
    contextState,
    compactionProvider,
    lifecycleStateMachine: stateMachine,
    journalCapability,
    sink,
    journalWriter: contextState.journalWriter,
    runtimeStateProvider: STATIC_DEFAULT_RUNTIME_STATE,
    getPendingTurnId: STATIC_NO_PENDING_TURN,
  });
  const permissionBuilder = new PermissionClosureBuilder({});
  const lifecycle = new TurnLifecycleTracker();
  const wakeScheduler = new WakeQueueScheduler();

  const deps = {
    contextState,
    sessionJournal,
    runtime,
    sink,
    lifecycleStateMachine: stateMachine,
    soulRegistry,
    tools: [],
    compaction,
    permissionBuilder,
    lifecycle,
    wakeScheduler,
  } as unknown as TurnManagerDeps;

  const manager = new TurnManager(deps);
  return { manager, stateMachine, compactionProvider, journalCapability, sinkEmitSpy };
}

function zeroUsage(): TurnResult['usage'] {
  return { input: 0, output: 0 };
}

function endTurnResult(): TurnResult {
  return { stopReason: 'end_turn', steps: 1, usage: zeroUsage() };
}

function needsCompactionResult(): TurnResult {
  return {
    stopReason: 'needs_compaction' as TurnResult['stopReason'],
    steps: 0,
    usage: zeroUsage(),
  };
}

// ── tests ─────────────────────────────────────────────────────────────

describe('TurnManager — Overflow L3 reactive recovery (决策 #96)', () => {
  it('ContextOverflowError from Soul → executeCompaction → retry → end_turn', async () => {
    const mockedRunSoulTurn = vi.mocked(runSoulTurn);
    mockedRunSoulTurn.mockReset();
    mockedRunSoulTurn.mockRejectedValueOnce(new ContextOverflowError('input too large'));
    mockedRunSoulTurn.mockResolvedValueOnce(endTurnResult());

    const h = buildHarness();
    const started = await h.manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');
    const finalResult = await h.manager.awaitTurn(started.turn_id);

    // Soul invoked twice: throw → compact → retry (normal end_turn).
    expect(mockedRunSoulTurn).toHaveBeenCalledTimes(2);
    expect(h.compactionProvider.calls.length).toBe(1);
    expect(h.journalCapability.rotations.length).toBe(1);
    expect(finalResult?.stopReason).toBe('end_turn');

    // No session.error in this recovery path.
    const errorEmits = h.sinkEmitSpy.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === 'session.error',
    );
    expect(errorEmits.length).toBe(0);
  });

  it('4 consecutive ContextOverflowErrors → compaction fires 3 times → session.error + stopReason=error', async () => {
    const mockedRunSoulTurn = vi.mocked(runSoulTurn);
    mockedRunSoulTurn.mockReset();
    mockedRunSoulTurn.mockRejectedValue(new ContextOverflowError('overflow'));

    const h = buildHarness();
    const started = await h.manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');
    const finalResult = await h.manager.awaitTurn(started.turn_id);

    // 4 calls total: 3 compaction rounds + 1 past-limit rejection.
    expect(mockedRunSoulTurn).toHaveBeenCalledTimes(4);
    expect(h.compactionProvider.calls.length).toBe(3);
    expect(h.journalCapability.rotations.length).toBe(3);

    const sessionErrors = h.sinkEmitSpy.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === 'session.error',
    );
    expect(sessionErrors.length).toBe(1);
    const payload = sessionErrors[0]?.[0] as { error_type?: string };
    expect(payload.error_type).toBe('context_overflow');
    expect(finalResult?.stopReason).toBe('error');
    expect(h.stateMachine.isIdle()).toBe(true);
  });

  it('mixed 2× needs_compaction then 2× ContextOverflowError share the MAX_COMPACTIONS_PER_TURN=3 counter', async () => {
    const mockedRunSoulTurn = vi.mocked(runSoulTurn);
    mockedRunSoulTurn.mockReset();
    mockedRunSoulTurn.mockResolvedValueOnce(needsCompactionResult()); // count → 1
    mockedRunSoulTurn.mockResolvedValueOnce(needsCompactionResult()); // count → 2
    mockedRunSoulTurn.mockRejectedValueOnce(new ContextOverflowError('x')); // count → 3
    mockedRunSoulTurn.mockRejectedValueOnce(new ContextOverflowError('x')); // count → 4 → trip

    const h = buildHarness();
    const started = await h.manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');
    const finalResult = await h.manager.awaitTurn(started.turn_id);

    // 4 Soul entries total, 3 executeCompaction calls, then trip.
    expect(mockedRunSoulTurn).toHaveBeenCalledTimes(4);
    expect(h.compactionProvider.calls.length).toBe(3);
    expect(finalResult?.stopReason).toBe('error');
    const errs = h.sinkEmitSpy.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === 'session.error',
    );
    expect(errs.length).toBe(1);
  });

  it('non-ContextOverflow errors do NOT trigger recovery — turn fails outright', async () => {
    const mockedRunSoulTurn = vi.mocked(runSoulTurn);
    mockedRunSoulTurn.mockReset();
    mockedRunSoulTurn.mockRejectedValue(new Error('some other failure'));

    const h = buildHarness();
    const started = await h.manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');
    const finalResult = await h.manager.awaitTurn(started.turn_id);

    // Soul called exactly once — no retry attempt.
    expect(mockedRunSoulTurn).toHaveBeenCalledTimes(1);
    expect(h.compactionProvider.calls.length).toBe(0);
    // Turn reports error per existing (pre-Phase-5) contract; details
    // (whether it is undefined vs stopReason='error') are Implementer-
    // owned. We only pin that NO executeCompaction happened.
    expect(finalResult?.stopReason === 'error' || finalResult === undefined).toBe(true);
  });
});
