/**
 * SoulPlus.addSystemReminder — Slice 2.4 end-to-end closure.
 *
 * This is the Phase 1 Slice 8 audit M1 regression:
 *   addSystemReminder("hello") → next buildMessages() returns a synthetic
 *   user message wrapped in <system-reminder>...</system-reminder>.
 *
 * We exercise the SoulPlus public API (not NotificationManager directly)
 * so the WAL-then-mirror contract is validated from the real entry
 * point.
 */

import { describe, expect, it } from 'vitest';

import { SessionEventBus, SoulPlus, createRuntime } from '../../src/soul-plus/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import type { SystemReminderRecord } from '../../src/storage/wire-record.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
  createSpyLifecycleGate,
} from './fixtures/slice3-harness.js';

function buildSoulPlus() {
  const contextState = createHarnessContextState();
  const sessionJournal = new InMemorySessionJournalImpl();
  const runtime = createRuntime({
    kosong: new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('ok')] }),
    lifecycle: createSpyLifecycleGate(),
    compactionProvider: createNoopCompactionProvider(),
    journal: createNoopJournalCapability(),
  });
  const eventBus = new SessionEventBus();
  const soulPlus = new SoulPlus({
    sessionId: 'ses_slice2_4',
    contextState,
    sessionJournal,
    runtime,
    eventBus,
    tools: [],
  });
  return { soulPlus, contextState, sessionJournal, eventBus };
}

describe('SoulPlus.addSystemReminder (Slice 2.4 M1 closure)', () => {
  it('WAL-writes a SystemReminderRecord and primes the next buildMessages injection', async () => {
    const { soulPlus, contextState, sessionJournal } = buildSoulPlus();
    await soulPlus.addSystemReminder('do not delete prod');

    // WAL side
    const reminders = sessionJournal.getRecordsByType('system_reminder');
    expect(reminders).toHaveLength(1);
    const reminder = reminders[0] as SystemReminderRecord;
    expect(reminder.content).toBe('do not delete prod');

    // Mirror side — the next buildMessages() output contains the
    // XML-wrapped reminder as a prepended synthetic user message.
    const messages = contextState.buildMessages();
    expect(messages).toHaveLength(1);
    const first = messages[0]!;
    expect(first.role).toBe('user');
    const text = first.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toMatch(/^<system-reminder>/);
    expect(text).toContain('do not delete prod');
    expect(text.trimEnd()).toMatch(/<\/system-reminder>$/);
  });

  it('a second buildMessages() does not re-emit the injection (one-shot drain)', async () => {
    const { soulPlus, contextState } = buildSoulPlus();
    await soulPlus.addSystemReminder('ephemeral once');

    contextState.buildMessages(); // drain
    const again = contextState.buildMessages();
    // No history was written, so the second projection is empty.
    expect(again).toHaveLength(0);
  });

  it('supports multiple reminders in FIFO order before the next drain', async () => {
    const { soulPlus, contextState } = buildSoulPlus();
    await soulPlus.addSystemReminder('first');
    await soulPlus.addSystemReminder('second');

    const messages = contextState.buildMessages();
    expect(messages).toHaveLength(2);
    const firstText = messages[0]!.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    const secondText = messages[1]!.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(firstText).toContain('first');
    expect(secondText).toContain('second');
  });

  it('reminder sits before a real user turn rather than being merged with it', async () => {
    const { soulPlus, contextState } = buildSoulPlus();
    await contextState.appendUserMessage({ text: 'hello' });
    await soulPlus.addSystemReminder('stay polite');

    const messages = contextState.buildMessages();
    // Injection prepended → 2 messages, not 1 merged
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user');
    expect(messages[1]!.role).toBe('user');
    const injectionText = messages[0]!.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    const userText = messages[1]!.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(injectionText).toContain('stay polite');
    expect(userText).toBe('hello');
  });
});

describe('SoulPlus.emitNotification (Slice 2.4 fan-out via facade)', () => {
  it('routes a category=task notification to all three targets', async () => {
    const { soulPlus, contextState, eventBus } = buildSoulPlus();
    const wireSeen: Array<{ title: string }> = [];
    eventBus.subscribeNotifications((n) => {
      wireSeen.push({ title: n.title });
    });

    const result = await soulPlus.emitNotification({
      category: 'task',
      type: 'task.succeeded',
      source_kind: 'background_task',
      source_id: 'bg_99',
      title: 'CI green',
      body: 'Build passed on main',
      severity: 'success',
    });
    expect(result.deduped).toBe(false);
    expect(wireSeen).toHaveLength(1);
    expect(wireSeen[0]!.title).toBe('CI green');

    // The LLM sink lands in TurnManager.pendingNotifications; the next
    // turn's launchTurn drain would flush it. For this test we assert
    // on the TurnManager-exposed getter.
    const pending = soulPlus.getTurnManager().getPendingNotifications();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.title).toBe('CI green');

    // Force the mirror path — stashing the notification into
    // contextState and re-building messages should produce the XML
    // notification tag.
    soulPlus.getTurnManager().drainPendingNotificationsIntoContext();
    const messages = contextState.buildMessages();
    const firstText = messages[0]!.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(firstText).toMatch(/^<notification /);
    expect(firstText).toContain('category="task"');
    expect(firstText).toContain('type="task.succeeded"');
    expect(firstText).toContain('source_kind="background_task"');
    expect(firstText).toContain('source_id="bg_99"');
    expect(firstText).toContain('CI green');
    expect(firstText.trimEnd()).toMatch(/<\/notification>$/);
  });

  it('M3 — mid-turn notifications flush via ContextState.beforeStep wired by TurnManager', async () => {
    const { soulPlus, contextState } = buildSoulPlus();

    // Emit a notification mid-turn — it lands in
    // TurnManager.pendingNotifications (the LLM sink), NOT in the
    // ContextState stash. Without the M3 fix, only a fresh
    // `launchTurn` would drain it, so the CURRENT turn's next step
    // would never see it via `buildMessages()`.
    await soulPlus.emitNotification({
      category: 'task',
      type: 'task.succeeded',
      source_kind: 'background_task',
      source_id: 'bg_mid',
      title: 'Mid-turn notification',
      body: 'Emitted while a turn is running',
      severity: 'info',
    });

    // Precondition: the notification is queued on TurnManager.
    expect(soulPlus.getTurnManager().getPendingNotifications()).toHaveLength(1);

    // TurnManager should have wired beforeStep on contextState at
    // construction (M3 fix). This is what `runSoulTurn` calls before
    // each step's `buildMessages()` — simulate that sequence here.
    expect(contextState.beforeStep).toBeDefined();
    contextState.beforeStep!();
    const messages = contextState.buildMessages();

    // The notification now appears as a <notification ...> prefix —
    // without the beforeStep hook, buildMessages would return empty
    // because its one-shot stash would not have been primed.
    expect(messages).toHaveLength(1);
    const text = messages[0]!.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toMatch(/^<notification /);
    expect(text).toContain('Mid-turn notification');

    // And the TurnManager queue has been drained.
    expect(soulPlus.getTurnManager().getPendingNotifications()).toHaveLength(0);
  });
});
