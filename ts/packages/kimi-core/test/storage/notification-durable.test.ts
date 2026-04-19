/**
 * Notification / SystemReminder Durable Write — Phase 1.
 *
 * v2 Decision #89: notification/system_reminder/memory_recall walk
 * ContextState durable write, NOT ephemeral injection. This suite
 * verifies that:
 *   - ContextState exposes `appendNotification` / `appendSystemReminder`
 *   - Written entries appear in `buildMessages()` wrapped in XML tags
 *   - Written entries persist across turns (durable, not one-shot)
 *   - Replay rebuilds the entries from wire records
 *   - Merge protection keeps notifications/reminders as separate messages
 *   - Normal conversation flow is unaffected
 *
 * All tests FAIL on the current codebase because `appendNotification`
 * and `appendSystemReminder` do not exist on ContextState yet.
 */

import type { TextPart } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { InMemoryContextState, type FullContextState } from '../../src/storage/context-state.js';

/** Helper: extract all text from a message's content parts. */
function extractText(msg: { content: Array<{ type: string; text?: string }> }): string {
  return msg.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Helper: check if any message in the list contains the given substring. */
function anyMessageContains(
  messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>,
  substring: string,
): boolean {
  return messages.some((m) => extractText(m).includes(substring));
}

describe('appendNotification durable (Phase 1 — Decision #89)', () => {
  it('notification written via appendNotification appears in buildMessages()', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    // New API: FullContextState.appendNotification — writes a
    // NotificationRecord to the WAL and a <notification> user message to
    // the in-memory history. Currently fails: method does not exist.
    await (ctx as unknown as FullContextState & {
      appendNotification(data: Record<string, unknown>): Promise<void>;
    }).appendNotification({
      id: 'n_test1',
      category: 'task',
      type: 'task.succeeded',
      source_kind: 'background_task',
      source_id: 'bg_1',
      title: 'Build done',
      body: 'Build passed',
      severity: 'success',
      targets: ['llm', 'wire', 'shell'],
    });

    const messages = ctx.buildMessages();
    const notifMsg = messages.find(
      (m) => m.role === 'user' && extractText(m).includes('<notification'),
    );
    expect(notifMsg).toBeDefined();
    expect(extractText(notifMsg!)).toContain('n_test1');
    expect(extractText(notifMsg!)).toContain('Build done');
  });

  it('notification persists across turns (Turn N+1 still sees it)', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    await (ctx as unknown as FullContextState & {
      appendNotification(data: Record<string, unknown>): Promise<void>;
    }).appendNotification({
      id: 'n_persist',
      category: 'task',
      type: 'task.done',
      source_kind: 'background_task',
      source_id: 'bg_2',
      title: 'Persistent',
      body: 'This should persist',
      severity: 'info',
      targets: ['llm'],
    });

    // Turn N: notification visible
    const msgs1 = ctx.buildMessages();
    expect(anyMessageContains(msgs1, 'n_persist')).toBe(true);

    // Simulate a full turn: user → assistant
    await ctx.appendUserMessage({ text: 'hello' });
    await ctx.appendAssistantMessage({
      text: 'hi there',
      think: null,
      toolCalls: [],
      model: 'test-model',
    });

    // Turn N+1: notification STILL visible (durable, not one-shot)
    const msgs2 = ctx.buildMessages();
    expect(anyMessageContains(msgs2, 'n_persist')).toBe(true);
  });
});

describe('appendSystemReminder durable (Phase 1 — Decision #89)', () => {
  it('system reminder appears in buildMessages() with <system-reminder> wrapper', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    // New API: FullContextState.appendSystemReminder — writes a
    // SystemReminderRecord to the WAL and a <system-reminder> user message
    // to the in-memory history. Currently fails: method does not exist.
    await (ctx as unknown as FullContextState & {
      appendSystemReminder(data: { content: string }): Promise<void>;
    }).appendSystemReminder({
      content: 'Plan mode is active. You MUST NOT make any edits.',
    });

    const messages = ctx.buildMessages();
    const reminderMsg = messages.find(
      (m) => m.role === 'user' && extractText(m).includes('<system-reminder>'),
    );
    expect(reminderMsg).toBeDefined();
    expect(extractText(reminderMsg!)).toContain('Plan mode is active');
  });

  it('system reminder persists across multiple turns', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    await (ctx as unknown as FullContextState & {
      appendSystemReminder(data: { content: string }): Promise<void>;
    }).appendSystemReminder({
      content: 'Persistent reminder content',
    });

    // Simulate 3 turns
    for (let i = 0; i < 3; i++) {
      await ctx.appendUserMessage({ text: `turn ${i}` });
      await ctx.appendAssistantMessage({
        text: `response ${i}`,
        think: null,
        toolCalls: [],
        model: 'test-model',
      });
    }

    const messages = ctx.buildMessages();
    expect(anyMessageContains(messages, 'Persistent reminder content')).toBe(true);
  });
});

