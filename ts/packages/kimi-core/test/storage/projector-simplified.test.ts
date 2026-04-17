/**
 * ConversationProjector signature simplification — Phase 1 Step 2.
 *
 * v2 Decision #89 removes the `ephemeralInjections` parameter from
 * `project()`. Notifications and reminders now live in
 * `snapshot.history` as durable user messages, so the projector reads
 * them naturally instead of receiving a separate injection array.
 *
 * These tests FAIL until:
 *   - `project()` signature drops the `ephemeralInjections` parameter
 *   - Notification / reminder messages in history are rendered correctly
 *   - Merge protection works for durable history entries (not just
 *     ephemeral injections)
 */

import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';
import { createAssistantMessage, createUserMessage } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  type ContextSnapshot,
  DefaultConversationProjector,
} from '../../src/storage/projector.js';

function makeSnapshot(
  history: Message[],
  overrides: Partial<ContextSnapshot> = {},
): ContextSnapshot {
  return {
    history,
    systemPrompt: '',
    model: 'test-model',
    activeTools: new Set<string>(),
    ...overrides,
  };
}

/** Create a user message that looks like a durable notification entry. */
function makeNotificationHistoryMessage(id: string, body: string): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `<notification id="${id}" category="task" type="task.done" source_kind="bg" source_id="bg_1">\nTitle: Task\nSeverity: info\n${body}\n</notification>`,
      },
    ],
    toolCalls: [],
  };
}

/** Create a user message that looks like a durable system reminder entry. */
function makeReminderHistoryMessage(content: string): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `<system-reminder>\n${content}\n</system-reminder>`,
      },
    ],
    toolCalls: [],
  };
}

describe('ConversationProjector — simplified signature (Phase 1 Step 2)', () => {
  it('project() works with two arguments (snapshot, options) — no ephemeralInjections', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('hello')];

    // Phase 1 contract: project(snapshot, options) — 2 args, not 3.
    // Currently fails because the signature requires 3 args:
    //   project(snapshot, ephemeralInjections, options)
    const out = (projector as unknown as {
      project(snapshot: ContextSnapshot, options: Record<string, unknown>): Message[];
    }).project(makeSnapshot(history), {});

    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('user');
  });
});

describe('ConversationProjector — durable notification from history (Phase 1 Step 2)', () => {
  it('notification in snapshot.history is rendered in the output', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [
      makeNotificationHistoryMessage('n_hist1', 'Build completed'),
      createUserMessage('what happened?'),
    ];

    // Even with the current 3-arg signature, this test verifies that
    // notification messages stored directly in history appear in output.
    const out = projector.project(makeSnapshot(history), [], {});

    expect(out.length).toBeGreaterThanOrEqual(2);
    const notifMsg = out.find((m) => {
      const text = m.content
        .filter((p): p is TextPart => p.type === 'text')
        .map((p) => p.text)
        .join('');
      return text.includes('<notification');
    });
    expect(notifMsg).toBeDefined();
  });

  it('system reminder in snapshot.history is rendered in the output', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [
      makeReminderHistoryMessage('Plan mode is active.'),
      createUserMessage('next step?'),
    ];

    const out = projector.project(makeSnapshot(history), [], {});

    const reminderMsg = out.find((m) => {
      const text = m.content
        .filter((p): p is TextPart => p.type === 'text')
        .map((p) => p.text)
        .join('');
      return text.includes('<system-reminder>');
    });
    expect(reminderMsg).toBeDefined();
  });
});

describe('ConversationProjector — durable merge protection (Phase 1 Step 2)', () => {
  it('notification in history is NOT merged with the next user message', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [
      makeNotificationHistoryMessage('n_nomerge', 'Task done'),
      createUserMessage('what next?'),
    ];

    const out = projector.project(makeSnapshot(history), [], {});

    // Both messages must survive as distinct entries
    expect(out).toHaveLength(2);
    const texts = out.map((m) =>
      m.content
        .filter((p): p is TextPart => p.type === 'text')
        .map((p) => p.text)
        .join(''),
    );
    expect(texts[0]).toContain('<notification');
    expect(texts[1]).toBe('what next?');
  });

  it('system reminder in history is NOT merged with the next user message', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [
      makeReminderHistoryMessage('Plan mode is active.'),
      createUserMessage('tell me the plan'),
    ];

    const out = projector.project(makeSnapshot(history), [], {});

    expect(out).toHaveLength(2);
    const texts = out.map((m) =>
      m.content
        .filter((p): p is TextPart => p.type === 'text')
        .map((p) => p.text)
        .join(''),
    );
    expect(texts[0]).toContain('<system-reminder>');
    expect(texts[1]).toBe('tell me the plan');
  });

  it('notification between two user messages prevents those users from merging', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [
      createUserMessage('first user message'),
      makeNotificationHistoryMessage('n_mid', 'Mid-convo notification'),
      createUserMessage('second user message'),
    ];

    const out = projector.project(makeSnapshot(history), [], {});

    // All three messages must remain separate: the notification acts as a
    // barrier that prevents the two user messages from merging.
    expect(out).toHaveLength(3);
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(['user', 'user', 'user']);
    // First and third are real user messages; middle is the notification
    const midText = out[1]!.content
      .filter((p): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(midText).toContain('<notification');
  });
});
