/**
 * Slice 20-A — `SessionControl.clear()` end-to-end behaviour.
 *
 * These tests drive the removal of the NotImplementedError stub in
 * `DefaultSessionControl.clear` (see `session-control.ts:84`). The real
 * implementation must delegate to `contextState.clear()` and must not
 * touch any adjacent subsystem state (plan mode, permission mode, etc.).
 *
 * Covers the 5 core scenarios from Phase 20 doc §A.3:
 *   1. `clear()` resolves without the not-implemented error.
 *   2. `clear()` calls through to `contextState.clear()`.
 *   3. After a clear, `contextState.buildMessages()` is empty.
 *   4. clear() does NOT change plan_mode / permission_mode.
 *   5. clear is idempotent — calling twice does not crash the handler.
 */

import { describe, expect, it, vi } from 'vitest';

import { SessionLifecycleStateMachine } from '../../src/soul-plus/lifecycle-state-machine.js';
import { DefaultSessionControl } from '../../src/soul-plus/session-control.js';
import { SoulRegistry } from '../../src/soul-plus/soul-registry.js';
import { TurnManager } from '../../src/soul-plus/turn-manager.js';
import { CompactionOrchestrator } from '../../src/soul-plus/compaction-orchestrator.js';
import { PermissionClosureBuilder } from '../../src/soul-plus/permission-closure-builder.js';
import { TurnLifecycleTracker } from '../../src/soul-plus/turn-lifecycle-tracker.js';
import { WakeQueueScheduler } from '../../src/soul-plus/wake-queue-scheduler.js';
import type { EventSink, SoulEvent } from '../../src/soul/event-sink.js';
import type {
  CompactionProvider,
  JournalCapability,
  Runtime,
} from '../../src/soul/runtime.js';
import {
  InMemoryContextState,
  type FullContextState,
} from '../../src/storage/context-state.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';

// ── Stubs (mirror existing session-control.test.ts) ──────────────────────

function makeStubRuntime(): Runtime {
  return { kosong: {} as never };
}

function makeStubCompactionProvider(): CompactionProvider {
  return {
    run: vi.fn().mockResolvedValue({
      content: 'stub summary',
      original_turn_count: 0,
    }),
  };
}

function makeStubJournalCapability(): JournalCapability {
  return { rotate: vi.fn().mockResolvedValue({ archiveFile: 'wire.1.jsonl' }) };
}

function makeStubSink(): EventSink {
  return {
    emit(_event: SoulEvent): void {
      /* no-op */
    },
  };
}

function makeHarness() {
  const contextState = new InMemoryContextState({
    initialModel: 'test-model',
    initialSystemPrompt: 'keep me',
    initialActiveTools: new Set(['Read']),
  });
  const sessionJournal = new InMemorySessionJournalImpl();
  const lifecycleStateMachine = new SessionLifecycleStateMachine();
  const soulRegistry = new SoulRegistry({
    createHandle: (key, agentDepth) => ({
      key,
      agentId: 'agent_main',
      abortController: new AbortController(),
      agentDepth,
    }),
  });
  const sink = makeStubSink();
  const compaction = new CompactionOrchestrator({
    contextState,
    compactionProvider: makeStubCompactionProvider(),
    lifecycleStateMachine,
    journalCapability: makeStubJournalCapability(),
    sink,
    journalWriter: contextState.journalWriter,
  });
  const turnManager = new TurnManager({
    contextState,
    sessionJournal,
    runtime: makeStubRuntime(),
    sink,
    lifecycleStateMachine,
    soulRegistry,
    tools: [],
    compaction,
    permissionBuilder: new PermissionClosureBuilder({}),
    lifecycle: new TurnLifecycleTracker(),
    wakeScheduler: new WakeQueueScheduler(),
  });
  const sessionControl = new DefaultSessionControl({
    turnManager,
    contextState,
    sessionJournal,
  });
  return {
    sessionControl,
    turnManager,
    contextState,
    sessionJournal,
    sink,
    lifecycleStateMachine,
  };
}

// ── 1. Happy path: clear succeeds + delegates to contextState.clear ──────

