/**
 * Context message contract — Phase 11.2 core invariants.
 *
 * Selected from Python `tests/core/test_context.py` (19 tests). The
 * Python suite is predominantly system-prompt-file roundtrips that v2
 * no longer persists (decision #89: notification / system_reminder are
 * wire-durable user messages, not a separate file). We migrate the
 * invariants that remain load-bearing under v2:
 *
 *   1. appendUserMessage → buildMessages immediately reflects the write
 *      (mirror-after-WAL invariant).
 *   2. assistant → user → assistant sequence preserves ordering.
 *   3. tool_call_order: tool_result follows the matching assistant.
 *   4. Adjacent user messages merge with "\n\n" in the projection
 *      (mergeAdjacentUserMessages — ported from Python Q6 decision).
 *   5. A notification-injected user message is NOT merged into an
 *      adjacent real user turn (Python `is_notification_message`).
 *   6. initialHistory seeds the projection without re-writing WAL
 *      (replay-driven resume contract).
 *   7. drainSteerMessages is idempotent-empty: second call returns [].
 *   8. appendNotification becomes a `<notification ...>` user message
 *      durably stored in history (Decision #89 push-durable).
 */

import { describe, expect, it } from 'vitest';

import {
  InMemoryContextState,
  type InMemoryContextStateOptions,
} from '../../src/storage/context-state.js';
import type { Message } from '@moonshot-ai/kosong';

function makeState(opts?: Partial<InMemoryContextStateOptions>): InMemoryContextState {
  return new InMemoryContextState({
    initialModel: 'moonshot-v1',
    initialSystemPrompt: '',
    ...opts,
  });
}

describe('ContextState message contract — Phase 11.2', () => {
  it('appendUserMessage writes the message through to the next buildMessages() call', async () => {
    const state = makeState();
    expect(state.buildMessages()).toHaveLength(0);

    await state.appendUserMessage({ text: 'hello world' });

    const msgs = state.buildMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content[0]).toMatchObject({ type: 'text', text: 'hello world' });
  });

  it('user → assistant → user → assistant preserves ordering in buildMessages()', async () => {
    const state = makeState();
    await state.appendUserMessage({ text: 'q1' });
    await state.appendAssistantMessage({
      text: 'a1',
      think: null,
      toolCalls: [],
      model: 'moonshot-v1',
    });
    await state.appendUserMessage({ text: 'q2' });
    await state.appendAssistantMessage({
      text: 'a2',
      think: null,
      toolCalls: [],
      model: 'moonshot-v1',
    });

    const roles = state.buildMessages().map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('tool_result follows its matching assistant message in the projection', async () => {
    const state = makeState();
    await state.appendUserMessage({ text: 'use the tool' });
    await state.appendAssistantMessage({
      text: null,
      think: null,
      toolCalls: [{ id: 'tc_1', name: 'Echo', args: { msg: 'hi' } }],
      model: 'moonshot-v1',
    });
    await state.appendToolResult(undefined, 'tc_1', { output: 'hi' });

    const msgs = state.buildMessages();
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const toolMessage = msgs[2]!;
    expect(toolMessage.toolCalls).toHaveLength(0);
    expect(toolMessage.content[0]).toMatchObject({ type: 'text', text: 'hi' });
  });

  it('adjacent real user messages merge with a blank-line separator in the projection', async () => {
    const state = makeState();
    await state.appendUserMessage({ text: 'part one' });
    await state.appendUserMessage({ text: 'part two' });

    const msgs = state.buildMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
    const text = msgs[0]!.content
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('');
    expect(text).toBe('part one\n\npart two');
  });

  it('notification-wrapped user messages are NOT merged into a trailing real user turn', async () => {
    // The projector's mergeAdjacentUserMessages must skip any user
    // message whose text starts with `<notification ` (or
    // `<system-reminder>`) so the injection wrapper stays intact.
    const state = makeState();
    await state.appendNotification({
      id: 'n_1',
      category: 'system',
      type: 'info',
      source_kind: 'system',
      source_id: 'sys',
      title: 'Heads up',
      severity: 'info',
      body: 'build finished',
      targets: ['llm', 'wire'],
    });
    await state.appendUserMessage({ text: 'ack' });

    const msgs = state.buildMessages();
    // Two distinct user messages — injection wrapper + real ack.
    expect(msgs).toHaveLength(2);
    const firstText = (msgs[0]!.content[0] as { text: string }).text;
    const secondText = (msgs[1]!.content[0] as { text: string }).text;
    expect(firstText.startsWith('<notification ')).toBe(true);
    expect(secondText).toBe('ack');
  });

  it('initialHistory seeds the projection without requiring WAL writes', () => {
    const seed: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'seed-user' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'seed-assistant' }],
        toolCalls: [],
      },
    ];
    const state = new InMemoryContextState({
      initialModel: 'moonshot-v1',
      initialSystemPrompt: '',
      initialHistory: seed,
    });

    const msgs = state.buildMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('drainSteerMessages returns buffered entries exactly once', () => {
    const state = makeState();
    state.pushSteer({ text: 'wait' });
    state.pushSteer({ text: 'also this' });
    const drained = state.drainSteerMessages();
    expect(drained.map((s) => s.text)).toEqual(['wait', 'also this']);
    expect(state.drainSteerMessages()).toEqual([]);
  });

  it('appendNotification lands a durable <notification ...> user message in history', async () => {
    const state = makeState();
    await state.appendNotification({
      id: 'n_42',
      category: 'task',
      type: 'build',
      source_kind: 'system',
      source_id: 'sys',
      title: 'Build green',
      severity: 'info',
      body: 'all green',
      targets: ['llm', 'wire'],
    });

    // Both buildMessages() and the raw history view must include the
    // notification — it is NOT an ephemeral stash, it lives in history.
    const history = state.getHistory();
    expect(history).toHaveLength(1);
    const projected = state.buildMessages();
    expect(projected).toHaveLength(1);
    const text = (projected[0]!.content[0] as { text: string }).text;
    expect(text.startsWith('<notification id="n_42"')).toBe(true);
    expect(text).toContain('all green');
  });
});
