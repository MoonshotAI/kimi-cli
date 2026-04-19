/**
 * Phase 25 Stage C — Slice 25c-3 parent-uuid threading coverage.
 *
 * Pins the Soul-side contract that changes when the orchestrator starts
 * writing happy-path `appendToolCall` records (25c-3):
 *
 *   - Soul allocates a fresh `toolCallByProviderId: Map<string,string>`
 *     per step and hands it to `config.beforeToolCall` through the
 *     `BeforeToolCallContext`.
 *   - Soul hands the step's `stepUuid` / `turnId` / `stepNumber` to
 *     `config.beforeToolCall` via `BeforeToolCallContext`.
 *   - After `tool.execute` succeeds, Soul reads `parentUuid` from the
 *     Map under `toolCall.id` and passes it as the first argument to
 *     `context.appendToolResult(parentUuid, toolCallId, adapted)`.
 *   - Missing Map entry → `parentUuid === undefined` (preserves 25c-2
 *     behaviour for fixtures that never plug in an orchestrator-like
 *     `beforeToolCall` hook).
 *
 * The orchestrator itself is NOT exercised here — the 25c-3 matrix for
 * orchestrator-side writes lives in
 * `test/soul-plus/orchestrator-atomic-append-tool-call.test.ts`. This
 * file uses a lightweight fake `beforeToolCall` that mirrors what the
 * orchestrator will do (stamp a deterministic wireUuid into the Map) so
 * we can verify Soul's reader-side wiring without booting the whole
 * SoulPlus stack.
 */

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { SoulConfig } from '../../src/soul/index.js';
import type { BeforeToolCallContext } from '../../src/soul/types.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { EchoTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

// ── Local helpers ────────────────────────────────────────────────────

/**
 * Record every `BeforeToolCallContext` Soul passes into the hook so
 * tests can assert the per-step Map / stepUuid / turnId / stepNumber
 * wiring without mocking the orchestrator's internals. Default behaviour
 * mimics 25c-3 orchestrator: stamp `'fake-wire-uuid-' + toolCall.id`
 * into the Map and return undefined (permission allow).
 */
function makeRecordingBeforeToolCall(): {
  readonly observed: BeforeToolCallContext[];
  readonly hook: NonNullable<SoulConfig['beforeToolCall']>;
} {
  const observed: BeforeToolCallContext[] = [];
  const hook: NonNullable<SoulConfig['beforeToolCall']> = async (btcCtx) => {
    observed.push(btcCtx);
    const map = (btcCtx as { toolCallByProviderId?: Map<string, string> }).toolCallByProviderId;
    if (map !== undefined) {
      map.set(btcCtx.toolCall.id, `fake-wire-uuid-${btcCtx.toolCall.id}`);
    }
    return undefined;
  };
  return { observed, hook };
}

describe('runSoulTurn — parent-uuid threading via toolCallByProviderId (25c-3 behaviour)', () => {
  it('B.11 allocates a fresh per-step Map so two steps carry independent parentUuids', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'one' }, 'call_step1')]),
        makeToolUseResponse([makeToolCall('echo', { text: 'two' }, 'call_step2')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const { observed, hook } = makeRecordingBeforeToolCall();
    const config: SoulConfig = { tools: [new EchoTool()], beforeToolCall: hook };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    // Two steps → the hook sees two distinct Map instances.
    expect(observed).toHaveLength(2);
    const map1 = (observed[0] as { toolCallByProviderId?: Map<string, string> })
      .toolCallByProviderId;
    const map2 = (observed[1] as { toolCallByProviderId?: Map<string, string> })
      .toolCallByProviderId;
    expect(map1).toBeInstanceOf(Map);
    expect(map2).toBeInstanceOf(Map);
    expect(map1).not.toBe(map2);

    // Each tool_result carries the wireUuid the hook stamped for its own
    // step — no cross-step bleed.
    const results = context.toolResultCalls();
    expect(results).toHaveLength(2);
    expect(results[0]!.toolCallId).toBe('call_step1');
    expect(results[0]!.parentUuid).toBe('fake-wire-uuid-call_step1');
    expect(results[1]!.toolCallId).toBe('call_step2');
    expect(results[1]!.parentUuid).toBe('fake-wire-uuid-call_step2');
  });

  it('B.12 hands `toolCallByProviderId` (a Map, not undefined) to `beforeToolCall`', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'call_1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const { observed, hook } = makeRecordingBeforeToolCall();
    const config: SoulConfig = { tools: [new EchoTool()], beforeToolCall: hook };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(observed).toHaveLength(1);
    const map = (observed[0] as { toolCallByProviderId?: Map<string, string> })
      .toolCallByProviderId;
    expect(map).toBeInstanceOf(Map);
  });

  it('B.13 stamps the active stepUuid onto btcCtx — same uuid Soul wrote to appendStepBegin', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'call_1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const { observed, hook } = makeRecordingBeforeToolCall();
    const config: SoulConfig = { tools: [new EchoTool()], beforeToolCall: hook };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const stepBeginCalls = context.stepBeginCalls();
    expect(stepBeginCalls).toHaveLength(2); // 2 steps: tool_use + end_turn
    const firstStepUuid = stepBeginCalls[0]!.input.uuid;
    const firstStepNumber = stepBeginCalls[0]!.input.step;
    const firstTurnId = stepBeginCalls[0]!.input.turnId;

    expect(observed).toHaveLength(1);
    const ctx = observed[0] as BeforeToolCallContext & {
      stepUuid?: string;
      turnId?: string;
      stepNumber?: number;
    };
    expect(ctx.stepUuid).toBe(firstStepUuid);
    expect(ctx.turnId).toBe(firstTurnId);
    expect(ctx.stepNumber).toBe(firstStepNumber);
  });

  it('B.14 happy-path appendToolResult reads parentUuid from the Map and forwards it', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'call_abc')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const { hook } = makeRecordingBeforeToolCall();
    const config: SoulConfig = { tools: [new EchoTool()], beforeToolCall: hook };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const results = context.toolResultCalls();
    expect(results).toHaveLength(1);
    expect(results[0]!.toolCallId).toBe('call_abc');
    expect(results[0]!.parentUuid).toBe('fake-wire-uuid-call_abc');
    // Happy-path does NOT double-write a Soul-side tool_call row — the
    // orchestrator owns that responsibility (25c-3); the fake hook here
    // stands in for it. Soul's own `appendToolCall` writes stay reserved
    // for the 25c-2 fallback branches, which this test does not exercise.
    expect(context.toolCallCalls()).toHaveLength(0);
  });

  it('B.15 Map miss → appendToolResult.parentUuid === undefined (25c-2 back-compat preserved)', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'call_noop')]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    // beforeToolCall that deliberately does NOT stamp the Map — mimics
    // the 25c-2 pre-landing orchestrator or a permission closure that
    // allows without registering a wireUuid.
    const config: SoulConfig = {
      tools: [new EchoTool()],
      beforeToolCall: async () => undefined,
    };

    await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    const results = context.toolResultCalls();
    expect(results).toHaveLength(1);
    expect(results[0]!.toolCallId).toBe('call_noop');
    expect(results[0]!.parentUuid).toBeUndefined();
  });

  it('B.15b without a beforeToolCall hook at all, parentUuid stays undefined on happy path', async () => {
    // Same as B.15 but the entire hook is absent. Soul must still thread
    // a Map into the step, just never populate it.
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'call_bare')]),
        makeEndTurnResponse('done'),
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

    const results = context.toolResultCalls();
    expect(results).toHaveLength(1);
    expect(results[0]!.parentUuid).toBeUndefined();
  });
});
