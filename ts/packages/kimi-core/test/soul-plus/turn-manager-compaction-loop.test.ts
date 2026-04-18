/**
 * Phase 2 (Slice 2) — TurnManager runTurn while-loop for `needs_compaction`
 * + triggerCompaction adaptation.
 *
 * Pins the NEW TurnManager semantics introduced by the Phase 2 refactor:
 *
 *   A. Normal auto-compaction path:
 *      Soul returns `stopReason='needs_compaction'` → TurnManager invokes
 *      `executeCompaction` exactly once (driving
 *      `lifecycleStateMachine.transitionTo('compacting'→'active')` +
 *      compactionProvider.run + journalCapability.rotate +
 *      contextState.resetToSummary, and emitting `compaction.begin`/`end`
 *      on the sink) and continues the loop. A second runSoulTurn call
 *      returns end_turn and the turn settles normally.
 *
 *   B. Circuit breaker (MAX_COMPACTIONS_PER_TURN = 3):
 *      runSoulTurn unconditionally returns `needs_compaction` on every
 *      call. TurnManager executes compaction 3 times, then on the 4th
 *      needs_compaction signal emits a `session.error` event with
 *      `error_type='context_overflow'` and terminates the turn with
 *      `stopReason='error'`. The loop must NOT run indefinitely.
 *
 *   C. Manual `/compact` path (`triggerCompaction`):
 *      Calling `turnManager.triggerCompaction(instruction)` outside of a
 *      turn must drive the SAME executeCompaction pipeline — provider +
 *      rotate + resetToSummary + sink begin/end — and must forward the
 *      `customInstruction` into the compactionProvider call so the
 *      `/compact <reason>` CLI flag is wire-compatible end-to-end.
 *
 * Lifecycle assertion strategy (per team-lead 2026-04-17 decision):
 *   We use the real `SessionLifecycleStateMachine` and monkey-patch
 *   `transitionTo` to record the transition sequence. This avoids a
 *   redundant `lifecycleGate` facade field on TurnManagerDeps while still
 *   giving us precise ordering assertions on compacting ↔ active.
 *
 * Mock strategy:
 *   `vi.mock('../../src/soul/index.js', ...)` intercepts `runSoulTurn` so
 *   the test can script the Soul-side return values without a real LLM.
 *   `runCompaction` is NOT mocked — after Phase 2, TurnManager no longer
 *   imports it (`triggerCompaction` calls `this.executeCompaction()`), so
 *   Case C exercises the new private method through the public API.
 *
 * This file is expected to FAIL against the current code:
 *   - `TurnManagerDeps` does not yet declare `compactionProvider` /
 *     `journalCapability` (we pass them via cast).
 *   - `runTurn` is a single-call function, not a while-loop; it routes
 *     `needs_compaction` down the normal `reason='done'` branch and
 *     never touches the new deps.
 *   - No `session.error` is emitted because no circuit breaker exists.
 *   - `triggerCompaction` still calls `runCompaction(runtime, …)` which
 *     pokes the old Runtime fields, so Case C's new-deps spies stay at
 *     zero calls.
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
import {
  SoulLifecycleGate,
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulRegistry,
  TurnManager,
} from '../../src/soul-plus/index.js';
import type { TurnManagerDeps } from '../../src/soul-plus/index.js';
import { InMemoryContextState } from '../../src/storage/context-state.js';
import type { FullContextState } from '../../src/storage/context-state.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { CompactionOrchestrator } from '../../src/soul-plus/compaction-orchestrator.js';
import { PermissionClosureBuilder } from '../../src/soul-plus/permission-closure-builder.js';
import { TurnLifecycleTracker } from '../../src/soul-plus/turn-lifecycle-tracker.js';
import { WakeQueueScheduler } from '../../src/soul-plus/wake-queue-scheduler.js';

// ── vi.mock — intercept `runSoulTurn` on the SAME module specifier TurnManager imports ──

vi.mock('../../src/soul/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/soul/index.js')>();
  return {
    ...mod,
    runSoulTurn: vi.fn(),
  };
});

// ── spies / fakes ─────────────────────────────────────────────────────

interface SpyCompactionProvider extends CompactionProvider {
  readonly calls: { messagesLength: number; options: CompactionOptions | undefined }[];
}

function makeSpyCompactionProvider(summary?: SummaryMessage): SpyCompactionProvider {
  const calls: { messagesLength: number; options: CompactionOptions | undefined }[] = [];
  const effective: SummaryMessage = summary ?? {
    content: 'phase-2 compacted summary',
    original_turn_count: 1,
    original_token_count: 500,
  };
  return {
    calls,
    async run(
      messages: Message[],
      _signal: AbortSignal,
      options?: CompactionOptions,
    ): Promise<SummaryMessage> {
      calls.push({ messagesLength: messages.length, options });
      return effective;
    },
  };
}

interface SpyJournalCapability extends JournalCapability {
  readonly rotations: unknown[];
}

function makeSpyJournalCapability(): SpyJournalCapability {
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

/**
 * Minimal structural shape returned by `vi.spyOn` — all we need is
 * `.mock.calls`. Using a hand-rolled shape sidesteps vitest's
 * overload-heavy `vi.spyOn` generic which rejects method names under
 * the getter overload.
 */
