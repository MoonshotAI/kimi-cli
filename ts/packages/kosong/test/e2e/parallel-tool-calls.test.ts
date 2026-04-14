import { describe, expect, it } from 'vitest';

import { generate } from '../../src/generate.js';
import type { Message, StreamedMessagePart, ToolCall } from '../../src/message.js';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '../../src/provider.js';
import { SimpleToolset } from '../../src/simple-toolset.js';
import { step } from '../../src/step.js';
import type { JsonType, Tool, ToolReturnValue } from '../../src/tool.js';
import { toolOk } from '../../src/tool.js';
import type { TokenUsage } from '../../src/usage.js';

// ── Integration: parallel tool calls through SimpleToolset ────────────
//
// The kosong streaming pipeline supports parallel tool calls where
// argument deltas may arrive interleaved across multiple ToolCall
// headers. The bug this file guards against (Codex P1) is:
//
//   (a) argument cross-contamination: a ToolCallPart destined for
//       tc1 ends up concatenated onto tc0's arguments, producing
//       corrupted JSON and toolParseError at dispatch time;
//
//   (b) early dispatch: onToolCall fires mid-stream with half-parsed
//       arguments, before the interleaved deltas have caught up.
//
// The fix is two-part: ToolCallPart.index routes each delta to the
// correct pending call via `_streamIndex`, and dispatch of tool calls
// via SimpleToolset is deferred to stream-drain time.
//
// These tests simulate that whole integration path — interleaved deltas,
// SimpleToolset dispatch, concurrent execution, ordered results.

// ── Mock provider helpers ─────────────────────────────────────────────

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

