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

// Slice 2.4 — XML wrapper + merge-guard regression suite
describe('DefaultConversationProjector — Slice 2.4 notification XML wrapping', () => {
  it('renders a pending_notification object as a <notification> XML tag with attributes', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('hi')];
    const injections: EphemeralInjection[] = [
      {
        kind: 'pending_notification',
        content: {
          id: 'n_abc123',
          category: 'task',
          type: 'task.succeeded',
          source_kind: 'background_task',
          source_id: 'bg_7',
          title: 'Build done',
          body: 'All tests passed',
          severity: 'success',
          targets: ['llm', 'wire'],
        },
      },
    ];
    const out = projector.project(makeSnapshot(history), injections, {});
    const firstText = (out[0]!.content[0] as TextPart).text;
    expect(firstText).toMatch(/^<notification id="n_abc123"/);
    expect(firstText).toContain('category="task"');
    expect(firstText).toContain('type="task.succeeded"');
    expect(firstText).toContain('source_kind="background_task"');
    expect(firstText).toContain('source_id="bg_7"');
    expect(firstText).toContain('Title: Build done');
    expect(firstText).toContain('Severity: success');
    expect(firstText).toContain('All tests passed');
    expect(firstText.trimEnd()).toMatch(/<\/notification>$/);
  });

  it('renders a system_reminder injection as <system-reminder> XML', () => {
    const projector = new DefaultConversationProjector();
    const out = projector.project(
      makeSnapshot([createUserMessage('hi')]),
      [{ kind: 'system_reminder', content: 'you are in plan mode' }],
      {},
    );
    const firstText = (out[0]!.content[0] as TextPart).text;
    expect(firstText).toMatch(/^<system-reminder>/);
    expect(firstText).toContain('plan mode');
    expect(firstText.trimEnd()).toMatch(/<\/system-reminder>$/);
  });

  it('does not merge an injected notification user message with the following real user message', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('what is next?')];
    const injections: EphemeralInjection[] = [
      {
        kind: 'pending_notification',
        content: {
          id: 'n_x',
          category: 'task',
          type: 'task.done',
          source_kind: 'bg',
          source_id: 'bg_1',
          title: 't',
          body: 'b',
          severity: 'info',
          targets: ['llm'],
        },
      },
    ];
    const out = projector.project(makeSnapshot(history), injections, {});
    // Without the merge-guard, mergeAdjacentUserMessages would fold
    // the two user messages into one and smear the XML into the
    // user's prompt. We assert that both messages survive as
    // distinct entries.
    expect(out).toHaveLength(2);
    const injectionText = (out[0]!.content[0] as TextPart).text;
    const userText = (out[1]!.content[0] as TextPart).text;
    expect(injectionText).toMatch(/^<notification /);
    expect(userText).toBe('what is next?');
  });

  it('does not treat "<notificationally ..." as an injection (Minor1 — narrow predicate)', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [
      createUserMessage('<notificationally this is user text'),
      createUserMessage('follow up'),
    ];
    const out = projector.project(makeSnapshot(history), [], {});
    // These should merge because "<notificationally" is NOT a notification tag
    expect(out).toHaveLength(1);
    const mergedText = (out[0]!.content[0] as TextPart).text;
    expect(mergedText).toContain('<notificationally');
    expect(mergedText).toContain('follow up');
  });

  it('does not treat "<notification>" (no attributes) as an injection (Minor1)', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [
      createUserMessage('<notification>user typed this literally'),
      createUserMessage('another message'),
    ];
    const out = projector.project(makeSnapshot(history), [], {});
    // No space after <notification → not an injection → should merge
    expect(out).toHaveLength(1);
  });

  it('detects injection with leading whitespace via trimStart (Minor1)', () => {
    const projector = new DefaultConversationProjector();
    // Simulate an injection message that has leading whitespace
    const history: Message[] = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: '  <notification id="n_1" category="task" type="t" source_kind="s" source_id="s1">\nbody\n</notification>',
          },
        ],
        toolCalls: [],
      },
      createUserMessage('real user message'),
    ];
    const out = projector.project(makeSnapshot(history), [], {});
    // Should NOT merge — the leading-whitespace notification is still an injection
    expect(out).toHaveLength(2);
  });

  it('still merges two real user messages (no false positive on non-injection content)', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('hello'), createUserMessage('there')];
    const out = projector.project(makeSnapshot(history), [], {});
    expect(out).toHaveLength(1);
    const mergedText = (out[0]!.content[0] as TextPart).text;
    expect(mergedText).toBe('hello\n\nthere');
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

// Slice 2.0 方案 B: system prompt is NO LONGER injected by the projector.
// It is forwarded as ChatParams.systemPrompt → provider.generate() directly.
// The projector must NOT prepend a system message, to avoid double injection.
describe('DefaultConversationProjector — system prompt NOT projected (Slice 2.0 方案 B)', () => {
  it('does NOT prepend a system Message even when snapshot.systemPrompt is non-empty', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [createUserMessage('hi')];
    const out = projector.project(
      makeSnapshot(history, { systemPrompt: 'you are a helpful assistant' }),
      [],
      {},
    );

    // No system message — only the user message.
    expect(out.length).toBe(1);
    expect(out[0]?.role).toBe('user');
  });

  it('ephemeral injections appear before history (no system message prefix)', () => {
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

    // Expected order: [injection-as-user, user]. No system message.
    expect(out.map((m) => m.role)).toEqual(['user', 'user']);
    const injectionText = out[0]!.content
      .filter((p: ContentPart): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(injectionText).toContain('remember the rules');
  });

  it('when systemPrompt is non-empty but history is empty, the output is empty', () => {
    const projector = new DefaultConversationProjector();
    const out = projector.project(makeSnapshot([], { systemPrompt: 'sp only' }), [], {});
    expect(out.length).toBe(0);
  });
});