describe('Replay recovery (Phase 1)', () => {
  it('notification survives ContextState rebuild from initialHistory', async () => {
    // Phase 1 contract: notifications are stored in history as user
    // messages. When ContextState is rebuilt from replayed wire records,
    // the initialHistory array already contains the notification message,
    // so it is visible in the rebuilt context's buildMessages() output.

    // Build original context with a notification
    const ctx1 = new InMemoryContextState({ initialModel: 'test-model' });
    await (ctx1 as unknown as FullContextState & {
      appendNotification(data: Record<string, unknown>): Promise<void>;
    }).appendNotification({
      id: 'n_replay',
      category: 'system',
      type: 'system.info',
      source_kind: 'system',
      source_id: 'sys_1',
      title: 'System notice',
      body: 'Important info',
      severity: 'info',
      targets: ['llm'],
    });

    const originalMsgs = ctx1.buildMessages();
    expect(anyMessageContains(originalMsgs, 'n_replay')).toBe(true);

    // Simulate replay: create new ContextState with the original history
    // In the new architecture, replay builds initialHistory from wire
    // records, which includes the notification user message.
    const ctx2 = new InMemoryContextState({
      initialModel: 'test-model',
      initialHistory: originalMsgs,
    });

    const replayedMsgs = ctx2.buildMessages();
    expect(anyMessageContains(replayedMsgs, 'n_replay')).toBe(true);
  });
});

describe('Merge protection (Phase 1)', () => {
  it('notification messages are NOT merged with adjacent user messages', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    // Write a notification then a user message back-to-back
    await (ctx as unknown as FullContextState & {
      appendNotification(data: Record<string, unknown>): Promise<void>;
    }).appendNotification({
      id: 'n_nomerge',
      category: 'task',
      type: 'task.done',
      source_kind: 'background_task',
      source_id: 'bg_3',
      title: 'Task done',
      body: 'Complete',
      severity: 'success',
      targets: ['llm'],
    });
    await ctx.appendUserMessage({ text: 'user input here' });

    const messages = ctx.buildMessages();

    // Both should exist as separate messages
    const notifMsg = messages.find(
      (m) => m.role === 'user' && extractText(m).includes('<notification'),
    );
    const userMsg = messages.find(
      (m) => m.role === 'user' && extractText(m).includes('user input here'),
    );
    expect(notifMsg).toBeDefined();
    expect(userMsg).toBeDefined();
    // They must be distinct message objects (not merged)
    expect(notifMsg).not.toBe(userMsg);
  });

  it('system reminder messages are NOT merged with adjacent user messages', async () => {
    const ctx = new InMemoryContextState({ initialModel: 'test-model' });

    await (ctx as unknown as FullContextState & {
      appendSystemReminder(data: { content: string }): Promise<void>;
    }).appendSystemReminder({
      content: 'Plan mode is active.',
    });
    await ctx.appendUserMessage({ text: 'my prompt' });

    const messages = ctx.buildMessages();

    const reminderMsg = messages.find(
      (m) => m.role === 'user' && extractText(m).includes('<system-reminder>'),
    );
    const userMsg = messages.find(
      (m) => m.role === 'user' && extractText(m).includes('my prompt'),
    );
    expect(reminderMsg).toBeDefined();
    expect(userMsg).toBeDefined();
    expect(reminderMsg).not.toBe(userMsg);
  });
});

describe('Existing functionality regression (Phase 1)', () => {
  it('normal conversation flow (user → assistant → tool → assistant) is unaffected', async () => {
    const ctx = new InMemoryContextState({
      initialModel: 'test-model',
      initialSystemPrompt: '',
    });

    await ctx.appendUserMessage({ text: 'Please run a command' });
    await ctx.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_1', name: 'bash', args: { command: 'ls' } }],
      model: 'test-model',
    });
    await ctx.appendToolResult(undefined, 'tc_1', { output: 'file1.txt\nfile2.txt' });
    await ctx.appendAssistantMessage({
      text: 'Here are your files',
      think: null,
      toolCalls: [],
      model: 'test-model',
    });

    const messages = ctx.buildMessages();
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });
});