interface TransitionSpy {
  mock: { calls: unknown[][] };
}

/**
 * Read the recorded transition sequence off a `vi.spyOn`-wrapped
 * `transitionTo`. Extracts the first argument of every call in call order.
 */
function readTransitions(spy: TransitionSpy): string[] {
  return spy.mock.calls.map((args) => args[0] as string);
}

/**
 * Never invoked — runSoulTurn is mocked. Present only so the Runtime
 * cast has a concrete `kosong` field the TypeScript compiler accepts.
 */
const noopKosong: KosongAdapter = {
  async chat() {
    throw new Error('kosong.chat should not be reached — runSoulTurn is mocked');
  },
};

// ── harness ───────────────────────────────────────────────────────────

interface Harness {
  manager: TurnManager;
  contextState: FullContextState;
  sessionJournal: InMemorySessionJournalImpl;
  stateMachine: SessionLifecycleStateMachine;
  sink: SessionEventBus;
  sinkEmitSpy: ReturnType<typeof vi.fn>;
  compactionProvider: SpyCompactionProvider;
  journalCapability: SpyJournalCapability;
  resetToSummarySpy: ReturnType<typeof vi.spyOn>;
  transitionSpy: TransitionSpy;
}

function buildHarness(): Harness {
  const stateMachine = new SessionLifecycleStateMachine();
  // Per team-lead 2026-04-17 arbitration: TurnManagerDeps only grows
  // `compactionProvider` + `journalCapability`. Lifecycle transitions are
  // still driven through the existing `deps.lifecycleStateMachine` —
  // so we spy directly on that one machine's `transitionTo` to assert
  // on compacting↔active (and completing↔idle) ordering, instead of
  // adding a separate `lifecycleGate` facade field.
  const transitionSpy = vi.spyOn(stateMachine, 'transitionTo');
  const gateFacade = new SoulLifecycleGate(stateMachine);
  const contextState = new InMemoryContextState({ initialModel: 'test-model' });
  const sessionJournal = new InMemorySessionJournalImpl();
  const sink = new SessionEventBus();
  // Wrap emit so the test can inspect every event pushed through the sink,
  // including the `session.error` cast emitted by the circuit breaker that
  // sits outside the SoulEvent union.
  const sinkEmitSpy = vi.fn(sink.emit.bind(sink));
  (sink as unknown as { emit: typeof sinkEmitSpy }).emit = sinkEmitSpy;

  const compactionProvider = makeSpyCompactionProvider();
  const journalCapability = makeSpyJournalCapability();

  // The current (pre-Phase-2) Runtime type still requires all 4 fields.
  // After Phase 2 the type narrows to `{kosong}` and the extras become
  // excess properties — the `as Runtime` cast absorbs both eras.
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

  // Phase 4 (决策 #109): TurnManagerDeps adds required subcomponents
  // (compaction / permissionBuilder / lifecycle). We build real
  // instances so the needs_compaction loop and /compact path drive the
  // same underlying compactionProvider / journalCapability / resetToSummary
  // the pre-Phase-4 tests asserted on.
  const compaction = new CompactionOrchestrator({
    contextState,
    compactionProvider,
    lifecycleStateMachine: stateMachine,
    journalCapability,
    sink,
    journalWriter: contextState.journalWriter,
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
  const resetToSummarySpy = vi.spyOn(contextState, 'resetToSummary');

  return {
    manager,
    contextState,
    sessionJournal,
    stateMachine,
    sink,
    sinkEmitSpy,
    compactionProvider,
    journalCapability,
    resetToSummarySpy,
    transitionSpy,
  };
}

function zeroUsage(): TurnResult['usage'] {
  return { input: 0, output: 0 };
}

/** Cast because `'needs_compaction'` is not yet in the StopReason union. */
function needsCompactionResult(): TurnResult {
  return {
    stopReason: 'needs_compaction' as TurnResult['stopReason'],
    steps: 0,
    usage: zeroUsage(),
  };
}

function endTurnResult(steps = 1): TurnResult {
  return { stopReason: 'end_turn', steps, usage: zeroUsage() };
}

/** Locate the start / end indices of a contiguous subsequence in `haystack`. */
function containsInOrder(haystack: readonly string[], needle: readonly string[]): boolean {
  let i = 0;
  for (const entry of haystack) {
    if (entry === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return false;
}

// ── tests ─────────────────────────────────────────────────────────────

describe('TurnManager — Phase 2 needs_compaction loop + triggerCompaction', () => {
  it('A — normal path: needs_compaction → executeCompaction → re-run Soul → end_turn', async () => {
    const mockedRunSoulTurn = vi.mocked(runSoulTurn);
    mockedRunSoulTurn.mockReset();
    mockedRunSoulTurn.mockResolvedValueOnce(needsCompactionResult());
    mockedRunSoulTurn.mockResolvedValueOnce(endTurnResult(1));

    const h = buildHarness();

    const started = await h.manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');
    const finalResult = await h.manager.awaitTurn(started.turn_id);

    // Soul was invoked exactly twice: once producing the signal, once
    // producing the final end_turn after compaction reset.
    expect(mockedRunSoulTurn).toHaveBeenCalledTimes(2);

    // executeCompaction drove the three new capabilities, in order.
    expect(h.compactionProvider.calls.length).toBe(1);
    expect(h.journalCapability.rotations.length).toBe(1);
    expect(h.resetToSummarySpy).toHaveBeenCalledTimes(1);

    // Lifecycle dance inside executeCompaction: active → compacting → active
    // must appear in the recorded machine transition sequence.
    const transitionsA = readTransitions(h.transitionSpy);
    expect(containsInOrder(transitionsA, ['active', 'compacting', 'active'])).toBe(true);
    // And the turn must fully drain back to idle at the end.
    expect(transitionsA[transitionsA.length - 1]).toBe('idle');
    expect(h.stateMachine.isIdle()).toBe(true);

    // Sink observed compaction.begin/end in order.
    const emittedTypes = h.sinkEmitSpy.mock.calls.map(
      (args) => (args[0] as { type: string }).type,
    );
    const beginIdx = emittedTypes.indexOf('compaction.begin');
    const endIdx = emittedTypes.indexOf('compaction.end');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(beginIdx);

    // Final turn settles with end_turn.
    expect(finalResult?.stopReason).toBe('end_turn');

    // No session.error in the normal path.
    const sessionErrors = h.sinkEmitSpy.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === 'session.error',
    );
    expect(sessionErrors.length).toBe(0);
  });

  it('B — circuit breaker: 4× needs_compaction → executeCompaction fires 3×, then session.error + stopReason=error', async () => {
    const mockedRunSoulTurn = vi.mocked(runSoulTurn);
    mockedRunSoulTurn.mockReset();
    // MAX_COMPACTIONS_PER_TURN = 3. Loop shape:
    //   call 1  needs_compaction → compactionCount=1, executeCompaction #1
    //   call 2  needs_compaction → compactionCount=2, executeCompaction #2
    //   call 3  needs_compaction → compactionCount=3, executeCompaction #3
    //   call 4  needs_compaction → compactionCount=4 > 3 → session.error + break
    //
    // If the impl is missing the circuit breaker the mock keeps returning
    // needs_compaction and the test would hang; the `toHaveBeenCalledTimes`
    // assertion below catches that within the vitest default timeout.
    mockedRunSoulTurn.mockResolvedValue(needsCompactionResult());

    const h = buildHarness();

    const started = await h.manager.handlePrompt({ data: { input: { text: 'hi' } } });
    if (!('turn_id' in started)) throw new Error('expected turn_id');
    const finalResult = await h.manager.awaitTurn(started.turn_id);

    // Loop is bounded: exactly 4 Soul calls, 3 compaction executions.
    expect(mockedRunSoulTurn).toHaveBeenCalledTimes(4);
    expect(h.compactionProvider.calls.length).toBe(3);
    expect(h.journalCapability.rotations.length).toBe(3);
    expect(h.resetToSummarySpy).toHaveBeenCalledTimes(3);

    // Machine saw three executeCompaction round-trips: active→compacting
    // appears exactly 3 times in the recorded sequence.
    const transitionsB = readTransitions(h.transitionSpy);
    const compactingCount = transitionsB.filter((s) => s === 'compacting').length;
    expect(compactingCount).toBe(3);

    // Circuit-breaker contract: exactly one session.error with
    // error_type='context_overflow'.
    const sessionErrorCalls = h.sinkEmitSpy.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === 'session.error',
    );
    expect(sessionErrorCalls.length).toBe(1);
    const payload = sessionErrorCalls[0]?.[0] as {
      type: string;
      error_type?: string;
      error?: string;
    };
    expect(payload.error_type).toBe('context_overflow');
    expect(typeof payload.error).toBe('string');

    // Final TurnResult reports error — not end_turn, not aborted.
    expect(finalResult?.stopReason).toBe('error');

    // Session must have drained back to idle so the next prompt can run.
    expect(h.stateMachine.isIdle()).toBe(true);
  });

  it('C — triggerCompaction (/compact) drives the same executeCompaction pipeline and forwards customInstruction', async () => {
    // triggerCompaction runs OUTSIDE a Soul turn, so runSoulTurn is never
    // invoked here. We still need the mock to exist because
    // TurnManager imports it at module load.
    const mockedRunSoulTurn = vi.mocked(runSoulTurn);
    mockedRunSoulTurn.mockReset();

    const h = buildHarness();

    await h.manager.triggerCompaction('please include decisions only');

    // runSoulTurn was NOT called — /compact is a bare compaction, not a turn.
    expect(mockedRunSoulTurn).not.toHaveBeenCalled();

    // The same three new deps got driven, once each.
    expect(h.compactionProvider.calls.length).toBe(1);
    expect(h.journalCapability.rotations.length).toBe(1);
    expect(h.resetToSummarySpy).toHaveBeenCalledTimes(1);

    // customInstruction was forwarded into CompactionProvider.run's options.
    const options = h.compactionProvider.calls[0]?.options;
    expect(options?.userInstructions).toBe('please include decisions only');

    // Machine cycled active → compacting → active → completing → idle.
    const transitionsC = readTransitions(h.transitionSpy);
    expect(containsInOrder(transitionsC, ['active', 'compacting', 'active'])).toBe(true);
    expect(h.stateMachine.isIdle()).toBe(true);

    // Sink saw compaction.begin / compaction.end in order.
    const emittedTypes = h.sinkEmitSpy.mock.calls.map(
      (args) => (args[0] as { type: string }).type,
    );
    const beginIdx = emittedTypes.indexOf('compaction.begin');
    const endIdx = emittedTypes.indexOf('compaction.end');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(beginIdx);
  });
});
