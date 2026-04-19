/**
 * Phase 25 Stage K1 — Slice 25c-4a: ConversationProjector partial filter.
 *
 * Defensive guard: any history Message flagged `partial: true` MUST NOT
 * leave the projector. Reasoning:
 *   - Stage F (replay reconstruct) drops partial steps at the source, so
 *     the in-memory history a freshly resumed SoulPlus sees should never
 *     contain a `partial` Message in the first place.
 *   - K1 is belt-and-braces: any other code path (e.g. live streaming
 *     races, future producers, recovery synth) that *does* leak a partial
 *     Message into history must not poison the LLM's view.
 *
 * The kosong `Message` interface already exposes `partial?: boolean`
 * (`packages/kosong/src/message.ts:107`) so the filter is well-typed —
 * no `as any` injection required.
 */

import type { Message } from '@moonshot-ai/kosong';
import { createAssistantMessage, createUserMessage } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  type ContextSnapshot,
  DefaultConversationProjector,
} from '../../src/storage/projector.js';

function makeSnapshot(history: Message[]): ContextSnapshot {
  return {
    history,
    systemPrompt: '',
    model: 'm-test',
    activeTools: new Set<string>(),
  };
}

describe('DefaultConversationProjector — partial Message filter (K1)', () => {
  it('drops a single partial assistant Message from the projected output', () => {
    const projector = new DefaultConversationProjector();
    const partial: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'half-streamed' }],
      toolCalls: [],
      partial: true,
    };
    const out = projector.project(makeSnapshot([partial]), [], {});
    expect(out).toHaveLength(0);
  });

  it('keeps non-partial messages and drops only the partial one (mixed history)', () => {
    const projector = new DefaultConversationProjector();
    const history: Message[] = [
      createUserMessage('hi'),
      createAssistantMessage([{ type: 'text', text: 'hello' }]),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        toolCalls: [],
        partial: true,
      },
      createUserMessage('still there?'),
    ];
    const out = projector.project(makeSnapshot(history), [], {});
    // Filter removes only the partial; the user/assistant baseline +
    // the trailing user survive.
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // No projected message carries `partial: true`.
    expect(out.every((m) => m.partial !== true)).toBe(true);
    // The trailing user text survives unchanged.
    const lastUser = out[out.length - 1]!;
    expect(lastUser.content).toEqual([{ type: 'text', text: 'still there?' }]);
  });

  it('preserves messages whose `partial` field is explicitly false', () => {
    const projector = new DefaultConversationProjector();
    const fullyReceived: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'complete' }],
      toolCalls: [],
      partial: false,
    };
    const out = projector.project(makeSnapshot([fullyReceived]), [], {});
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('assistant');
  });

  it('does not invent a partial flag — output messages omit `partial` when input has none', () => {
    const projector = new DefaultConversationProjector();
    const out = projector.project(
      makeSnapshot([createAssistantMessage([{ type: 'text', text: 'plain' }])]),
      [],
      {},
    );
    expect(out).toHaveLength(1);
    // The cloned output should not carry an undefined-but-present `partial`
    // key — the projector copies the input as-is.
    expect(out[0]!.partial).toBeUndefined();
  });
});
