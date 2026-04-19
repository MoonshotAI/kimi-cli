/**
 * Phase 25 Stage C — Slice 25c-2 behavioural coverage.
 *
 * This file pins the new contract introduced when Soul's main loop
 * switches from aggregated `appendAssistantMessage` writes to atomic
 * `appendStepBegin` → streamed `appendContentPart` → `appendStepEnd`
 * writes, with parent-linked `appendToolCall` / `appendToolResult`
 * rows on the fallback paths.
 *
 * Behavioural matrix (brief §必测行为):
 *
 *   A. Happy path      — one step_begin + content_parts + step_end
 *                        share a consistent `uuid`/`stepUuid`.
 *   B. in-Soul fallback writes (3 branches). Soul never called
 *      `tool.execute`, so the orchestrator (25c-3) is not in play —
 *      Soul itself must emit BOTH `appendToolCall` (because the LLM
 *      emitted the call) AND a parent-linked `appendToolResult`:
 *        B.1 tool-not-found
 *        B.2 zod input-schema parse failure
 *        B.3 beforeToolCall hook throws
 *   C. Streaming content_part order. A scripted response whose
 *      `content` array interleaves text / thinking / text blocks
 *      must land as three `appendContentPart` calls in arrival order,
 *      each anchored to the surrounding step_begin.
 *   D. Abort mid-step → Soul writes `appendStepBegin` but does NOT
 *      write `appendStepEnd` (C6 partial-step decision; the missing
 *      step_end is the replay-projector's interruption signal).
 *
 * Tests are written against the `FakeContextState` recording stub
 * upgraded in 25c-2. They deliberately go red at slice-2 landing
 * time — the implementer switches Soul's main loop during slice-3
 * (Implementer) and the matrix turns green.
 */

import { describe, expect, it, vi } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type {
  ChatParams,
  ChatResponse,
  KosongAdapter,
  SoulConfig,
} from '../../src/soul/index.js';
import type { BeforeToolCallContext } from '../../src/soul/types.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import {
  makeEndTurnResponse,
  makeToolCall,
  makeToolUseResponse,
  zeroUsage,
} from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { EchoTool, StrictArgsTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — atomic API happy path (25c-2 behaviour A)', () => {
  it('emits step_begin → content_part(s) → step_end with a single consistent stepUuid', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('hello world', { input: 10, output: 5 })],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [] };

    await runSoulTurn(
      { text: 'hi' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const beginCalls = context.stepBeginCalls();
    const endCalls = context.stepEndCalls();
    const partCalls = context.contentPartCalls();

    expect(beginCalls).toHaveLength(1);
    expect(endCalls).toHaveLength(1);
    expect(partCalls).toHaveLength(1);

    const stepUuid = beginCalls[0]!.input.uuid;
    expect(stepUuid).toBeTruthy();
    // step_end carries the same uuid as step_begin — same step lifecycle.
    expect(endCalls[0]!.input.uuid).toBe(stepUuid);
    // The content_part is anchored to that step uuid (strict D-MSG-ID).
    expect(partCalls[0]!.input.stepUuid).toBe(stepUuid);
    // step_begin and step_end share the same `step` ordinal.
    expect(endCalls[0]!.input.step).toBe(beginCalls[0]!.input.step);
    expect(partCalls[0]!.input.step).toBe(beginCalls[0]!.input.step);
    // turn_id is forwarded consistently.
    expect(endCalls[0]!.input.turnId).toBe(beginCalls[0]!.input.turnId);
    expect(partCalls[0]!.input.turnId).toBe(beginCalls[0]!.input.turnId);
    // Usage from the ChatResponse flows through step_end, not step_begin.
    expect(endCalls[0]!.input.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
    });
    // The content_part mirrors the streamed text exactly.
    expect(partCalls[0]!.input.part).toEqual({ kind: 'text', text: 'hello world' });

    // Legacy aggregated path must remain dormant.
    expect(context.assistantCalls()).toHaveLength(0);
  });

  it('multi-step turn opens a fresh stepUuid per step; each content_part anchors to its own step', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'one' }, 'call_1')]),
        makeEndTurnResponse('two'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const beginCalls = context.stepBeginCalls();
    const endCalls = context.stepEndCalls();
    expect(beginCalls).toHaveLength(2);
    expect(endCalls).toHaveLength(2);
    // Two distinct step uuids — no reuse across steps.
    expect(beginCalls[0]!.input.uuid).not.toBe(beginCalls[1]!.input.uuid);
    // Each step_end pairs with its matching step_begin by uuid.
    expect(endCalls[0]!.input.uuid).toBe(beginCalls[0]!.input.uuid);
    expect(endCalls[1]!.input.uuid).toBe(beginCalls[1]!.input.uuid);
    // The step ordinals are monotonic 1 → 2.
    expect(beginCalls[0]!.input.step).toBe(1);
    expect(beginCalls[1]!.input.step).toBe(2);
  });
});