describe('integration: parallel tool calls through SimpleToolset', () => {
  it('three parallel tool_calls with interleaved argument deltas dispatch with correct arguments', async () => {
    // Simulate an OpenAI-style streaming response where three tool calls
    // are kicked off with empty arguments, then their argument deltas
    // arrive in a heavily interleaved order.
    const parts: StreamedMessagePart[] = [
      // Three tool-call headers (empty arguments) in order 0, 1, 2.
      {
        type: 'function',
        id: 'tc_read',
        function: { name: 'read_file', arguments: null },
        _streamIndex: 0,
      },
      {
        type: 'function',
        id: 'tc_write',
        function: { name: 'write_file', arguments: null },
        _streamIndex: 1,
      },
      {
        type: 'function',
        id: 'tc_list',
        function: { name: 'list_dir', arguments: null },
        _streamIndex: 2,
      },
      // Interleaved argument deltas. Arguments for each call, arriving
      // in an unpredictable order.
      { type: 'tool_call_part', argumentsPart: '{"path":', index: 0 },
      { type: 'tool_call_part', argumentsPart: '{"path":', index: 1 },
      { type: 'tool_call_part', argumentsPart: '{"path":', index: 2 },
      { type: 'tool_call_part', argumentsPart: '"a.txt"', index: 0 },
      { type: 'tool_call_part', argumentsPart: '"b.txt",', index: 1 },
      { type: 'tool_call_part', argumentsPart: '"/tmp"', index: 2 },
      { type: 'tool_call_part', argumentsPart: '}', index: 0 },
      { type: 'tool_call_part', argumentsPart: '"data":"X"}', index: 1 },
      { type: 'tool_call_part', argumentsPart: '}', index: 2 },
    ];

    const stream = createMockStream(parts);
    const provider = createMockProvider(stream);

    // Track what arguments each handler actually observed.
    const observed: Record<string, JsonType> = {};
    const dispatchOrder: string[] = [];

    const toolset = new SimpleToolset();
    toolset.add(
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      async (args: JsonType): Promise<ToolReturnValue> => {
        observed['read_file'] = args;
        dispatchOrder.push('read_file');
        return toolOk({ output: 'read-OK' });
      },
    );
    toolset.add(
      {
        name: 'write_file',
        description: 'Write a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, data: { type: 'string' } },
          required: ['path', 'data'],
        },
      },
      async (args: JsonType): Promise<ToolReturnValue> => {
        observed['write_file'] = args;
        dispatchOrder.push('write_file');
        return toolOk({ output: 'write-OK' });
      },
    );
    toolset.add(
      {
        name: 'list_dir',
        description: 'List a directory',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      async (args: JsonType): Promise<ToolReturnValue> => {
        observed['list_dir'] = args;
        dispatchOrder.push('list_dir');
        return toolOk({ output: 'list-OK' });
      },
    );

    const result = await step(provider, '', toolset, []);

    // Three tool calls, in stream order.
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls[0]!.function.name).toBe('read_file');
    expect(result.toolCalls[1]!.function.name).toBe('write_file');
    expect(result.toolCalls[2]!.function.name).toBe('list_dir');

    // Fully-assembled arguments — no cross-contamination.
    expect(result.toolCalls[0]!.function.arguments).toBe('{"path":"a.txt"}');
    expect(result.toolCalls[1]!.function.arguments).toBe('{"path":"b.txt","data":"X"}');
    expect(result.toolCalls[2]!.function.arguments).toBe('{"path":"/tmp"}');

    // Each handler saw the correct parsed JSON arguments.
    const toolResults = await result.toolResults();
    expect(toolResults).toHaveLength(3);
    expect(toolResults.every((r) => ! r.returnValue.isError)).toBe(true);

    expect(observed['read_file']).toEqual({ path: 'a.txt' });
    expect(observed['write_file']).toEqual({ path: 'b.txt', data: 'X' });
    expect(observed['list_dir']).toEqual({ path: '/tmp' });

    // The tool_results are returned in the same order as toolCalls,
    // regardless of handler completion order.
    expect(toolResults[0]!.toolCallId).toBe('tc_read');
    expect(toolResults[1]!.toolCallId).toBe('tc_write');
    expect(toolResults[2]!.toolCallId).toBe('tc_list');

    // `_streamIndex` must be stripped from the stored ToolCall.
    for (const tc of result.toolCalls) {
      expect(tc).not.toHaveProperty('_streamIndex');
    }
  });

  it('tool handlers run concurrently — total wall time < sum of individual latencies', async () => {
    // Three parallel tool_calls, each handler sleeps 80ms. If the
    // handlers were serialised, the total wall time would be ~240ms.
    // If they are dispatched concurrently (Promise.all style), the
    // total must be close to ~80ms (with generous slack for CI jitter).
    const parts: StreamedMessagePart[] = [
      {
        type: 'function',
        id: 'tc_a',
        function: { name: 'slow', arguments: '{"id":"a"}' },
        _streamIndex: 0,
      },
      {
        type: 'function',
        id: 'tc_b',
        function: { name: 'slow', arguments: '{"id":"b"}' },
        _streamIndex: 1,
      },
      {
        type: 'function',
        id: 'tc_c',
        function: { name: 'slow', arguments: '{"id":"c"}' },
        _streamIndex: 2,
      },
    ];

    const stream = createMockStream(parts);
    const provider = createMockProvider(stream);

    const toolset = new SimpleToolset();
    const startTimes: Record<string, number> = {};
    toolset.add(
      {
        name: 'slow',
        description: 'Slow tool',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      async (args: JsonType): Promise<ToolReturnValue> => {
        const id = (args as { id: string }).id;
        startTimes[id] = Date.now();
        await new Promise<void>((r) => setTimeout(r, 80));
        return toolOk({ output: `done-${id}` });
      },
    );

    const t0 = Date.now();
    const result = await step(provider, '', toolset, []);
    const toolResults = await result.toolResults();
    const elapsed = Date.now() - t0;

    expect(toolResults).toHaveLength(3);
    expect(toolResults.map((r) => r.returnValue.output)).toEqual(['done-a', 'done-b', 'done-c']);

    // All three handlers must have started within a small window of
    // each other — they were dispatched concurrently, not serially.
    const t = [startTimes['a']!, startTimes['b']!, startTimes['c']!];
    const spread = Math.max(...t) - Math.min(...t);
    expect(spread).toBeLessThan(50); // dispatched within 50ms of each other

    // Total elapsed ≤ ~160ms (80ms handler + generous slack),
    // NOT ~240ms (3 × 80ms serial).
    expect(elapsed).toBeLessThan(200);
  });

  it('tool_results are returned in toolCalls order even when handlers complete out-of-order', async () => {
    // Reverse-order completion: the last handler finishes first.
    const parts: StreamedMessagePart[] = [
      {
        type: 'function',
        id: 'tc_slow',
        function: { name: 'sleep_tool', arguments: '{"ms":100,"tag":"slow"}' },
        _streamIndex: 0,
      },
      {
        type: 'function',
        id: 'tc_med',
        function: { name: 'sleep_tool', arguments: '{"ms":50,"tag":"med"}' },
        _streamIndex: 1,
      },
      {
        type: 'function',
        id: 'tc_fast',
        function: { name: 'sleep_tool', arguments: '{"ms":1,"tag":"fast"}' },
        _streamIndex: 2,
      },
    ];

    const stream = createMockStream(parts);
    const provider = createMockProvider(stream);

    const completionOrder: string[] = [];
    const toolset = new SimpleToolset();
    toolset.add(
      {
        name: 'sleep_tool',
        description: 'Sleep then return tag',
        parameters: {
          type: 'object',
          properties: {
            ms: { type: 'integer' },
            tag: { type: 'string' },
          },
          required: ['ms', 'tag'],
        },
      },
      async (args: JsonType): Promise<ToolReturnValue> => {
        const { ms, tag } = args as { ms: number; tag: string };
        await new Promise<void>((r) => setTimeout(r, ms));
        completionOrder.push(tag);
        return toolOk({ output: tag });
      },
    );

    const result = await step(provider, '', toolset, []);
    const toolResults = await result.toolResults();

    // Handlers completed fast-first, but results are returned in
    // toolCalls order.
    expect(completionOrder[0]).toBe('fast');
    expect(toolResults.map((r) => r.returnValue.output)).toEqual(['slow', 'med', 'fast']);
  });

  it('one tool throws — other parallel tools still succeed', async () => {
    const parts: StreamedMessagePart[] = [
      {
        type: 'function',
        id: 'tc_ok_1',
        function: { name: 'good', arguments: '{"i":1}' },
        _streamIndex: 0,
      },
      {
        type: 'function',
        id: 'tc_bad',
        function: { name: 'bad', arguments: '{}' },
        _streamIndex: 1,
      },
      {
        type: 'function',
        id: 'tc_ok_2',
        function: { name: 'good', arguments: '{"i":2}' },
        _streamIndex: 2,
      },
    ];

    const stream = createMockStream(parts);
    const provider = createMockProvider(stream);

    const toolset = new SimpleToolset();
    toolset.add(
      {
        name: 'good',
        description: 'ok',
        parameters: { type: 'object', properties: { i: { type: 'integer' } } },
      },
      async (args: JsonType): Promise<ToolReturnValue> => {
        const i = (args as { i: number }).i;
        return toolOk({ output: `ok-${i}` });
      },
    );
    toolset.add(
      { name: 'bad', description: 'bad', parameters: { type: 'object', properties: {} } },
      async (): Promise<ToolReturnValue> => {
        throw new Error('tool explosion');
      },
    );

    const result = await step(provider, '', toolset, []);
    const toolResults = await result.toolResults();

    expect(toolResults).toHaveLength(3);
    expect(toolResults[0]!.returnValue.isError).toBe(false);
    expect(toolResults[0]!.returnValue.output).toBe('ok-1');
    expect(toolResults[1]!.returnValue.isError).toBe(true);
    expect(toolResults[1]!.returnValue.message).toBe('Error running tool: tool explosion');
    expect(toolResults[2]!.returnValue.isError).toBe(false);
    expect(toolResults[2]!.returnValue.output).toBe('ok-2');
  });

  it('generate (direct) routes interleaved deltas by non-numeric streaming id (Responses API style)', async () => {
    // OpenAI Responses API uses string `item_id` rather than numeric
    // index. Verify index-based routing still works when the routing
    // key is a string.
    const parts: StreamedMessagePart[] = [
      {
        type: 'function',
        id: 'tc_alpha',
        function: { name: 't', arguments: null },
        _streamIndex: 'item_alpha',
      },
      {
        type: 'function',
        id: 'tc_beta',
        function: { name: 't', arguments: null },
        _streamIndex: 'item_beta',
      },
      { type: 'tool_call_part', argumentsPart: '{"k":', index: 'item_alpha' },
      { type: 'tool_call_part', argumentsPart: '{"k":', index: 'item_beta' },
      { type: 'tool_call_part', argumentsPart: '"A"}', index: 'item_alpha' },
      { type: 'tool_call_part', argumentsPart: '"B"}', index: 'item_beta' },
    ];

    const stream = createMockStream(parts);
    const provider = createMockProvider(stream);

    const seen: ToolCall[] = [];
    const result = await generate(provider, '', [], [], {
      onToolCall: (tc: ToolCall): void => {
        seen.push(tc);
      },
    });

    expect(result.message.toolCalls).toHaveLength(2);
    expect(result.message.toolCalls[0]!.function.arguments).toBe('{"k":"A"}');
    expect(result.message.toolCalls[1]!.function.arguments).toBe('{"k":"B"}');
    // onToolCall fired once per fully-assembled call after stream drained.
    expect(seen).toHaveLength(2);
    expect(seen[0]!.id).toBe('tc_alpha');
    expect(seen[1]!.id).toBe('tc_beta');
  });
});
