/**
 * Slice 4 / Phase 4 — CompactionOrchestrator 独立组件契约测试（决策 #109）.
 *
 * Phase 2 把 compaction 从 Soul 搬进 TurnManager（铁律 7）；Phase 4 再把
 * `executeCompaction` / `triggerCompaction` 从 TurnManager 抽成独立组件
 * `CompactionOrchestrator`（v2 §6.4 / Phase 4 todo Part A.1），依赖收敛为 6 项：
 *
 *   - contextState
 *   - compactionProvider
 *   - lifecycleStateMachine
 *   - journalCapability
 *   - sink
 *   - journalWriter（Phase 3 铁律：rotate 前必须 flush）
 *
 * PreCompact / PostCompact hook 仍由 orchestrator 侧发起（fire-and-forget），
 * 通过 optional `hookEngine` + `sessionId` / `agentId` 附加依赖启用。
 *
 * 预计 FAIL：`CompactionOrchestrator` 还不存在（Implementer 阶段创建）。
 */

import type { Message } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  CompactionOrchestrator,
  STATIC_DEFAULT_RUNTIME_STATE,
  STATIC_NO_PENDING_TURN,
  type CompactionOrchestratorDeps,
} from '../../src/soul-plus/compaction-orchestrator.js';
import { SessionEventBus, SessionLifecycleStateMachine } from '../../src/soul-plus/index.js';
import type {
  CompactionOptions,
  CompactionProvider,
  JournalCapability,
  SummaryMessage as RuntimeSummaryMessage,
} from '../../src/soul/index.js';
import { InMemoryContextState } from '../../src/storage/context-state.js';
import type { FullContextState } from '../../src/storage/context-state.js';

// ── Spy helpers ────────────────────────────────────────────────────────

interface SpyProvider extends CompactionProvider {
  readonly calls: { messagesLength: number; options: CompactionOptions | undefined }[];
}

function makeSpyProvider(summary?: RuntimeSummaryMessage): SpyProvider {
  const calls: { messagesLength: number; options: CompactionOptions | undefined }[] = [];
  const effective: RuntimeSummaryMessage = summary ?? {
    content: 'phase-4 compacted summary',
    original_turn_count: 1,
    original_token_count: 500,
  };
  return {
    calls,
    async run(
      messages: Message[],
      _signal: AbortSignal,
      options?: CompactionOptions,
    ): Promise<RuntimeSummaryMessage> {
      calls.push({ messagesLength: messages.length, options });
      return effective;
    },
  };
}

interface SpyJournal extends JournalCapability {
  readonly rotations: unknown[];
  readonly boundaries: unknown[];
}

function makeSpyJournal(): SpyJournal {
  const rotations: unknown[] = [];
  const boundaries: unknown[] = [];
  return {
    rotations,
    boundaries,
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
    async appendBoundary(record) {
      boundaries.push(record);
    },
  };
}

interface Harness {
  deps: CompactionOrchestratorDeps;
  contextState: FullContextState;
  stateMachine: SessionLifecycleStateMachine;
  sink: SessionEventBus;
  sinkEmit: Mock;
  provider: SpyProvider;
  journal: SpyJournal;
  flushSpy: ReturnType<typeof vi.spyOn>;
  transitionSpy: ReturnType<typeof vi.spyOn>;
  resetSpy: ReturnType<typeof vi.spyOn>;
}

function buildHarness(overrides: Partial<CompactionOrchestratorDeps> = {}): Harness {
  const contextState =
    (overrides.contextState as FullContextState | undefined) ??
    new InMemoryContextState({ initialModel: 'test-model' });
  const stateMachine =
    (overrides.lifecycleStateMachine as SessionLifecycleStateMachine | undefined) ??
    new SessionLifecycleStateMachine('active');
  const sink = (overrides.sink as SessionEventBus | undefined) ?? new SessionEventBus();
  const sinkEmit = vi.fn(sink.emit.bind(sink));
  (sink as unknown as { emit: typeof sinkEmit }).emit = sinkEmit;
  const provider = (overrides.compactionProvider as SpyProvider | undefined) ?? makeSpyProvider();
  const journal = (overrides.journalCapability as SpyJournal | undefined) ?? makeSpyJournal();
  const flushSpy = vi.spyOn(contextState.journalWriter, 'flush');
  const transitionSpy = vi.spyOn(stateMachine, 'transitionTo');
  const resetSpy = vi.spyOn(contextState, 'resetToSummary');

  const deps: CompactionOrchestratorDeps = {
    contextState,
    compactionProvider: provider,
    lifecycleStateMachine: stateMachine,
    journalCapability: journal,
    sink,
    journalWriter: contextState.journalWriter,
    runtimeStateProvider: STATIC_DEFAULT_RUNTIME_STATE,
    getPendingTurnId: STATIC_NO_PENDING_TURN,
    ...overrides,
  };

  return {
    deps,
    contextState,
    stateMachine,
    sink,
    sinkEmit,
    provider,
    journal,
    flushSpy,
    transitionSpy,
    resetSpy,
  };
}