describe('runSoulTurn — in-Soul fallback writes (25c-2 behaviour B)', () => {
  it('B.1 tool-not-found: Soul writes appendToolCall + parent-linked appendToolResult', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('nope', { x: 1 }, 'call_missing')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    // Deliberately no tool registered with the name "nope".
    const config: SoulConfig = { tools: [] };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const toolCallCalls = context.toolCallCalls();
    const toolResultCalls = context.toolResultCalls();
    expect(toolCallCalls).toHaveLength(1);
    expect(toolResultCalls).toHaveLength(1);

    // The tool_call row mirrors what the LLM emitted.
    expect(toolCallCalls[0]!.input.data.tool_call_id).toBe('call_missing');
    expect(toolCallCalls[0]!.input.data.tool_name).toBe('nope');

    // The fallback tool_result is linked to the emitted tool_call via
    // parentUuid (the tool_call row's uuid).
    expect(toolResultCalls[0]!.toolCallId).toBe('call_missing');
    expect(toolResultCalls[0]!.parentUuid).toBe(toolCallCalls[0]!.input.uuid);
    expect(toolResultCalls[0]!.result.isError).toBe(true);

    // Anchoring: the tool_call row points at the active step_begin.
    const beginCalls = context.stepBeginCalls();
    expect(toolCallCalls[0]!.input.stepUuid).toBe(beginCalls[0]!.input.uuid);
  });

  it('B.2 zod-parse-fail: Soul writes appendToolCall + parent-linked appendToolResult', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        // StrictArgsTool requires { value: number }; send a mismatched shape.
        makeToolUseResponse([
          makeToolCall('strict', { value: 'not a number' }, 'call_bad'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new StrictArgsTool()] };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const toolCallCalls = context.toolCallCalls();
    const toolResultCalls = context.toolResultCalls();
    expect(toolCallCalls).toHaveLength(1);
    expect(toolResultCalls).toHaveLength(1);

    expect(toolCallCalls[0]!.input.data.tool_call_id).toBe('call_bad');
    expect(toolCallCalls[0]!.input.data.tool_name).toBe('strict');

    // parent linkage must match the Soul-written tool_call row's uuid.
    expect(toolResultCalls[0]!.toolCallId).toBe('call_bad');
    expect(toolResultCalls[0]!.parentUuid).toBe(toolCallCalls[0]!.input.uuid);
    expect(toolResultCalls[0]!.result.isError).toBe(true);
  });

  it('B.3 beforeToolCall hook throws: Soul writes appendToolCall + parent-linked appendToolResult', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'call_hook')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const beforeToolCall = async (_ctx: BeforeToolCallContext): Promise<never> => {
      throw new Error('hook exploded');
    };
    const config: SoulConfig = {
      tools: [new EchoTool()],
      beforeToolCall,
    };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const toolCallCalls = context.toolCallCalls();
    const toolResultCalls = context.toolResultCalls();
    expect(toolCallCalls).toHaveLength(1);
    expect(toolResultCalls).toHaveLength(1);

    expect(toolCallCalls[0]!.input.data.tool_call_id).toBe('call_hook');
    expect(toolResultCalls[0]!.parentUuid).toBe(toolCallCalls[0]!.input.uuid);
    expect(toolResultCalls[0]!.result.isError).toBe(true);
  });
});

