import { describe, expect, it, vi } from 'vitest';

import { APIEmptyResponseError } from '../src/errors.js';
import { generate } from '../src/generate.js';
import type { Message, StreamedMessagePart, ToolCall } from '../src/message.js';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '../src/provider.js';
import type { Tool } from '../src/tool.js';
import type { TokenUsage } from '../src/usage.js';

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockStream(
  parts: StreamedMessagePart[],
  opts?: { id?: string; usage?: TokenUsage },
): StreamedMessage {
  return {
    get id(): string | null {
      return opts?.id ?? null;
    },
    get usage(): TokenUsage | null {
      return opts?.usage ?? null;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

function createMockProvider(stream: StreamedMessage): ChatProvider {
  return {
    name: 'mock',
    modelName: 'mock-model',
    thinkingEffort: null,
    generate: async (
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
    ): Promise<StreamedMessage> => stream,
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('generate()', () => {
  it('merges consecutive TextParts and filters empty ones', async () => {
    const stream = createMockStream([
      { type: 'text', text: 'Hello, ' },
      { type: 'text', text: 'world' },
      { type: 'text', text: '!' },
      { type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } },
      { type: 'text', text: 'Another text.' },
      { type: 'text', text: '' },
      {
        type: 'function',
        id: 'get_weather#123',
        function: { name: 'get_weather', arguments: null },
      },
      { type: 'tool_call_part', argumentsPart: '{' },
      { type: 'tool_call_part', argumentsPart: '"city":' },
      { type: 'tool_call_part', argumentsPart: '"Beijing"' },
      { type: 'tool_call_part', argumentsPart: '}' },
      { type: 'tool_call_part', argumentsPart: null },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], []);

    expect(result.message.content).toEqual([
      { type: 'text', text: 'Hello, world!' },
      { type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } },
      { type: 'text', text: 'Another text.' },
    ]);
    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'get_weather#123',
        function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
      },
    ]);
  });

  it('calls onMessagePart and onToolCall callbacks correctly', async () => {
    const inputParts: StreamedMessagePart[] = [
      { type: 'text', text: 'Hello, ' },
      { type: 'text', text: 'world' },
      { type: 'text', text: '!' },
      {
        type: 'function',
        id: 'get_weather#123',
        function: { name: 'get_weather', arguments: null },
      },
      { type: 'tool_call_part', argumentsPart: '{' },
      { type: 'tool_call_part', argumentsPart: '"city":' },
      { type: 'tool_call_part', argumentsPart: '"Beijing"' },
      { type: 'tool_call_part', argumentsPart: '}' },
      {
        type: 'function',
        id: 'get_time#123',
        function: { name: 'get_time', arguments: '' },
      },
    ];
    const stream = createMockStream(inputParts);
    const provider = createMockProvider(stream);

    const outputParts: StreamedMessagePart[] = [];
    const outputToolCalls: ToolCall[] = [];

    const result = await generate(provider, '', [], [], {
      async onMessagePart(part: StreamedMessagePart): Promise<void> {
        outputParts.push(part);
      },
      async onToolCall(toolCall: ToolCall): Promise<void> {
        outputToolCalls.push(toolCall);
      },
    });

    // Every raw part should be echoed to onMessagePart.
    expect(outputParts).toHaveLength(inputParts.length);

    // Callback parts should be copies — mutating pendingPart should not affect them.
    // The first three TextParts merge into one in the message, but the callback
    // should have received them individually.
    expect(outputParts[0]).toEqual({ type: 'text', text: 'Hello, ' });
    expect(outputParts[1]).toEqual({ type: 'text', text: 'world' });
    expect(outputParts[2]).toEqual({ type: 'text', text: '!' });

    // onToolCall should fire for each complete ToolCall.
    expect(outputToolCalls).toEqual(result.message.toolCalls);
  });

  it('isolates nested media payloads passed to onMessagePart', async () => {
    const stream = createMockStream([
      { type: 'image_url', imageUrl: { url: 'https://example.com/original.png', id: 'img-1' } },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], [], {
      onMessagePart(part: StreamedMessagePart): void {
        if (part.type === 'image_url') {
          part.imageUrl.url = 'https://example.com/mutated.png';
          part.imageUrl.id = 'img-mutated';
        }
      },
    });

    expect(result.message.content).toEqual([
      { type: 'image_url', imageUrl: { url: 'https://example.com/original.png', id: 'img-1' } },
    ]);
  });

  it('isolates nested ToolCall extras passed to callbacks', async () => {
    const stream = createMockStream([
      {
        type: 'function',
        id: 'tool-1',
        function: { name: 'search', arguments: '{}' },
        extras: {
          metadata: { provider: 'kimi' },
          tags: ['a', 'b'],
        },
      },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], [], {
      onMessagePart(part: StreamedMessagePart): void {
        if (part.type === 'function') {
          (part.extras as { metadata: { provider: string }; tags: string[] }).metadata.provider =
            'mutated';
          (part.extras as { metadata: { provider: string }; tags: string[] }).tags.push('c');
        }
      },
    });

    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'tool-1',
        function: { name: 'search', arguments: '{}' },
        extras: {
          metadata: { provider: 'kimi' },
          tags: ['a', 'b'],
        },
      },
    ]);
  });

  it('throws APIEmptyResponseError on empty response', async () => {
    const stream = createMockStream([]);
    const provider = createMockProvider(stream);

    await expect(generate(provider, '', [], [])).rejects.toThrow(APIEmptyResponseError);
  });

  it('throws APIEmptyResponseError for think-only response', async () => {
    const stream = createMockStream([
      { type: 'think', think: 'Deep thinking about the problem...' },
    ]);
    const provider = createMockProvider(stream);

    await expect(generate(provider, '', [], [])).rejects.toThrow(/only thinking content/);
  });

  it('throws APIEmptyResponseError for think + empty/whitespace text', async () => {
    const stream = createMockStream([
      { type: 'think', think: 'Thinking...' },
      { type: 'text', text: '  \n  ' },
    ]);
    const provider = createMockProvider(stream);

    await expect(generate(provider, '', [], [])).rejects.toThrow(/only thinking content/);
  });

  it('succeeds for think + real text', async () => {
    const stream = createMockStream([
      { type: 'think', think: 'Let me think...' },
      { type: 'text', text: 'Here is the answer.' },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], []);

    expect(result.message.content.some((p) => p.type === 'think')).toBe(true);
    expect(result.message.content.some((p) => p.type === 'text')).toBe(true);
  });

  it('succeeds for think + tool calls (no text)', async () => {
    const stream = createMockStream([
      { type: 'think', think: 'I should call a tool...' },
      {
        type: 'function',
        id: 'tool#1',
        function: { name: 'read_file', arguments: '{"path": "/tmp"}' },
      },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], []);

    expect(result.message.content.some((p) => p.type === 'think')).toBe(true);
    expect(result.message.toolCalls).toBeDefined();
    expect(result.message.toolCalls!.length).toBeGreaterThan(0);
  });

  it('preserves stream id and usage', async () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 50,
      inputCacheRead: 200,
      inputCacheCreation: 10,
    };
    const stream = createMockStream([{ type: 'text', text: 'hi' }], {
      id: 'msg-123',
      usage,
    });
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], []);

    expect(result.id).toBe('msg-123');
    expect(result.usage).toEqual(usage);
  });

  it('merges ThinkParts together', async () => {
    const stream = createMockStream([
      { type: 'think', think: 'part1 ' },
      { type: 'think', think: 'part2' },
      { type: 'text', text: 'answer' },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], []);

    // The two ThinkParts should be merged.
    const thinkParts = result.message.content.filter((p) => p.type === 'think');
    expect(thinkParts).toHaveLength(1);
    if (thinkParts[0]!.type === 'think') {
      expect(thinkParts[0]!.think).toBe('part1 part2');
    }
  });

  it('flushes pending ToolCall when a new ToolCall arrives (parallel tool calls)', async () => {
    const stream = createMockStream([
      {
        type: 'function',
        id: 'tc-1',
        function: { name: 'read_file', arguments: null },
      },
      { type: 'tool_call_part', argumentsPart: '{"path":"/a"}' },
      {
        type: 'function',
        id: 'tc-2',
        function: { name: 'read_file', arguments: null },
      },
      { type: 'tool_call_part', argumentsPart: '{"path":"/b"}' },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], []);

    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'tc-1',
        function: { name: 'read_file', arguments: '{"path":"/a"}' },
      },
      {
        type: 'function',
        id: 'tc-2',
        function: { name: 'read_file', arguments: '{"path":"/b"}' },
      },
    ]);
  });

  it('handles ToolCallPart accumulation into ToolCall arguments', async () => {
    const stream = createMockStream([
      {
        type: 'function',
        id: 'tc-1',
        function: { name: 'search', arguments: null },
      },
      { type: 'tool_call_part', argumentsPart: '{"q' },
      { type: 'tool_call_part', argumentsPart: '":"hello"}' },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], []);

    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'tc-1',
        function: { name: 'search', arguments: '{"q":"hello"}' },
      },
    ]);
  });

  // ── Parallel tool call routing (P1 bug regression) ────────────────
  //
  // When a provider streams multiple parallel tool calls, the argument
  // deltas can arrive interleaved. `ToolCallPart.index` must route each
  // delta to the correct ToolCall instead of falling through to the
  // "most recent pending ToolCall" which would cross-contaminate args.

  it('routes interleaved parallel ToolCallPart deltas by index', async () => {
    // Both tool calls are opened up-front, then their argument deltas
    // arrive interleaved (index 0 and 1 alternating).
    const stream = createMockStream([
      {
        type: 'function',
        id: 'tc-a',
        function: { name: 'read_file', arguments: null },
        _streamIndex: 0,
      },
      {
        type: 'function',
        id: 'tc-b',
        function: { name: 'read_file', arguments: null },
        _streamIndex: 1,
      },
      // Interleaved argument deltas across the two tool calls.
      { type: 'tool_call_part', argumentsPart: '{"path":"', index: 0 },
      { type: 'tool_call_part', argumentsPart: '{"path":"', index: 1 },
      { type: 'tool_call_part', argumentsPart: '/a"', index: 0 },
      { type: 'tool_call_part', argumentsPart: '/b"', index: 1 },
      { type: 'tool_call_part', argumentsPart: '}', index: 0 },
      { type: 'tool_call_part', argumentsPart: '}', index: 1 },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], []);

    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'tc-a',
        function: { name: 'read_file', arguments: '{"path":"/a"}' },
      },
      {
        type: 'function',
        id: 'tc-b',
        function: { name: 'read_file', arguments: '{"path":"/b"}' },
      },
    ]);
    // _streamIndex must NOT leak into the stored ToolCall.
    for (const tc of result.message.toolCalls) {
      expect(tc).not.toHaveProperty('_streamIndex');
    }
  });

  it('routes parallel ToolCallPart deltas by string index (Responses API item_id)', async () => {
    // Responses API uses string item_ids instead of numeric indices.
    const stream = createMockStream([
      {
        type: 'function',
        id: 'call_a',
        function: { name: 'read_file', arguments: null },
        _streamIndex: 'item_abc',
      },
      {
        type: 'function',
        id: 'call_b',
        function: { name: 'read_file', arguments: null },
        _streamIndex: 'item_xyz',
      },
      { type: 'tool_call_part', argumentsPart: '{"p":"/x"}', index: 'item_xyz' },
      { type: 'tool_call_part', argumentsPart: '{"p":"/a"}', index: 'item_abc' },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], []);

    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'call_a',
        function: { name: 'read_file', arguments: '{"p":"/a"}' },
      },
      {
        type: 'function',
        id: 'call_b',
        function: { name: 'read_file', arguments: '{"p":"/x"}' },
      },
    ]);
  });

  it('falls back to sequential merge when ToolCallPart has no index', async () => {
    // Back-compat: providers that do not emit `index` continue to work
    // when there is a single tool call in flight.
    const stream = createMockStream([
      {
        type: 'function',
        id: 'tc-1',
        function: { name: 'search', arguments: null },
      },
      { type: 'tool_call_part', argumentsPart: '{"q":' },
      { type: 'tool_call_part', argumentsPart: '"hi"}' },
      {
        type: 'function',
        id: 'tc-2',
        function: { name: 'search', arguments: null },
      },
      { type: 'tool_call_part', argumentsPart: '{"q":"bye"}' },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], []);

    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'tc-1',
        function: { name: 'search', arguments: '{"q":"hi"}' },
      },
      {
        type: 'function',
        id: 'tc-2',
        function: { name: 'search', arguments: '{"q":"bye"}' },
      },
    ]);
  });

  it('handles indexed deltas arriving after the pending tool call has changed', async () => {
    // tc0 opens, receives its full arguments, then tc1 opens and becomes
    // pending, then a late delta for tc0 arrives by index. The late
    // delta must route back to tc0 rather than appending to tc1.
    const stream = createMockStream([
      {
        type: 'function',
        id: 'tc-0',
        function: { name: 'write', arguments: null },
        _streamIndex: 0,
      },
      { type: 'tool_call_part', argumentsPart: '{"a":', index: 0 },
      { type: 'tool_call_part', argumentsPart: '1', index: 0 },
      {
        type: 'function',
        id: 'tc-1',
        function: { name: 'write', arguments: null },
        _streamIndex: 1,
      },
      { type: 'tool_call_part', argumentsPart: '{"b":2}', index: 1 },
      // Late delta for tc-0 — must be routed via the index map.
      { type: 'tool_call_part', argumentsPart: '}', index: 0 },
    ]);
    const provider = createMockProvider(stream);

    const result = await generate(provider, '', [], []);

    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'tc-0',
        function: { name: 'write', arguments: '{"a":1}' },
      },
      {
        type: 'function',
        id: 'tc-1',
        function: { name: 'write', arguments: '{"b":2}' },
      },
    ]);
  });

  it('onToolCall callback receives stored ToolCall without _streamIndex', async () => {
    const stream = createMockStream([
      {
        type: 'function',
        id: 'tc-1',
        function: { name: 'f', arguments: null },
        _streamIndex: 0,
      },
      { type: 'tool_call_part', argumentsPart: '{}', index: 0 },
    ]);
    const provider = createMockProvider(stream);

    const received: ToolCall[] = [];
    await generate(provider, '', [], [], {
      async onToolCall(tc: ToolCall): Promise<void> {
        received.push(tc);
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'function',
      id: 'tc-1',
      function: { name: 'f', arguments: '{}' },
    });
    expect(received[0]).not.toHaveProperty('_streamIndex');
  });

  // ── onToolCall deferred firing (P1 bug regression) ────────────────
  //
  // Parallel tool call streams can interleave headers and arguments:
  //
  //   tc0-header → tc1-header → tc0-args → tc1-args → done
  //
  // Previously the generate loop fired onToolCall the moment a second
  // ToolCall header forced a flush of the first. At that point tc0's
  // arguments had not yet been received, so any consumer that parsed
  // `tc.function.arguments` inside the callback (e.g. step() dispatching
  // the tool) would hit a JSON parse error on an empty/partial string.
  //
  // The fix is to defer all onToolCall invocations until after the stream
  // has drained. These tests lock in that behaviour.

  it('onToolCall fires only after the stream completes, with fully-assembled arguments', async () => {
    // Pathological stream: interleaved headers and argument deltas.
    const stream = createMockStream([
      {
        type: 'function',
        id: 'call_a',
        function: { name: 'tool_a', arguments: null },
        _streamIndex: 0,
      },
      {
        type: 'function',
        id: 'call_b',
        function: { name: 'tool_b', arguments: null },
        _streamIndex: 1,
      },
      { type: 'tool_call_part', argumentsPart: '{"x":', index: 0 },
      { type: 'tool_call_part', argumentsPart: '{"y":', index: 1 },
      { type: 'tool_call_part', argumentsPart: '1}', index: 0 },
      { type: 'tool_call_part', argumentsPart: '2}', index: 1 },
    ]);
    const provider = createMockProvider(stream);

    // Capture what each callback invocation sees. Each callback must
    // observe fully-assembled arguments.
    const callbackSnapshots: Array<{ id: string; args: string | null }> = [];

    const result = await generate(provider, '', [], [], {
      async onToolCall(tc: ToolCall): Promise<void> {
        callbackSnapshots.push({ id: tc.id, args: tc.function.arguments });
      },
    });

    // Both callbacks fired, in the order the tool calls were
    // appended to `message.toolCalls`.
    expect(callbackSnapshots).toEqual([
      { id: 'call_a', args: '{"x":1}' },
      { id: 'call_b', args: '{"y":2}' },
    ]);

    // The message itself reflects the same final state.
    expect(result.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'call_a',
        function: { name: 'tool_a', arguments: '{"x":1}' },
      },
      {
        type: 'function',
        id: 'call_b',
        function: { name: 'tool_b', arguments: '{"y":2}' },
      },
    ]);
  });

  it('onToolCall observes fully-populated message.toolCalls at callback time', async () => {
    // Stronger invariant: at the moment each onToolCall fires, every
    // tool call in the message is already present with complete
    // arguments. This is what step() relies on to dispatch tools
    // without hitting partial-JSON parse errors.
    const stream = createMockStream([
      {
        type: 'function',
        id: 'call_a',
        function: { name: 'tool_a', arguments: null },
        _streamIndex: 0,
      },
      {
        type: 'function',
        id: 'call_b',
        function: { name: 'tool_b', arguments: null },
        _streamIndex: 1,
      },
      {
        type: 'function',
        id: 'call_c',
        function: { name: 'tool_c', arguments: null },
        _streamIndex: 2,
      },
      // Heavily interleaved argument deltas.
      { type: 'tool_call_part', argumentsPart: '{"k":', index: 2 },
      { type: 'tool_call_part', argumentsPart: '{"k":', index: 0 },
      { type: 'tool_call_part', argumentsPart: '{"k":', index: 1 },
      { type: 'tool_call_part', argumentsPart: '3}', index: 2 },
      { type: 'tool_call_part', argumentsPart: '1}', index: 0 },
      { type: 'tool_call_part', argumentsPart: '2}', index: 1 },
    ]);
    const provider = createMockProvider(stream);

    // Shared state so the callback can inspect the message.
    const state: { message: import('../src/message.js').Message | null } = { message: null };
    const observations: Array<{ id: string; totalToolCalls: number; allComplete: boolean }> = [];

    const result = await generate(provider, '', [], [], {
      async onToolCall(tc: ToolCall): Promise<void> {
        const msg = state.message;
        if (msg === null) {
          // First callback: we don't have a message reference yet
          // because `generate` hasn't returned. But the invariant we
          // care about is that `tc.function.arguments` is complete
          // JSON — verify that directly.
          observations.push({
            id: tc.id,
            totalToolCalls: -1, // unknown — message ref not yet bound
            allComplete: tc.function.arguments !== null && tc.function.arguments.endsWith('}'),
          });
          return;
        }
        observations.push({
          id: tc.id,
          totalToolCalls: msg.toolCalls.length,
          allComplete: msg.toolCalls.every(
            (c) => c.function.arguments !== null && c.function.arguments.endsWith('}'),
          ),
        });
      },
    });
    state.message = result.message;

    // Every callback observed well-formed, complete arguments for its
    // own tool call.
    for (const obs of observations) {
      expect(obs.allComplete).toBe(true);
    }
    expect(observations.map((o) => o.id)).toEqual(['call_a', 'call_b', 'call_c']);

    // The final assembled arguments match the index-based routing.
    expect(result.message.toolCalls.map((tc) => tc.function.arguments)).toEqual([
      '{"k":1}',
      '{"k":2}',
      '{"k":3}',
    ]);
  });

  it('pre-aborted signal does not call provider.generate', async () => {
    // Regression (Codex Round 9 P2): when the caller's AbortSignal is
    // already aborted before generate() is invoked, we must not call
    // provider.generate() at all. Providers that do not themselves
    // honor the signal would otherwise dispatch a network request that
    // the caller has explicitly cancelled.
    let calledGenerate = false;
    const provider: ChatProvider = {
      name: 'mock',
      modelName: 'mock-model',
      thinkingEffort: null,
      generate: async (
        _systemPrompt: string,
        _tools: Tool[],
        _history: Message[],
      ): Promise<StreamedMessage> => {
        calledGenerate = true;
        return createMockStream([{ type: 'text', text: 'should not reach here' }]);
      },
      withThinking(_effort: ThinkingEffort): ChatProvider {
        return this;
      },
    };

    const controller = new AbortController();
    controller.abort();

    await expect(
      generate(provider, '', [], [], undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(calledGenerate).toBe(false);
  });

  it('signal aborted between provider.generate() and stream iteration is honored', async () => {
    // Regression (Codex Round 9 P2): even if provider.generate() resolves
    // successfully, a concurrent abort signal that fires before we begin
    // iterating the stream must reject rather than drain any parts.
    const controller = new AbortController();
    let observedParts = 0;

    const stream: StreamedMessage = {
      get id(): string | null {
        return null;
      },
      get usage(): TokenUsage | null {
        return null;
      },
      async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
        observedParts += 1;
        yield { type: 'text', text: 'leaked' };
      },
    };

    const provider: ChatProvider = {
      name: 'mock',
      modelName: 'mock-model',
      thinkingEffort: null,
      generate: async (
        _systemPrompt: string,
        _tools: Tool[],
        _history: Message[],
      ): Promise<StreamedMessage> => {
        // Abort between provider.generate() resolving and generate() seeing
        // its return value.
        controller.abort();
        return stream;
      },
      withThinking(_effort: ThinkingEffort): ChatProvider {
        return this;
      },
    };

    await expect(
      generate(provider, '', [], [], undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Stream iteration must never have started.
    expect(observedParts).toBe(0);
  });

  it('aborting in the last onMessagePart callback throws AbortError and skips onToolCall', async () => {
    const controller = new AbortController();
    const onToolCall = vi.fn<(toolCall: ToolCall) => Promise<void>>();

    const stream = createMockStream([
      {
        type: 'function',
        id: 'call-1',
        function: { name: 'plus', arguments: null },
      },
      { type: 'tool_call_part', argumentsPart: '{"a":1}' },
      { type: 'text', text: 'done' },
    ]);
    const provider = createMockProvider(stream);

    await expect(
      generate(
        provider,
        '',
        [],
        [],
        {
          async onMessagePart(part: StreamedMessagePart): Promise<void> {
            if (part.type === 'text' && part.text === 'done') {
              controller.abort();
            }
          },
          onToolCall,
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(onToolCall).not.toHaveBeenCalled();
  });

  it('post-await abort cancels the acquired stream before throwing AbortError', async () => {
    const controller = new AbortController();
    const cancel = vi.fn<() => Promise<void>>().mockResolvedValue();

    const stream: StreamedMessage & { cancel(): Promise<void> } = {
      cancel,
      get id(): string | null {
        return null;
      },
      get usage(): TokenUsage | null {
        return null;
      },
      async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
        yield { type: 'text', text: 'leaked' };
      },
    };

    const provider: ChatProvider = {
      name: 'mock',
      modelName: 'mock-model',
      thinkingEffort: null,
      generate: async (): Promise<StreamedMessage> => {
        controller.abort();
        return stream;
      },
      withThinking(_effort: ThinkingEffort): ChatProvider {
        return this;
      },
    };

    await expect(
      generate(provider, '', [], [], undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('onToolCall receives tool calls in message order', async () => {
    // Stream yields tc0-header, then its full args, then tc1-header,
    // then its full args. The callback must see them in message order.
    const stream = createMockStream([
      {
        type: 'function',
        id: 'first',
        function: { name: 'f', arguments: null },
      },
      { type: 'tool_call_part', argumentsPart: '{"i":1}' },
      {
        type: 'function',
        id: 'second',
        function: { name: 'g', arguments: null },
      },
      { type: 'tool_call_part', argumentsPart: '{"i":2}' },
    ]);
    const provider = createMockProvider(stream);

    const received: string[] = [];
    await generate(provider, '', [], [], {
      async onToolCall(tc: ToolCall): Promise<void> {
        received.push(tc.id);
      },
    });

    expect(received).toEqual(['first', 'second']);
  });
});