function readTransitions(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((args) => args[0] as string);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('CompactionOrchestrator — executeCompaction', () => {
  it('accepts exactly the 8 required deps on its constructor', () => {
    // Structural assertion: the required field names must be sufficient
    // to construct a CompactionOrchestrator. An Implementer that widens
    // the constructor with additional required deps will fail this test.
    // Phase 23 fix raised the count from 6 to 7 by adding
    // `runtimeStateProvider`. Phase 20 round-5 raised it to 8 by adding
    // `getPendingTurnId` (required, not optional, so the /compact race
    // guard cannot be silently bypassed by a new construction site that
    // forgets to wire it).
    const h = buildHarness();
    const minimalDeps: CompactionOrchestratorDeps = {
      contextState: h.deps.contextState,
      compactionProvider: h.deps.compactionProvider,
      lifecycleStateMachine: h.deps.lifecycleStateMachine,
      journalCapability: h.deps.journalCapability,
      sink: h.deps.sink,
      journalWriter: h.deps.journalWriter,
      runtimeStateProvider: STATIC_DEFAULT_RUNTIME_STATE,
      getPendingTurnId: STATIC_NO_PENDING_TURN,
    };
    expect(() => new CompactionOrchestrator(minimalDeps)).not.toThrow();
  });

  it('drives lifecycle: active → compacting → active in executeCompaction', async () => {
    const h = buildHarness();
    const orchestrator = new CompactionOrchestrator(h.deps);
    await orchestrator.executeCompaction(new AbortController().signal);
    const transitions = readTransitions(h.transitionSpy);
    expect(transitions[0]).toBe('compacting');
    expect(transitions.at(-1)).toBe('active');
  });

  it('emits compaction.begin and compaction.end (with tokensBefore / tokensAfter) in order', async () => {
    const h = buildHarness();
    const orchestrator = new CompactionOrchestrator(h.deps);
    await orchestrator.executeCompaction(new AbortController().signal);

    const types = h.sinkEmit.mock.calls.map((args) => (args[0] as { type: string }).type);
    const beginIdx = types.indexOf('compaction.begin');
    const endIdx = types.indexOf('compaction.end');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(beginIdx);

    const endEvent = h.sinkEmit.mock.calls[endIdx]?.[0] as {
      type: string;
      tokensBefore?: number;
      tokensAfter?: number;
    };
    expect(typeof endEvent.tokensBefore).toBe('number');
    expect(typeof endEvent.tokensAfter).toBe('number');
  });

  it('aborts at the provider.run checkpoint when the signal is already aborted', async () => {
    const h = buildHarness();
    const orchestrator = new CompactionOrchestrator(h.deps);
    const controller = new AbortController();
    controller.abort();
    await expect(
      orchestrator.executeCompaction(controller.signal),
    ).rejects.toSatisfy((err: unknown) => err instanceof Error);
    // provider was never invoked because abort was checked first
    expect(h.provider.calls).toHaveLength(0);
    // And the machine drained back to `active` even on abort (finally block).
    const transitions = readTransitions(h.transitionSpy);
    expect(transitions.at(-1)).toBe('active');
  });

  it('forwards customInstruction into CompactionProvider.run options', async () => {
    const h = buildHarness();
    const orchestrator = new CompactionOrchestrator(h.deps);
    await orchestrator.executeCompaction(
      new AbortController().signal,
      'please include decisions only',
      'manual',
    );
    expect(h.provider.calls).toHaveLength(1);
    expect(h.provider.calls[0]?.options?.userInstructions).toBe('please include decisions only');
  });

  it('stamps the trigger (auto / manual) onto the storage SummaryMessage', async () => {
    const h = buildHarness();
    const orchestrator = new CompactionOrchestrator(h.deps);
    await orchestrator.executeCompaction(new AbortController().signal, undefined, 'manual');
    expect(h.resetSpy).toHaveBeenCalledTimes(1);
    const summary = h.resetSpy.mock.calls[0]?.[0] as { trigger?: string };
    expect(summary.trigger).toBe('manual');
  });

  it('flushes the journalWriter BEFORE rotate (Phase 3 铁律)', async () => {
    // Instrument rotate so we can capture flush call-count at the moment
    // rotate is invoked — flush must already have been called before rotate.
    const h = buildHarness();
    let flushCountAtRotate = -1;
    const wrappedJournal: JournalCapability = {
      async rotate(record) {
        flushCountAtRotate = h.flushSpy.mock.calls.length;
        return h.journal.rotate(record);
      },
      async readSessionInitialized() {
        return h.journal.readSessionInitialized();
      },
      async appendBoundary(record) {
        return h.journal.appendBoundary(record);
      },
    };
    const deps: CompactionOrchestratorDeps = { ...h.deps, journalCapability: wrappedJournal };
    const orchestrator = new CompactionOrchestrator(deps);
    await orchestrator.executeCompaction(new AbortController().signal);
    expect(flushCountAtRotate).toBeGreaterThanOrEqual(1);
  });

  it('throws a "requires compactionProvider" error when compactionProvider is a throwing stub', async () => {
    const stubProvider: CompactionProvider = {
      async run() {
        throw new Error('CompactionOrchestrator requires a real compactionProvider');
      },
    };
    const h = buildHarness({ compactionProvider: stubProvider });
    const orchestrator = new CompactionOrchestrator(h.deps);
    await expect(
      orchestrator.executeCompaction(new AbortController().signal),
    ).rejects.toThrow(/requires|compactionProvider/);
  });

  it('throws a "requires journalCapability" error when journalCapability is a throwing stub', async () => {
    const stubJournal: JournalCapability = {
      async rotate() {
        throw new Error('CompactionOrchestrator requires a real journalCapability');
      },
      async readSessionInitialized() {
        throw new Error('CompactionOrchestrator requires a real journalCapability');
      },
      async appendBoundary() {
        throw new Error('CompactionOrchestrator requires a real journalCapability');
      },
    };
    const h = buildHarness({ journalCapability: stubJournal });
    const orchestrator = new CompactionOrchestrator(h.deps);
    await expect(
      orchestrator.executeCompaction(new AbortController().signal),
    ).rejects.toThrow(/requires|journalCapability/);
  });
});

// ── triggerCompaction (manual /compact path) ──────────────────────────

describe('CompactionOrchestrator — triggerCompaction (manual /compact)', () => {
  it('drives idle → active → compacting → active → completing → idle', async () => {
    const h = buildHarness({
      lifecycleStateMachine: new SessionLifecycleStateMachine('idle'),
    });
    const orchestrator = new CompactionOrchestrator(h.deps);
    await orchestrator.triggerCompaction('keep decisions only');
    const transitions = readTransitions(h.transitionSpy);
    // Expected 3-hop drain includes 'compacting' in the middle and ends at 'idle'.
    expect(transitions).toContain('compacting');
    expect(transitions.at(-1)).toBe('idle');
    expect(h.stateMachine.isIdle()).toBe(true);
  });

  it('forwards customInstruction into provider.run options and stamps trigger=manual', async () => {
    const h = buildHarness({
      lifecycleStateMachine: new SessionLifecycleStateMachine('idle'),
    });
    const orchestrator = new CompactionOrchestrator(h.deps);
    await orchestrator.triggerCompaction('/compact reason:decisions');
    expect(h.provider.calls).toHaveLength(1);
    expect(h.provider.calls[0]?.options?.userInstructions).toBe('/compact reason:decisions');
    const summary = h.resetSpy.mock.calls[0]?.[0] as { trigger?: string };
    expect(summary.trigger).toBe('manual');
  });

  it('throws "Cannot compact while a turn is active" when the machine is not idle', async () => {
    const h = buildHarness({
      lifecycleStateMachine: new SessionLifecycleStateMachine('active'),
    });
    const orchestrator = new CompactionOrchestrator(h.deps);
    await expect(orchestrator.triggerCompaction()).rejects.toThrow(
      /Cannot compact while a turn is active/i,
    );
  });

  it('refuses when getPendingTurnId reports an in-flight prompt launch (round-5 review)', async () => {
    // `handlePrompt` sets `pendingLaunchTurnId` synchronously but only
    // transitions lifecycle to 'active' after awaiting its journal
    // appends. Without this guard `/compact` sees isIdle() === true
    // during that window and races the prompt. The dep predicate
    // returns the current pending id; triggerCompaction must refuse.
    const h = buildHarness({
      lifecycleStateMachine: new SessionLifecycleStateMachine('idle'),
      getPendingTurnId: () => 'turn_pending_123',
    });
    const orchestrator = new CompactionOrchestrator(h.deps);
    await expect(orchestrator.triggerCompaction()).rejects.toThrow(
      /prompt launch is in flight/i,
    );
    // No transitions — guard must reject BEFORE any state mutation.
    expect(readTransitions(h.transitionSpy)).toEqual([]);
  });

  it('proceeds when getPendingTurnId returns undefined (no in-flight turn)', async () => {
    const h = buildHarness({
      lifecycleStateMachine: new SessionLifecycleStateMachine('idle'),
      getPendingTurnId: () => undefined,
    });
    const orchestrator = new CompactionOrchestrator(h.deps);
    await expect(orchestrator.triggerCompaction()).resolves.toBeUndefined();
  });
});

// ── PreCompact / PostCompact hook fire-and-forget (optional hookEngine)

describe('CompactionOrchestrator — PreCompact / PostCompact hook fire-and-forget', () => {
  it('fires PreCompact then PostCompact when an optional hookEngine is supplied', async () => {
    const executeHooks = vi.fn().mockResolvedValue({ blockAction: false });
    const hookEngine = { executeHooks } as unknown as import('../../src/hooks/engine.js').HookEngine;

    // Widened deps — hookEngine / sessionId / agentId are Phase-4 optional.
    const h = buildHarness({
      lifecycleStateMachine: new SessionLifecycleStateMachine('idle'),
    });
    const deps = {
      ...h.deps,
      hookEngine,
      sessionId: 'ses_test',
      agentId: 'agent_main',
    } as CompactionOrchestratorDeps & {
      hookEngine: import('../../src/hooks/engine.js').HookEngine;
      sessionId: string;
      agentId: string;
    };
    const orchestrator = new CompactionOrchestrator(deps);
    await orchestrator.triggerCompaction();

    const events = executeHooks.mock.calls.map((args) => args[0]);
    const preIdx = events.indexOf('PreCompact');
    const postIdx = events.indexOf('PostCompact');
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThan(preIdx);
  });

  it('tolerates a throwing hookEngine without failing the compaction (fire-and-forget)', async () => {
    const executeHooks = vi.fn().mockRejectedValue(new Error('hook boom'));
    const hookEngine = { executeHooks } as unknown as import('../../src/hooks/engine.js').HookEngine;
    const h = buildHarness({
      lifecycleStateMachine: new SessionLifecycleStateMachine('idle'),
    });
    const deps = {
      ...h.deps,
      hookEngine,
      sessionId: 'ses_test',
      agentId: 'agent_main',
    } as CompactionOrchestratorDeps & {
      hookEngine: import('../../src/hooks/engine.js').HookEngine;
      sessionId: string;
      agentId: string;
    };
    const orchestrator = new CompactionOrchestrator(deps);
    await expect(orchestrator.triggerCompaction()).resolves.not.toThrow();
    // Compaction still completed successfully — reset-to-summary ran.
    expect(h.resetSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CompactionOrchestrator — tail user_message guard (Phase 8 / 决策 #101)', () => {
  it('re-appends an unpaired tail user message after resetToSummary', async () => {
    const contextState = new InMemoryContextState({ initialModel: 'test-model' });
    await contextState.appendUserMessage({ text: 'question one' });
    await contextState.appendAssistantMessage({
      text: 'answer one',
      think: null,
      toolCalls: [],
      model: 'test-model',
    });
    // Unpaired tail: user asks a new question that compaction is about to absorb.
    await contextState.appendUserMessage({ text: 'what is the tail question?' });

    const h = buildHarness({ contextState });
    const appendUserSpy = vi.spyOn(contextState, 'appendUserMessage');
    const orchestrator = new CompactionOrchestrator(h.deps);

    await orchestrator.executeCompaction(new AbortController().signal);

    // resetToSummary ran first, then the tail user message was re-appended.
    expect(h.resetSpy).toHaveBeenCalledTimes(1);
    expect(appendUserSpy).toHaveBeenCalledTimes(1);
    const reappended = appendUserSpy.mock.calls[0]?.[0];
    expect(reappended).toEqual({ text: 'what is the tail question?' });

    // The live history now ends with the re-appended user message so Soul
    // has a standalone prompt to respond to on the next turn.
    const messages = contextState.buildMessages();
    const last = messages[messages.length - 1];
    expect(last?.role).toBe('user');
  });

  it('does not re-append when the tail is an assistant message (paired)', async () => {
    const contextState = new InMemoryContextState({ initialModel: 'test-model' });
    await contextState.appendUserMessage({ text: 'hello' });
    await contextState.appendAssistantMessage({
      text: 'world',
      think: null,
      toolCalls: [],
      model: 'test-model',
    });

    const h = buildHarness({ contextState });
    const appendUserSpy = vi.spyOn(contextState, 'appendUserMessage');
    const orchestrator = new CompactionOrchestrator(h.deps);

    await orchestrator.executeCompaction(new AbortController().signal);

    expect(h.resetSpy).toHaveBeenCalledTimes(1);
    expect(appendUserSpy).not.toHaveBeenCalled();
  });
});
