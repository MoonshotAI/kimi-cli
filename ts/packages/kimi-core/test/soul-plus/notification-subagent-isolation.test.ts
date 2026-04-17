/**
 * Phase 11.4 — subagent NotificationManager isolation (Phase 6 / 决策 #88).
 *
 * Each subagent runs its own `SoulPlus` instance with its own
 * `NotificationManager` bound to the child's WiredContextState +
 * SessionEventBus. Notifications emitted by the child MUST land only
 * on the child's durable history; the parent's NotificationManager
 * must not see the child's dedupe keys, and vice versa.
 *
 * Current TS architecture (src/soul-plus/soul-plus.ts:248) constructs
 * the NotificationManager with the enclosing SoulPlus's contextState
 * and eventBus — so the isolation is structural. This test locks the
 * invariant at the unit level without spinning up a full subagent
 * subprocess, by constructing two independent manager + contextState
 * pairs and asserting their durable writes + dedupe indices do not
 * cross.
 */

import { describe, expect, it } from 'vitest';

import {
  NotificationManager,
  SessionEventBus,
  type NotificationData,
  type NotificationManagerDeps,
} from '../../src/soul-plus/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';

function buildInput(overrides: Partial<Parameters<NotificationManager['emit']>[0]> = {}) {
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

function makeManagerPair() {
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
  return { journal, eventBus, manager, captured };
}

describe('NotificationManager — subagent isolation (Phase 6 / 决策 #88)', () => {
  it('parent and subagent managers keep independent durable histories', async () => {
    const parent = makeManagerPair();
    const child = makeManagerPair();

    await parent.manager.emit(buildInput({ title: 'parent only' }));
    await child.manager.emit(buildInput({ title: 'child only' }));

    // Each side only observed its own emit.
    expect(parent.captured).toHaveLength(1);
    expect(parent.captured[0]!.title).toBe('parent only');
    expect(child.captured).toHaveLength(1);
    expect(child.captured[0]!.title).toBe('child only');
  });

  it('dedupe index does not leak from parent to subagent or back', async () => {
    const parent = makeManagerPair();
    const child = makeManagerPair();

    // Parent emits with dedupe_key 'k' — child should NOT see its dedupe.
    const parentResult = await parent.manager.emit(
      buildInput({ dedupe_key: 'shared_key', title: 'parent emit' }),
    );
    expect(parentResult.deduped).toBe(false);

    // Child's first emit with the same key is a fresh emit — not deduped.
    const childResult = await child.manager.emit(
      buildInput({ dedupe_key: 'shared_key', title: 'child emit' }),
    );
    expect(childResult.deduped).toBe(false);
    expect(childResult.id).not.toBe(parentResult.id);

    // Both sides durably recorded exactly their own emit.
    expect(parent.captured).toHaveLength(1);
    expect(parent.captured[0]!.title).toBe('parent emit');
    expect(child.captured).toHaveLength(1);
    expect(child.captured[0]!.title).toBe('child emit');
  });

  it('wire fan-out is scoped to each manager\'s own SessionEventBus', async () => {
    const parent = makeManagerPair();
    const child = makeManagerPair();

    const parentWire: NotificationData[] = [];
    const childWire: NotificationData[] = [];
    parent.eventBus.subscribeNotifications((n) => {
      parentWire.push(n);
    });
    child.eventBus.subscribeNotifications((n) => {
      childWire.push(n);
    });

    await parent.manager.emit(buildInput({ title: 'p1' }));
    await child.manager.emit(buildInput({ title: 'c1' }));

    expect(parentWire.map((n) => n.title)).toEqual(['p1']);
    expect(childWire.map((n) => n.title)).toEqual(['c1']);
  });
});