describe('runSoulTurn — streaming content_part order (25c-2 behaviour C)', () => {
  it('preserves text → think → text order from the streamed response content', async () => {
    // Craft a ChatResponse whose `message.content` interleaves text and
    // thinking blocks. `ScriptedKosongAdapter.chat()` fans these out via
    // `onAtomicPart({kind:'content', ...})`, so the arrival order at the
    // FakeContextState's `appendContentPart` must mirror the array order.
    const response: ChatResponse = {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'A' },
          { type: 'thinking', thinking: 'T' },
          { type: 'text', text: 'B' },
        ],
      },
      toolCalls: [],
      stopReason: 'end_turn',
      usage: zeroUsage(),
    };

    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({ responses: [response] });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [] };

    await runSoulTurn(
      { text: 'stream me' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const parts = context.contentPartCalls();
    expect(parts).toHaveLength(3);
    expect(parts[0]!.input.part).toEqual({ kind: 'text', text: 'A' });
    expect(parts[1]!.input.part).toEqual({ kind: 'think', think: 'T' });
    expect(parts[2]!.input.part).toEqual({ kind: 'text', text: 'B' });

    // All three parts share the surrounding step's uuid.
    const stepUuid = context.stepBeginCalls()[0]!.input.uuid;
    for (const p of parts) {
      expect(p.input.stepUuid).toBe(stepUuid);
    }
  });
});

describe('runSoulTurn — abort leaves a partial step (25c-2 behaviour D, decision C6)', () => {
  /**
   * Hanging adapter whose `chat()` never resolves on its own. The only
   * way out is `params.signal` firing. Mirrors the pattern in
   * `test/perf/run-turn-hang-recovery.test.ts` but we run synchronously
   * (no timers) by aborting the controller before invoking runSoulTurn.
   */
  class HangingAtomicAdapter implements KosongAdapter {
    chatCalls = 0;
    async chat(params: ChatParams): Promise<ChatResponse> {
      this.chatCalls += 1;
      return new Promise<ChatResponse>((_resolve, reject) => {
        const onAbort = (): void => {
          const err = new Error('chat aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (params.signal.aborted) {
          onAbort();
          return;
        }
        params.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  it('writes appendStepBegin before the LLM call but never appendStepEnd on abort', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const context = new FakeContextState();
      const controller = new AbortController();
      const kosong = new HangingAtomicAdapter();
      const { runtime } = createFakeRuntime({ kosong });
      const sink = new CollectingEventSink();
      const config: SoulConfig = { tools: [] };

      const turnPromise = runSoulTurn(
        { text: 'go' },
        config,
        context,
        runtime,
        sink,
        controller.signal,
      );

      setTimeout(() => {
        controller.abort();
      }, 50);

      await vi.advanceTimersByTimeAsync(100);
      const result = await turnPromise;

      expect(result.stopReason).toBe('aborted');
      expect(kosong.chatCalls).toBe(1);
      // The WAL carries the "step opened" row …
      expect(context.stepBeginCalls()).toHaveLength(1);
      // … but NOT the matching "step closed" row (C6 partial step).
      expect(context.stepEndCalls()).toHaveLength(0);
      // Legacy aggregated write remains off during abort.
      expect(context.assistantCalls()).toHaveLength(0);
      expect(sink.byType('step.interrupted')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runSoulTurn — atomic writes run BEFORE tool loop (25c-2 ordering invariant)', () => {
  it('orders appendStepBegin → appendContentPart(s) / appendToolCall(s) → tool_results → appendStepEnd', async () => {
    // Craft a 1-step turn that triggers the B.1 fallback (tool-not-found)
    // so we see appendToolCall + appendToolResult wedged into the atomic
    // step envelope. This is the canonical sequence Soul must preserve
    // on every step.
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('missing', { x: 1 }, 'call_z')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [] };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const kinds = context.calls.map((c) => c.kind);
    // First step: step_begin → tool_call (fallback) → tool_result (fallback) → step_end.
    // Second step: step_begin → content_part ('done') → step_end.
    expect(kinds).toEqual([
      'appendStepBegin',
      'appendToolCall',
      'appendToolResult',
      'appendStepEnd',
      'appendStepBegin',
      'appendContentPart',
      'appendStepEnd',
    ]);
    expect(context.assistantCalls()).toHaveLength(0);
  });
});

// The `assistantMessage` field on BeforeToolCallContext is provided by
// run-turn.ts but we only consume it indirectly through the context
// argument — the hook we pass above ignores it. Importing the type keeps
// the test file honest about what the hook signature looks like.
type _SanityCheck = BeforeToolCallContext;
