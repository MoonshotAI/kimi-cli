// Component: InMemoryContextState (§4.5.5)
// Covers: same FullContextState interface as WiredContextState, but no
// physical writes — verifies that embed/test callers get a drop-in
// implementation.

import { describe, expect, it } from 'vitest';

import { InMemoryContextState } from '../../src/storage/context-state.js';

function make(): InMemoryContextState {
  return new InMemoryContextState({
    initialModel: 'moonshot-v1',
    initialSystemPrompt: 'sp',
  });
}

describe('InMemoryContextState — interface parity', () => {
  it('exposes the constructor defaults', () => {
    const state = make();
    expect(state.model).toBe('moonshot-v1');
    expect(state.systemPrompt).toBe('sp');
    expect(state.buildMessages()).toEqual([]);
  });

  it('appendUserMessage + appendAssistantMessage round-trip through buildMessages', async () => {
    const state = make();
    await state.appendUserMessage({ text: 'hi' });
    await state.appendAssistantMessage({
      text: 'hello',
      think: null,
      toolCalls: [],
      model: 'moonshot-v1',
    });

    const msgs = state.buildMessages();
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('applyConfigChange mutates the in-memory projection without any disk touch', async () => {
    const state = make();
    await state.applyConfigChange({
      type: 'system_prompt_changed',
      new_prompt: 'new sp',
    });
    expect(state.systemPrompt).toBe('new sp');
    await state.applyConfigChange({
      type: 'model_changed',
      old_model: 'moonshot-v1',
      new_model: 'gpt-4.1',
    });
    expect(state.model).toBe('gpt-4.1');
  });

  it('drainSteerMessages drains exactly once', () => {
    const state = make();
    state.pushSteer({ text: 'also X' });
    expect(state.drainSteerMessages().map((s) => s.text)).toEqual(['also X']);
    expect(state.drainSteerMessages()).toEqual([]);
  });

  it('resetToSummary replaces the live history with at most a synthetic summary', async () => {
    const state = make();
    await state.appendUserMessage({ text: 'q1' });
    await state.appendAssistantMessage({
      text: 'a1',
      think: null,
      toolCalls: [],
      model: 'moonshot-v1',
    });
    await state.resetToSummary({
      summary: 'summary text',
      compactedRange: { fromTurn: 0, toTurn: 0, messageCount: 2 },
      preCompactTokens: 1000,
      postCompactTokens: 100,
      trigger: 'auto',
    });

    expect(state.buildMessages().length).toBeLessThanOrEqual(1);
  });
});

describe('InMemoryContextState — no physical side effects', () => {
  // NOTE: Modified by coordinator during Slice 1 Phase 3 to resolve a conflict with
  // the Q6 projector-merge rule (PHASE1_PROGRESS.md decision log). The original length
  // assertion (=== 50) assumed no merge; Q6 locks merge semantics in projector.
  // This test now verifies both the merge invariant and no-message-loss semantics.
  it('does not reach out to the filesystem regardless of call volume', async () => {
    // Any attempt to open a file would throw since the stub JournalWriter
    // is meant to be a pure no-op. We verify by not providing any file
    // path and letting the test harness catch unexpected IO.
    const state = make();
    for (let i = 0; i < 50; i++) {
      await state.appendUserMessage({ text: `msg ${i}` });
    }

    const messages = state.buildMessages();

    // Projector merges adjacent user messages (Q6 decision): 50 back-to-back
    // user appends collapse into a single merged user message.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');

    // But merging must not drop content — every one of the 50 original
    // payloads must still be present in the merged text.
    const mergedText = messages[0]!.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(mergedText).toContain('msg 0');
    expect(mergedText).toContain('msg 49');
    expect(mergedText).toContain('msg 25');
  });
});
