/**
 * NotificationManager — Slice 2.4 regression suite.
 *
 * Covers the §5.2.4 fan-out contract and the Phase 1 Slice 8 audit M1
 * closure (system_reminder / notification actually reaching the next
 * `buildMessages()` output). Each test case corresponds to a row in the
 * Python-reference doc §8 checklist.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  NotificationManager,
  SessionEventBus,
  type NotificationData,
  type NotificationManagerDeps,
} from '../../src/soul-plus/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import type { NotificationRecord } from '../../src/storage/wire-record.js';

function baseInput(overrides: Partial<Parameters<NotificationManager['emit']>[0]> = {}) {
  return {
    category: 'task' as const,
    type: 'task.succeeded',
    source_kind: 'background_task',
    source_id: 'bg_1',
    title: 'Build done',
    body: 'Build passed',
    severity: 'success' as const,
    ...overrides,
  };
}

describe('NotificationManager.emit (Slice 2.4)', () => {
  it('LLM sink callback is invoked with the notification data (Case 1)', async () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const llmPushed: NotificationData[] = [];

    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: (n) => {
        llmPushed.push(n);
      },
    });

    await manager.emit(baseInput());

    expect(llmPushed).toHaveLength(1);
    expect(llmPushed[0]!.title).toBe('Build done');
  });

  it('fans out to all three sinks in order (Case 11)', async () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const wireSeen: NotificationData[] = [];
    eventBus.subscribeNotifications((n) => {
      wireSeen.push(n);
    });
    const shellSeen: NotificationData[] = [];
    const llmSeen: NotificationData[] = [];

    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: (n) => llmSeen.push(n),
      onShellDeliver: (n) => shellSeen.push(n),
    });

    const result = await manager.emit(baseInput());

    expect(llmSeen).toHaveLength(1);
    expect(wireSeen).toHaveLength(1);
    expect(shellSeen).toHaveLength(1);
    expect(result.delivered_at.llm).toBeGreaterThan(0);
    expect(result.delivered_at.wire).toBeGreaterThan(0);
    expect(result.delivered_at.shell).toBeGreaterThan(0);
  });

  it('records delivered_at.shell = 0 when no shell callback is registered (P0-2)', async () => {
    const manager = new NotificationManager({
      sessionJournal: new InMemorySessionJournalImpl(),
      sessionEventBus: new SessionEventBus(),
      onEmittedToLlm: () => {
        // noop
      },
      // onShellDeliver intentionally absent
    });

    const result = await manager.emit(baseInput());
    expect(result.delivered_at.shell).toBe(0);
  });

  it('swallows wire listener exceptions and still delivers to llm and shell (Case 5)', async () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    eventBus.subscribeNotifications(() => {
      throw new Error('boom');
    });
    let llmCalled = false;
    let shellCalled = false;

    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {
        llmCalled = true;
      },
      onShellDeliver: () => {
        shellCalled = true;
      },
      logger: () => {
        // noop
      },
    });

    await expect(manager.emit(baseInput())).resolves.toMatchObject({ deduped: false });
    expect(llmCalled).toBe(true);
    expect(shellCalled).toBe(true);
  });

  it('swallows shell callback exceptions and keeps llm and wire intact (Case 6)', async () => {
    const eventBus = new SessionEventBus();
    const wireSeen: NotificationData[] = [];
    eventBus.subscribeNotifications((n) => {
      wireSeen.push(n);
    });
    let llmCalled = false;

    const manager = new NotificationManager({
      sessionJournal: new InMemorySessionJournalImpl(),
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {
        llmCalled = true;
      },
      onShellDeliver: () => {
        throw new Error('shell boom');
      },
      logger: () => {
        // noop
      },
    });

    const result = await manager.emit(baseInput());
    expect(llmCalled).toBe(true);
    expect(wireSeen).toHaveLength(1);
    // Failed shell delivery: key absent (not 0 and not a timestamp)
    expect(result.delivered_at.shell).toBeUndefined();
  });

  it('dedupes via dedupe_key and does not re-fan-out (Case 4)', async () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    let llmCallCount = 0;

    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {
        llmCallCount += 1;
      },
    });

    const first = await manager.emit(baseInput({ dedupe_key: 'background_task:bg_1:done' }));
    const second = await manager.emit(baseInput({ dedupe_key: 'background_task:bg_1:done' }));

    expect(second.id).toBe(first.id);
    expect(second.deduped).toBe(true);
    expect(llmCallCount).toBe(1);
  });

  it('respects targets: ["wire"] — llm / shell are skipped (Case 12)', async () => {
    const eventBus = new SessionEventBus();
    const wireSeen: NotificationData[] = [];
    eventBus.subscribeNotifications((n) => {
      wireSeen.push(n);
    });
    const llmSeen = vi.fn();
    const shellSeen = vi.fn();

    const manager = new NotificationManager({
      sessionJournal: new InMemorySessionJournalImpl(),
      sessionEventBus: eventBus,
      onEmittedToLlm: llmSeen,
      onShellDeliver: shellSeen,
    });

    const result = await manager.emit(baseInput({ targets: ['wire'] }));
    expect(wireSeen).toHaveLength(1);
    expect(llmSeen).not.toHaveBeenCalled();
    expect(shellSeen).not.toHaveBeenCalled();
    expect(result.delivered_at.wire).toBeGreaterThan(0);
    expect(result.delivered_at.llm).toBeUndefined();
    expect(result.delivered_at.shell).toBeUndefined();
  });

  it('concurrent emits with same dedupe_key fan-out only once (M1)', async () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const appendNotificationCalls: unknown[] = [];

    // Phase 1: use contextState.appendNotification (durable) instead of
    // onEmittedToLlm (ephemeral) to track LLM sink delivery.
    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      contextState: {
        appendNotification: async (data: unknown) => {
          appendNotificationCalls.push(data);
        },
      },
    } as unknown as ConstructorParameters<typeof NotificationManager>[0]);

    const [r1, r2] = await Promise.all([
      manager.emit(baseInput({ dedupe_key: 'race_key' })),
      manager.emit(baseInput({ dedupe_key: 'race_key' })),
    ]);

    // Both should return the same id
    expect(r1.id).toBe(r2.id);
    // Exactly one was deduped (the concurrent follower)
    const deduped = [r1.deduped, r2.deduped].filter(Boolean);
    expect(deduped).toHaveLength(1);
    // Only one durable write (not two)
    expect(appendNotificationCalls).toHaveLength(1);
  });

  it('wire sink: delivered_at.wire is set even when async listener rejects (M2 bus-accepted semantics)', async () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    eventBus.subscribeNotifications(async () => {
      throw new Error('async wire boom');
    });

    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {
        // noop
      },
      logger: () => {
        // noop
      },
    });

    const result = await manager.emit(baseInput());
    // delivered_at.wire = timestamp because bus accepted the dispatch;
    // per-listener async rejection is swallowed by SessionEventBus.
    expect(result.delivered_at.wire).toBeGreaterThan(0);
  });

  it('wire sink: delivered_at.wire is set even when sync listener throws (M2 bus-accepted semantics)', async () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    eventBus.subscribeNotifications(() => {
      throw new Error('sync wire boom');
    });

    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {
        // noop
      },
      logger: () => {
        // noop
      },
    });

    const result = await manager.emit(baseInput());
    // Bus-accepted semantics: wire timestamp is set regardless of listener errors
    expect(result.delivered_at.wire).toBeGreaterThan(0);
  });

  it('primes its dedupe index from existing records (replay path)', async () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {
        // noop
      },
    });

    // Pretend replay surfaced a previously-persisted notification.
    const replayed: NotificationRecord = {
      type: 'notification',
      seq: 1,
      time: 1,
      data: {
        id: 'n_old',
        category: 'task',
        type: 'task.done',
        source_kind: 'background_task',
        source_id: 'bg_42',
        title: 't',
        body: 'b',
        severity: 'info',
        targets: ['llm', 'wire'],
        dedupe_key: 'background_task:bg_42:done',
      },
    };
    manager.primeDedupeIndex([replayed]);

    const result = await manager.emit(baseInput({ dedupe_key: 'background_task:bg_42:done' }));
    expect(result.deduped).toBe(true);
    expect(result.id).toBe('n_old');
  });
});

// ── Phase 1 Step 5: NotificationManager durable path ──────────────────
//
// Decision #89: NotificationManager.emit writes directly to
// contextState.appendNotification (durable) instead of routing through an
// onEmittedToLlm callback (ephemeral). The LLM-sink callback,
// pendingLlmCount, hasPendingForLlm, markLlmDrained, and
// replayPendingForResume are all removed.
//
// These tests FAIL until the Phase 1 refactoring lands.

describe('NotificationManager — durable path (Phase 1 Step 5)', () => {
  it('emit writes directly to contextState.appendNotification instead of onEmittedToLlm', async () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();

    // Phase 1 constructor: contextState replaces onEmittedToLlm.
    // Spy on a fake contextState to verify the call.
    const appendNotificationCalls: NotificationData[] = [];
    const fakeContextState = {
      appendNotification: async (data: NotificationData) => {
        appendNotificationCalls.push(data);
      },
    };

    // Phase 1: constructor accepts contextState, NOT onEmittedToLlm
    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      contextState: fakeContextState,
    } as unknown as ConstructorParameters<typeof NotificationManager>[0]);

    await manager.emit(baseInput());

    // contextState.appendNotification must have been called
    expect(appendNotificationCalls).toHaveLength(1);
    expect(appendNotificationCalls[0]!.title).toBe('Build done');
  });

  it('does NOT have pendingLlmCount / hasPendingForLlm / markLlmDrained', () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {},
    });

    // Phase 1: these methods must not exist — notifications are durable,
    // not pending-ephemeral, so there is no LLM pending count.
    expect((manager as unknown as Record<string, unknown>)['hasPendingForLlm']).toBeUndefined();
    expect((manager as unknown as Record<string, unknown>)['markLlmDrained']).toBeUndefined();
    // The private field pendingLlmCount should not exist either, but
    // we can't directly test private fields. We verify via the absence
    // of the public API that depends on it.
  });

  it('does NOT have replayPendingForResume', () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {},
    });

    // Phase 1: replayPendingForResume is removed. Notifications are
    // durable — replay naturally reconstructs them from wire.jsonl via
    // the replay-projector, so there is no need for a special replay
    // re-inject path.
    expect((manager as unknown as Record<string, unknown>)['replayPendingForResume']).toBeUndefined();
  });
});

// ── Phase 11.4 — v2 gaps not covered by existing tests ─────────────────

describe('NotificationManager — Phase 11.4 envelope_id passthrough (Decision #103)', () => {
  it('forwards envelope_id to the durable contextState.appendNotification payload', async () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const captured: NotificationData[] = [];
    const deps: NotificationManagerDeps = {
      sessionJournal: journal,
      sessionEventBus: eventBus,
      contextState: {
        appendNotification: async (data: NotificationData) => {
          captured.push(data);
        },
      },
    };
    const manager = new NotificationManager(deps);

    await manager.emit(baseInput({ envelope_id: 'env_12345' }));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.envelope_id).toBe('env_12345');
  });

  it('omits envelope_id when the emit caller did not supply one (non-mail path)', async () => {
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const captured: NotificationData[] = [];
    const deps: NotificationManagerDeps = {
      sessionJournal: journal,
      sessionEventBus: eventBus,
      contextState: {
        appendNotification: async (data: NotificationData) => {
          captured.push(data);
        },
      },
    };
    const manager = new NotificationManager(deps);

    await manager.emit(baseInput());

    expect(captured).toHaveLength(1);
    expect(captured[0]!.envelope_id).toBeUndefined();
  });
});

describe('NotificationManager — Phase 11.4 cross-turn dedupe persistence', () => {
  it('primeDedupeIndex from a prior-turn record still dedupes a later emit', async () => {
    // Simulates Turn N emitting a durable notification, the session
    // restarting / replaying, primeDedupeIndex re-seeding the in-memory
    // map, and Turn N+K emitting the same dedupe_key — the second emit
    // must short-circuit to the original id without a new WAL write.
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();

    // First manager instance: emit + confirm it lands.
    const captured1: NotificationData[] = [];
    const deps1: NotificationManagerDeps = {
      sessionJournal: journal,
      sessionEventBus: eventBus,
      contextState: {
        appendNotification: async (d: NotificationData) => {
          captured1.push(d);
        },
      },
    };
    const mgr1 = new NotificationManager(deps1);
    const first = await mgr1.emit(baseInput({ dedupe_key: 'turn_1:done' }));
    expect(captured1).toHaveLength(1);

    // Second manager (simulating a fresh session-resume); prime with
    // the replayed record and emit the same key.
    const captured2: NotificationData[] = [];
    const deps2: NotificationManagerDeps = {
      sessionJournal: journal,
      sessionEventBus: eventBus,
      contextState: {
        appendNotification: async (d: NotificationData) => {
          captured2.push(d);
        },
      },
    };
    const mgr2 = new NotificationManager(deps2);
    mgr2.primeDedupeIndex([
      {
        type: 'notification',
        seq: 10,
        time: 10,
        data: captured1[0]!,
      } satisfies NotificationRecord,
    ]);

    const second = await mgr2.emit(baseInput({ dedupe_key: 'turn_1:done' }));
    expect(second.id).toBe(first.id);
    expect(second.deduped).toBe(true);
    // Second manager made NO durable write.
    expect(captured2).toHaveLength(0);
  });
});

describe('NotificationManager — Phase 11.4 async shell handler rejection', () => {
  it('async shell callback rejection is isolated; llm + wire still deliver', async () => {
    // TS existing coverage exercises SYNC shell throw (Case 6). Python
    // L172 additionally asserts async rejection is contained. The shell
    // callback is typed `(notif) => void`, but structural typing lets an
    // async function fit. The manager's try/catch only guards the sync
    // call; any Promise rejection escapes as an unhandled rejection.
    // This test installs a `process.once('unhandledRejection', ...)`
    // listener and drains microtasks deterministically (no wall-clock
    // setTimeout) so the assertion is stable.
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const wireSeen: NotificationData[] = [];
    eventBus.subscribeNotifications((n) => {
      wireSeen.push(n);
    });
    let llmCalled = false;

    const caught: unknown[] = [];
    const listener = (reason: unknown): void => {
      caught.push(reason);
    };
    process.once('unhandledRejection', listener);

    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      onEmittedToLlm: () => {
        llmCalled = true;
      },
      // Async shell handler that rejects. Cast to the sync signature to
      // mimic a caller that wired up `async () => { throw ... }`.
      onShellDeliver: (() =>
        Promise.reject(new Error('async shell boom'))) as unknown as (
        n: NotificationData,
      ) => void,
    });

    try {
      const result = await manager.emit(baseInput());

      // llm + wire paths still complete.
      expect(llmCalled).toBe(true);
      expect(wireSeen).toHaveLength(1);
      expect(result.id).toBeTruthy();

      // Drain two microtask rounds so the async rejection has been
      // dispatched through Node's unhandled-rejection machinery.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(
        caught.some(
          (e) => e instanceof Error && e.message.includes('async shell boom'),
        ),
      ).toBe(true);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('NotificationManager — Phase 11.4 dedupe_key absence', () => {
  it('two emits without dedupe_key are independent (not deduped)', async () => {
    // Python parity: L11 implicitly covers this; TS tests only exercise
    // WITH-key dedupe. Locking the absence branch so a regression that
    // treats "missing key" as the same dedupe bucket is caught.
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const captured: NotificationData[] = [];
    const deps: NotificationManagerDeps = {
      sessionJournal: journal,
      sessionEventBus: eventBus,
      contextState: {
        appendNotification: async (d: NotificationData) => {
          captured.push(d);
        },
      },
    };
    const manager = new NotificationManager(deps);

    const r1 = await manager.emit(baseInput({ title: 'first' }));
    const r2 = await manager.emit(baseInput({ title: 'second' }));

    expect(r1.id).not.toBe(r2.id);
    expect(r1.deduped).toBe(false);
    expect(r2.deduped).toBe(false);
    expect(captured).toHaveLength(2);
  });
});
