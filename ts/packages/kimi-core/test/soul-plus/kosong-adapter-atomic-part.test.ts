/**
 * Phase 25 Stage C — Slice 25c-1: KosongAdapter.onAtomicPart extension point.
 *
 * The adapter gains a new streaming callback `onAtomicPart` on `ChatParams`
 * that surfaces each kosong streamed `ContentPart` (text / think) and each
 * fully-formed kosong `ToolCall` (discriminator `type === 'function'`) as a
 * tagged union: `{ kind: 'content', part } | { kind: 'tool_call', toolCall }`.
 *
 * Contracts pinned here:
 *   - onAtomicPart fires via kosong's `onMessagePart` hook, per streamed
 *     part. Content parts forward as `kind:'content'`; fully-formed tool
 *     calls forward as `kind:'tool_call'`.
 *   - Streaming deltas (`type: 'tool_call_part'`) do NOT trigger
 *     onAtomicPart — they remain routed through the existing seam only
 *     (run-turn.ts wires its own `onToolCallPart` callback).
 *   - onAtomicPart coexists with `onDelta` / `onThinkDelta`: setting both
 *     fires BOTH for text/think parts. Omitting onAtomicPart preserves the
 *     legacy onDelta / onThinkDelta behaviour unchanged.
 *   - async: onAtomicPart may return a Promise. The adapter awaits it
 *     before forwarding the next streamed part, matching kosong's
 *     `await callbacks.onMessagePart(...)` contract (ordering guarantee
 *     for downstream WAL writers that rely on sequential appends).
 *
 * These tests drive the REAL `KosongAdapter` (not the `FakeKosongAdapter`
 * helper) so we exercise kosong's generate() → onMessagePart path.
 */

import { MockChatProvider } from '@moonshot-ai/kosong';
import type { StreamedMessagePart } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { KosongAdapter } from '../../src/soul-plus/index.js';
import type { ChatParams } from '../../src/soul/index.js';

// ── Call-shape extension — mirrors the Implementer's forthcoming update
// to `ChatParams` + `runtime.ts`. We describe the union structurally so
// the test file compiles against today's `ChatParams` (where
// `onAtomicPart` is not yet declared) and narrows cleanly once the
// Implementer lands the field.

type AtomicPart =
  | { readonly kind: 'content'; readonly part: { type: 'text'; text: string } | { type: 'think'; think: string; encrypted?: string } }
  | { readonly kind: 'tool_call'; readonly toolCall: { type: 'function'; id: string; function: { name: string; arguments: string | null } } };

interface AtomicChatOverrides extends Partial<ChatParams> {
  onAtomicPart?: (part: AtomicPart) => void | Promise<void>;
}

function makeParams(overrides: AtomicChatOverrides = {}): ChatParams {
  return {
    messages: [],
    tools: [],
    model: 'mock-model',
    systemPrompt: '',
    signal: new AbortController().signal,
    ...overrides,
  } as ChatParams;
}

// ── 1. ContentPart routing ───────────────────────────────────────────

describe('KosongAdapter.onAtomicPart — content parts', () => {
  it('fires onAtomicPart with kind:content for a text streamed part', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'hello world' }]);
    const adapter = new KosongAdapter({ provider });

    const events: AtomicPart[] = [];
    await adapter.chat(
      makeParams({
        onAtomicPart: (part) => {
          events.push(part);
        },
      }),
    );

    // One text part in → one onAtomicPart event out.
    const contentEvents = events.filter((e) => e.kind === 'content');
    expect(contentEvents).toHaveLength(1);
    const first = contentEvents[0]!;
    if (first.kind === 'content' && first.part.type === 'text') {
      expect(first.part.text).toBe('hello world');
    } else {
      throw new Error('expected a text content part');
    }
  });

  it('fires onAtomicPart with kind:content for a think streamed part', async () => {
    const provider = new MockChatProvider([
      { type: 'think', think: 'reasoning' },
      // Kosong throws APIEmptyResponseError on think-only streams, so we
      // trail the think chunk with a text chunk to satisfy the "not
      // empty" check. Only the think part is asserted on.
      { type: 'text', text: 'final' },
    ]);
    const adapter = new KosongAdapter({ provider });

    const events: AtomicPart[] = [];
    await adapter.chat(
      makeParams({
        onAtomicPart: (part) => {
          events.push(part);
        },
      }),
    );

    const thinkEvents = events.filter(
      (e) => e.kind === 'content' && e.part.type === 'think',
    );
    expect(thinkEvents).toHaveLength(1);
    const first = thinkEvents[0]!;
    if (first.kind === 'content' && first.part.type === 'think') {
      expect(first.part.think).toBe('reasoning');
    } else {
      throw new Error('expected a think content part');
    }
  });
});

// ── 2. ToolCall routing ──────────────────────────────────────────────