describe('SessionControl.clear — happy path', () => {
  it('no longer throws the not-implemented error (stub removed)', async () => {
    const { sessionControl } = makeHarness();

    await expect(sessionControl.clear()).resolves.toBeUndefined();
  });

  it('delegates to contextState.clear()', async () => {
    const { sessionControl, contextState } = makeHarness();
    // The real method needs to exist on contextState for this spy to land.
    // Until Slice 20-A lands, the spy never fires and the test fails.
    const spy = vi.spyOn(
      contextState as FullContextState & { clear: () => Promise<void> },
      'clear',
    );

    await sessionControl.clear();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('empties buildMessages() / getHistory() after clear', async () => {
    const { sessionControl, contextState } = makeHarness();
    await contextState.appendUserMessage({ text: 'pre-clear' });
    await contextState.appendAssistantMessage({
      text: 'reply',
      think: null,
      toolCalls: [],
      model: 'test-model',
      usage: { input_tokens: 10, output_tokens: 3 },
    });

    await sessionControl.clear();

    expect(contextState.buildMessages()).toEqual([]);
    expect(contextState.getHistory()).toEqual([]);
    expect(contextState.tokenCountWithPending).toBe(0);
  });
});

// ── 2. Cross-system invariants: clear must not leak into plan/permission ─

describe('SessionControl.clear — isolation from plan / permission state', () => {
  it('does not change plan_mode', async () => {
    const { sessionControl, turnManager } = makeHarness();
    await sessionControl.setPlanMode(true);
    expect(turnManager.getPlanMode()).toBe(true);

    await sessionControl.clear();

    expect(turnManager.getPlanMode()).toBe(true);
  });

  it('does not change permission_mode (yolo bit)', async () => {
    const { sessionControl, turnManager } = makeHarness();
    await sessionControl.setYolo(true);
    expect(turnManager.getPermissionMode()).toBe('bypassPermissions');

    await sessionControl.clear();

    expect(turnManager.getPermissionMode()).toBe('bypassPermissions');
  });

  it('preserves systemPrompt / model / activeTools across a clear', async () => {
    const { sessionControl, contextState } = makeHarness();
    await contextState.appendUserMessage({ text: 'something' });

    await sessionControl.clear();

    expect(contextState.model).toBe('test-model');
    expect(contextState.systemPrompt).toBe('keep me');
    expect(new Set(contextState.activeTools)).toEqual(new Set(['Read']));
  });
});

// ── 3. Lifecycle guard — refuse when not idle ──────────────────────────

describe('SessionControl.clear — lifecycle guard', () => {
  it('refuses to clear while a turn is active', async () => {
    const { sessionControl, lifecycleStateMachine, contextState } = makeHarness();
    await contextState.appendUserMessage({ text: 'mid-turn' });
    lifecycleStateMachine.transitionTo('active');

    await expect(sessionControl.clear()).rejects.toThrow(/active/i);

    // Memory must be untouched by the aborted attempt (no WAL write,
    // no history mutation).
    expect(contextState.getHistory().length).toBe(1);
    expect(contextState.buildMessages().length).toBeGreaterThan(0);
  });

  it('refuses to clear while compaction is running', async () => {
    const { sessionControl, lifecycleStateMachine, contextState } = makeHarness();
    await contextState.appendUserMessage({ text: 'mid-compact' });
    lifecycleStateMachine.transitionTo('active');
    lifecycleStateMachine.transitionTo('compacting');

    await expect(sessionControl.clear()).rejects.toThrow(/compacting/i);

    expect(contextState.getHistory().length).toBe(1);
  });

  it('succeeds again after the lifecycle returns to idle', async () => {
    const { sessionControl, lifecycleStateMachine, contextState } = makeHarness();
    await contextState.appendUserMessage({ text: 'hello' });

    // Simulate a turn running + ending.
    lifecycleStateMachine.transitionTo('active');
    await expect(sessionControl.clear()).rejects.toThrow();
    lifecycleStateMachine.transitionTo('completing');
    lifecycleStateMachine.transitionTo('idle');

    await expect(sessionControl.clear()).resolves.toBeUndefined();
    expect(contextState.buildMessages()).toEqual([]);
  });

  it('atomically reserves lifecycle mid-clear so a concurrent second clear rejects', async () => {
    // TOCTOU closure: `isIdle()` check + `await contextState.clear()`
    // used to race. After the fix, `tryReserveForMaintenance` flips
    // state to 'active' synchronously; a second clear firing at any
    // microtask gap during the first clear's await must see 'active'
    // and refuse immediately.
    const { sessionControl, contextState } = makeHarness();
    await contextState.appendUserMessage({ text: 'a' });

    const first = sessionControl.clear();
    // No `await` between the two calls — the race window is real.
    await expect(sessionControl.clear()).rejects.toThrow(/active/i);
    await expect(first).resolves.toBeUndefined();
  });

  it('releases the maintenance reservation even if contextState.clear throws', async () => {
    const { sessionControl, contextState, lifecycleStateMachine } = makeHarness();
    await contextState.appendUserMessage({ text: 'a' });
    const spy = vi
      .spyOn(contextState as FullContextState & { clear: () => Promise<void> }, 'clear')
      .mockRejectedValueOnce(new Error('WAL append blew up'));

    await expect(sessionControl.clear()).rejects.toThrow(/WAL append/);

    // Lifecycle must be back in 'idle' — if it stuck on 'active' the
    // session would be permanently unable to take new turns.
    expect(lifecycleStateMachine.state).toBe('idle');
    spy.mockRestore();

    // And a follow-up clear on a restored contextState must succeed.
    await expect(sessionControl.clear()).resolves.toBeUndefined();
  });

  it('leaves lifecycle in idle on successful clear (no stuck active state)', async () => {
    const { sessionControl, contextState, lifecycleStateMachine } = makeHarness();
    await contextState.appendUserMessage({ text: 'a' });

    await sessionControl.clear();

    expect(lifecycleStateMachine.state).toBe('idle');
  });
});

// ── 4. Idempotency ───────────────────────────────────────────────────────

describe('SessionControl.clear — idempotency', () => {
  it('two successive clears both resolve without throwing', async () => {
    const { sessionControl, contextState } = makeHarness();
    await contextState.appendUserMessage({ text: 'hello' });

    await expect(sessionControl.clear()).resolves.toBeUndefined();
    await expect(sessionControl.clear()).resolves.toBeUndefined();
    expect(contextState.buildMessages()).toEqual([]);
  });
});
