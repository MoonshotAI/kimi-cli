// Component: DefaultConversationProjector (§4.5.7)
// Covers: ContextSnapshot + ephemeralInjections → Message[], adjacent user
// message merge, provider-neutral output, no side effects.

import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';
import { createAssistantMessage, createUserMessage } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  type ContextSnapshot,
  DefaultConversationProjector,
  type EphemeralInjection,
} from '../../src/storage/projector.js';

function makeSnapshot(
  history: Message[],
  overrides: Partial<ContextSnapshot> = {},
): ContextSnapshot {
  // Baseline snapshots in this file intentionally use an empty system
  // prompt — the "system prompt projection" behaviour is exercised in its
  // own describe block below. Keeping the baseline empty means assertions
  // about history length / merge semantics aren't thrown off by a leading
  // system Message.
  return {
    history,
    systemPrompt: '',
    model: 'moonshot-v1',
    activeTools: new Set<string>(),
    ...overrides,
  };
}

describe('DefaultConversationProjector — passthrough', () => {
  it('returns the history unchanged when no injections are supplied', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [
      createUserMessage('hi'),
      createAssistantMessage([{ type: 'text', text: 'hello' }]),
    ];
    const out = projector.project(makeSnapshot(history), [], {});
    expect(out.length).toBe(2);
    expect(out[0]?.role).toBe('user');
    expect(out[1]?.role).toBe('assistant');
  });

  it('is idempotent (same input → same output, no mutation)', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('hi')];
    const snapshot = makeSnapshot(history);
    const out1 = projector.project(snapshot, [], {});
    const out2 = projector.project(snapshot, [], {});
    expect(out1).toEqual(out2);
    // The input history must not have been mutated either.
    expect(history.length).toBe(1);
  });
});

describe('DefaultConversationProjector — adjacent user message merge', () => {
  it('merges two consecutive user messages into one with \\n\\n separator', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('first'), createUserMessage('second')];

    const out = projector.project(makeSnapshot(history), [], {});

    // Contract (team-lead decision Q6): adjacent user messages are
    // concatenated with "\n\n" as the separator. A merged user message
    // carries exactly one TextPart whose text is "first\n\nsecond".
    const userMessages = out.filter((m) => m.role === 'user');
    expect(userMessages.length).toBe(1);
    const merged = userMessages[0]!;
    const textParts = merged.content.filter((p: ContentPart): p is TextPart => p.type === 'text');
    expect(textParts.length).toBe(1);
    expect(textParts[0]!.text).toBe('first\n\nsecond');
  });

  it('does NOT merge user messages that are separated by an assistant message', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [
      createUserMessage('q1'),
      createAssistantMessage([{ type: 'text', text: 'a1' }]),
      createUserMessage('q2'),
    ];
    const out = projector.project(makeSnapshot(history), [], {});
    expect(out.filter((m) => m.role === 'user').length).toBe(2);
  });
});

describe('DefaultConversationProjector — ephemeralInjections', () => {
  it('injects a system_reminder so the LLM sees it', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('hi')];
    const injections: EphemeralInjection[] = [
      { kind: 'system_reminder', content: 'you are in plan mode' },
    ];

    const out = projector.project(makeSnapshot(history), injections, {});
    const serialised = JSON.stringify(out);
    expect(serialised).toContain('plan mode');
  });

  it('injects a pending_notification so the LLM sees the notification body', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('hi')];
    const injections: EphemeralInjection[] = [
      {
        kind: 'pending_notification',
        content: { title: 'bg task done', body: 'the background task succeeded' },
      },
    ];
    const out = projector.project(makeSnapshot(history), injections, {});
    expect(JSON.stringify(out)).toContain('background task succeeded');
  });

  it('does not mutate the snapshot history while injecting', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('hi')];
    projector.project(makeSnapshot(history), [{ kind: 'system_reminder', content: 'r' }], {});
    expect(history.length).toBe(1);
  });
});

describe('DefaultConversationProjector — provider-neutral guarantee', () => {
  it('never includes provider-specific fields like response_format or tool_choice', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('hi')];
    const out = projector.project(makeSnapshot(history), [], {});

    const serialised = JSON.stringify(out);
    expect(serialised).not.toMatch(/response_format/);
    expect(serialised).not.toMatch(/tool_choice/);
  });
});

// Slice 1 audit M2 regression coverage:
//   Before the fix, `DefaultConversationProjector.project()` ignored
//   `snapshot.systemPrompt` entirely. The tests below lock in the
//   projector-level invariant: a non-empty systemPrompt produces a leading
//   `role: 'system'` message; an empty systemPrompt produces no such
//   message, so existing tests that don't care about system prompts keep
//   their baseline length semantics.
describe('DefaultConversationProjector — system prompt projection (Slice 1 audit M2)', () => {
  it('prepends a system Message when snapshot.systemPrompt is non-empty', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('hi')];
    const out = projector.project(
      makeSnapshot(history, { systemPrompt: 'you are a helpful assistant' }),
      [],
      {},
    );

    expect(out.length).toBe(2);
    const first = out[0]!;
    expect(first.role).toBe('system');
    const text = first.content
      .filter((p: ContentPart): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toBe('you are a helpful assistant');
    // And the history still follows the system message.
    expect(out[1]?.role).toBe('user');
  });

  it('does NOT prepend a system Message when snapshot.systemPrompt is empty ""', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('hi')];
    const out = projector.project(makeSnapshot(history, { systemPrompt: '' }), [], {});

    expect(out.length).toBe(1);
    expect(out[0]?.role).toBe('user');
  });

  it('places the system Message before ephemeral injections and before history', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('question')];
    const injections: EphemeralInjection[] = [
      { kind: 'system_reminder', content: 'remember the rules' },
    ];
    const out = projector.project(
      makeSnapshot(history, { systemPrompt: 'you are helpful' }),
      injections,
      {},
    );

    // Expected order: [system, injection-as-user, user].
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    const systemText = out[0]!.content
      .filter((p: ContentPart): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(systemText).toBe('you are helpful');
    const injectionText = out[1]!.content
      .filter((p: ContentPart): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(injectionText).toContain('remember the rules');
  });

  it('when systemPrompt is non-empty but history is empty, the output is exactly [system]', () => {
    const projector = new DefaultConversationProjector();
    const out = projector.project(makeSnapshot([], { systemPrompt: 'sp only' }), [], {});
    expect(out.length).toBe(1);
    expect(out[0]?.role).toBe('system');
  });
});
