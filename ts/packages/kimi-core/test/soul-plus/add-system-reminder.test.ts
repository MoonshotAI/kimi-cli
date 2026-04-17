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

describe('SoulPlus.addSystemReminder (Phase 1 — durable path)', () => {
  it('writes a durable system-reminder to contextState and it appears in buildMessages', async () => {
    const { soulPlus, contextState } = buildSoulPlus();
    await soulPlus.addSystemReminder('do not delete prod');

    // Phase 1: addSystemReminder writes durably via
    // contextState.appendSystemReminder — the reminder appears in
    // buildMessages as a <system-reminder> user message.
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

  it('reminder persists across multiple buildMessages calls (durable, not one-shot)', async () => {
    const { soulPlus, contextState } = buildSoulPlus();
    await soulPlus.addSystemReminder('persistent reminder');

    // Phase 1: reminders are durable — they persist across turns,
    // unlike the old one-shot ephemeral drain.
    const first = contextState.buildMessages();
    expect(first).toHaveLength(1);

    const second = contextState.buildMessages();
    // Durable: still visible on second call
    expect(second).toHaveLength(1);
    const text = second[0]!.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toContain('persistent reminder');
  });

  it('supports multiple reminders in FIFO order', async () => {
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

  it('reminder is NOT merged with an adjacent real user message', async () => {
    const { soulPlus, contextState } = buildSoulPlus();
    await contextState.appendUserMessage({ text: 'hello' });
    await soulPlus.addSystemReminder('stay polite');

    const messages = contextState.buildMessages();
    // Both messages exist as distinct entries (not merged)
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user');
    expect(messages[1]!.role).toBe('user');
    const userText = messages[0]!.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    const reminderText = messages[1]!.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(userText).toBe('hello');
    expect(reminderText).toContain('stay polite');
  });
});

describe('SoulPlus.emitNotification (Phase 1 — durable fan-out via facade)', () => {
  it('routes a category=task notification to wire + durable LLM path', async () => {
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

    // Phase 1: the LLM sink writes directly to contextState via
    // appendNotification (durable). buildMessages() should surface
    // the notification as a <notification ...> XML user message.
    const messages = contextState.buildMessages();
    const notifMsg = messages.find((m) => {
      const text = m.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
      return text.includes('<notification ');
    });
    expect(notifMsg).toBeDefined();
    const notifText = notifMsg!.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(notifText).toContain('category="task"');
    expect(notifText).toContain('CI green');
    expect(notifText.trimEnd()).toMatch(/<\/notification>$/);
  });

  it('notification is immediately visible in buildMessages without manual drain (Phase 1 durable)', async () => {
    const { soulPlus, contextState } = buildSoulPlus();

    // Phase 1: notifications write durably to contextState at emit
    // time. No beforeStep hook or manual drain needed — the next
    // buildMessages() call naturally includes the notification.
    await soulPlus.emitNotification({
      category: 'task',
      type: 'task.succeeded',
      source_kind: 'background_task',
      source_id: 'bg_mid',
      title: 'Mid-turn notification',
      body: 'Emitted while a turn is running',
      severity: 'info',
    });

    // buildMessages() should immediately see the notification
    const messages = contextState.buildMessages();
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const text = messages
      .map((m) =>
        m.content
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join(''),
      )
      .join('');
    expect(text).toContain('<notification ');
    expect(text).toContain('Mid-turn notification');
  });
});