describe('KosongAdapter.onAtomicPart — tool call parts', () => {
  it('fires onAtomicPart with kind:tool_call for a fully-formed ToolCall', async () => {
    const provider = new MockChatProvider([
      {
        type: 'function',
        id: 'tc_bash_0',
        function: { name: 'Bash', arguments: '{"command":"ls"}' },
      },
    ]);
    const adapter = new KosongAdapter({ provider });

    const events: AtomicPart[] = [];
    await adapter.chat(
      makeParams({
        onAtomicPart: (part) => {
          events.push(part);
        },
      }),
    );

    const toolEvents = events.filter((e) => e.kind === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    const first = toolEvents[0]!;
    if (first.kind === 'tool_call') {
      expect(first.toolCall.id).toBe('tc_bash_0');
      expect(first.toolCall.function.name).toBe('Bash');
      expect(first.toolCall.function.arguments).toBe('{"command":"ls"}');
    } else {
      throw new Error('expected a tool_call atomic part');
    }
  });

  it('does NOT fire onAtomicPart for incremental tool_call_part streaming deltas', async () => {
    // kosong's generate() calls `onMessagePart` for every streamed part,
    // including ToolCallPart deltas. The adapter's onMessagePart branch
    // must filter ToolCallPart out of onAtomicPart — the complete
    // ToolCall event is what downstream WAL writers anchor on.
    const parts: StreamedMessagePart[] = [
      {
        type: 'function',
        id: 'tc_1',
        function: { name: 'Bash', arguments: null },
      },
      {
        type: 'tool_call_part',
        argumentsPart: '{"command":',
      },
      {
        type: 'tool_call_part',
        argumentsPart: '"ls"}',
      },
    ];
    const provider = new MockChatProvider(parts);
    const adapter = new KosongAdapter({ provider });

    const events: AtomicPart[] = [];
    await adapter.chat(
      makeParams({
        onAtomicPart: (part) => {
          events.push(part);
        },
      }),
    );

    // Exactly one event: the ToolCall header. No kind='tool_call_part'
    // shape exists in AtomicPart, so the filter just checks count.
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('tool_call');
  });
});

// ── 3. Coexistence with onDelta / onThinkDelta ───────────────────────

describe('KosongAdapter.onAtomicPart — coexistence with onDelta / onThinkDelta', () => {
  it('fires BOTH onDelta and onAtomicPart for a text part (additive contract)', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'hey' }]);
    const adapter = new KosongAdapter({ provider });

    const deltas: string[] = [];
    const atomicEvents: AtomicPart[] = [];
    await adapter.chat(
      makeParams({
        onDelta: (d) => deltas.push(d),
        onAtomicPart: (p) => {
          atomicEvents.push(p);
        },
      }),
    );

    expect(deltas).toEqual(['hey']);
    expect(atomicEvents).toHaveLength(1);
    const first = atomicEvents[0]!;
    if (first.kind === 'content' && first.part.type === 'text') {
      expect(first.part.text).toBe('hey');
    } else {
      throw new Error('expected text content part');
    }
  });

  it('fires BOTH onThinkDelta and onAtomicPart for a think part', async () => {
    const provider = new MockChatProvider([
      { type: 'think', think: 'pondering' },
      { type: 'text', text: 'final' },
    ]);
    const adapter = new KosongAdapter({ provider });

    const thinkDeltas: string[] = [];
    const atomicEvents: AtomicPart[] = [];
    await adapter.chat(
      makeParams({
        onThinkDelta: (d) => thinkDeltas.push(d),
        onAtomicPart: (p) => {
          atomicEvents.push(p);
        },
      }),
    );

    expect(thinkDeltas).toEqual(['pondering']);
    const thinkAtomics = atomicEvents.filter(
      (e) => e.kind === 'content' && e.part.type === 'think',
    );
    expect(thinkAtomics).toHaveLength(1);
  });

  it('leaves onDelta / onThinkDelta working when onAtomicPart is absent', async () => {
    const provider = new MockChatProvider([
      { type: 'think', think: 'pre' },
      { type: 'text', text: 'after' },
    ]);
    const adapter = new KosongAdapter({ provider });

    const deltas: string[] = [];
    const thinkDeltas: string[] = [];
    await adapter.chat(
      makeParams({
        onDelta: (d) => deltas.push(d),
        onThinkDelta: (d) => thinkDeltas.push(d),
      }),
    );

    expect(deltas).toEqual(['after']);
    expect(thinkDeltas).toEqual(['pre']);
  });
});

// ── 4. Async onAtomicPart — adapter awaits the returned promise ──────

describe('KosongAdapter.onAtomicPart — async callback ordering', () => {
  it('waits for the promise returned by onAtomicPart before processing the next part', async () => {
    const provider = new MockChatProvider([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
    const adapter = new KosongAdapter({ provider });

    const fireOrder: string[] = [];
    // External resolver lets us pause the callback after the first fire.
    let resolveFirst: () => void = () => {
      throw new Error('resolveFirst not wired');
    };
    const firstPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let callIndex = 0;

    const chatPromise = adapter.chat(
      makeParams({
        onAtomicPart: async (part) => {
          const idx = callIndex;
          callIndex += 1;
          if (part.kind === 'content' && part.part.type === 'text') {
            fireOrder.push(`enter:${part.part.text}`);
            if (idx === 0) {
              await firstPromise;
            }
            fireOrder.push(`exit:${part.part.text}`);
          }
        },
      }),
    );

    // Yield so the first onAtomicPart has a chance to run and park on
    // the pending promise. The second onAtomicPart must NOT have entered
    // yet — if the adapter didn't await, we would see enter:second here.
    await new Promise((resolve) => setImmediate(resolve));
    expect(fireOrder).toEqual(['enter:first']);

    resolveFirst();
    await chatPromise;

    // After the first fire's promise resolves, the second fires in order.
    expect(fireOrder).toEqual([
      'enter:first',
      'exit:first',
      'enter:second',
      'exit:second',
    ]);
  });
});
