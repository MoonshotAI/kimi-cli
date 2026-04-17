/**
 * Slice 5 / 决策 #97: Streaming Tool Execution — interface reservation +
 * Soul 3-line prefetch check.
 *
 * Phase 5 does NOT enable streaming tool execution. The reservation is
 * just the minimum surface needed so Phase 6+ can flip it on without
 * touching Soul:
 *
 *   - `ChatParams.onToolCallReady?(toolCall): void`
 *     Phase 5: nobody sets it; Phase 6+: StreamingKosongWrapper calls it
 *     as each tool_use finishes streaming so orchestrator can schedule
 *     ahead of the assistant finishing.
 *   - `ChatResponse._prefetchedToolResults?: ReadonlyMap<string, ToolResult>`
 *     Phase 5: always undefined; Phase 6+: drained prefetched results.
 *   - `Tool.isConcurrencySafe?: (input) => boolean`
 *     Phase 5: optional field exists.
 *   - Soul `run-turn.ts` gains a 3-line prefetch check:
 *       const prefetched = response._prefetchedToolResults?.get(toolCall.id);
 *       if (prefetched !== undefined) result = prefetched;
 *       else                          result = await tool.execute(...);
 *     Phase 5 proof: the `else` branch is ALWAYS taken (prefetched map is
 *     never populated by the default KosongAdapter), so tool.execute is
 *     called exactly once per toolCall.
 *   - Prefetch-hit shortcut proof: when the test fixture manually plants a
 *     `_prefetchedToolResults` entry on the scripted ChatResponse, Soul
 *     MUST skip `tool.execute` for that tool call and reuse the planted
 *     result verbatim.
 *
 * Expected to FAIL before Phase 5: neither ChatParams.onToolCallReady nor
 * ChatResponse._prefetchedToolResults nor Tool.isConcurrencySafe exist on
 * the current interfaces; the run-turn.ts prefetch branch has no hook.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runSoulTurn } from '../../src/soul/index.js';
import type {
  ChatParams,
  ChatResponse,
  Tool,
  ToolCall,
  ToolResult,
} from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import {
  makeEndTurnResponse,
  makeToolCall,
  makeToolUseResponse,
} from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

function makeEchoTool(recorder: { calls: number }): Tool<{ text: string }, string> {
  return {
    name: 'echo',
    description: 'echo input text',
    inputSchema: z.object({ text: z.string() }),
    async execute(_id, args) {
      recorder.calls += 1;
      return { content: (args as { text: string }).text };
    },
  };
}

describe('ChatParams / ChatResponse — streaming reservation fields (决策 #97)', () => {
  it('ChatParams.onToolCallReady is typed as an optional hook accepting ToolCall', () => {
    // We only need this to compile to prove the field has the expected
    // signature. The assertion body is incidental.
    const readyCalls: ToolCall[] = [];
    const params: Partial<ChatParams> = {
      onToolCallReady: (tc: ToolCall) => {
        readyCalls.push(tc);
      },
    };
    expect(typeof params.onToolCallReady).toBe('function');
  });

  it('ChatResponse._prefetchedToolResults is typed as ReadonlyMap<string, ToolResult> when set', () => {
    const prefetched: ReadonlyMap<string, ToolResult> = new Map<string, ToolResult>([
      ['tc_1', { content: 'cached' }],
    ]);
    const response: Partial<ChatResponse> = { _prefetchedToolResults: prefetched };
    expect(response._prefetchedToolResults?.get('tc_1')?.content).toBe('cached');
  });

  it('Tool.isConcurrencySafe is an optional predicate over input', () => {
    const tool: Tool<{ q: string }> = {
      name: 't',
      description: 'd',
      inputSchema: z.object({ q: z.string() }),
      isConcurrencySafe: (input) => typeof input.q === 'string',
      async execute() {
        return { content: 'x' };
      },
    };
    expect(tool.isConcurrencySafe?.({ q: 'hello' })).toBe(true);
  });
});

describe('Soul run-turn prefetch check — Phase 5 default path (决策 #97)', () => {
  it('without _prefetchedToolResults, Soul calls tool.execute exactly once per tool call', async () => {
    const context = new FakeContextState({ initialTokenCountWithPending: 0 });
    const rec = { calls: 0 };
    const echo = makeEchoTool(rec);
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'one' }, 'tc_1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });

    await runSoulTurn(
      { text: 'go' },
      { tools: [echo] },
      context,
      runtime,
      new CollectingEventSink(),
      new AbortController().signal,
    );

    // Phase 5 invariant: map is undefined → else-branch taken → one execute.
    expect(rec.calls).toBe(1);
  });

  it('when _prefetchedToolResults plants a matching result, Soul uses it and skips tool.execute', async () => {
    const context = new FakeContextState({ initialTokenCountWithPending: 0 });
    const rec = { calls: 0 };
    const echo = makeEchoTool(rec);

    const prefetched = new Map<string, ToolResult>([
      ['tc_1', { content: 'FROM_PREFETCH_NOT_TOOL' }],
    ]);

    const toolUse = makeToolUseResponse([makeToolCall('echo', { text: 'ignored' }, 'tc_1')]);
    const toolUseWithPrefetch: ChatResponse = {
      ...toolUse,
      _prefetchedToolResults: prefetched,
    };

    const kosong = new ScriptedKosongAdapter({
      responses: [toolUseWithPrefetch, makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });

    await runSoulTurn(
      { text: 'go' },
      { tools: [echo] },
      context,
      runtime,
      new CollectingEventSink(),
      new AbortController().signal,
    );

    // Prefetch-hit: the tool.execute is bypassed completely.
    expect(rec.calls).toBe(0);

    // And the prefetched content survives into ContextState's appendToolResult.
    const toolResults = context.toolResultCalls();
    expect(toolResults).toHaveLength(1);
    const payloadBlob = JSON.stringify(toolResults[0]?.result);
    expect(payloadBlob).toContain('FROM_PREFETCH_NOT_TOOL');
  });

  it('a miss on _prefetchedToolResults (different id) still falls back to tool.execute', async () => {
    const context = new FakeContextState({ initialTokenCountWithPending: 0 });
    const rec = { calls: 0 };
    const echo = makeEchoTool(rec);

    // Planted map has the wrong key, so the .get(tc_1) returns undefined →
    // Soul must take the else-branch.
    const prefetched = new Map<string, ToolResult>([['tc_other', { content: 'wrong-id' }]]);
    const toolUse = makeToolUseResponse([makeToolCall('echo', { text: 'real' }, 'tc_1')]);
    const toolUseWithPrefetch: ChatResponse = {
      ...toolUse,
      _prefetchedToolResults: prefetched,
    };

    const kosong = new ScriptedKosongAdapter({
      responses: [toolUseWithPrefetch, makeEndTurnResponse('done')],
    });
    const { runtime } = createFakeRuntime({ kosong });

    await runSoulTurn(
      { text: 'go' },
      { tools: [echo] },
      context,
      runtime,
      new CollectingEventSink(),
      new AbortController().signal,
    );

    expect(rec.calls).toBe(1);
  });
});
