// Covers: §5.1.7 happy-path control flow of `runSoulTurn`.
// - single-step end_turn
// - tool loop (LLM → tool → LLM → end_turn)
// - usage accumulation across multiple steps
// - ordering of writes (assistantMessage → toolResults → assistantMessage)

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { SoulConfig } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { EchoTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — happy path', () => {
  it('single-step turn ending with end_turn returns TurnResult{stopReason:"end_turn",steps:1}', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('hello world', { input: 10, output: 5 })],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [] };

    const result = await runSoulTurn(
      { text: 'hi' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(1);
    expect(result.usage.input).toBe(10);
    expect(result.usage.output).toBe(5);
    expect(kosong.callCount).toBe(1);
    // Phase 25 Stage C — slice 25c-2: Soul's main loop writes one
    // step_begin + one content_part ('hello world') + one step_end
    // instead of the legacy aggregated appendAssistantMessage. The
    // legacy assistant-message path must no longer fire.
    expect(context.assistantCalls()).toHaveLength(0);
    expect(context.stepBeginCalls()).toHaveLength(1);
    expect(context.stepEndCalls()).toHaveLength(1);
    expect(context.contentPartCalls()).toHaveLength(1);
    expect(context.contentPartCalls()[0]?.input.part).toEqual({
      kind: 'text',
      text: 'hello world',
    });
    expect(context.toolResultCalls()).toHaveLength(0);
  });

  it('tool loop: LLM → tool → LLM → end_turn produces 2 steps', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'first' }, 'call_1')], {
          input: 7,
          output: 3,
        }),
        makeEndTurnResponse('all done', { input: 4, output: 2 }),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const echo = new EchoTool();
    const config: SoulConfig = { tools: [echo] };

    const result = await runSoulTurn(
      { text: 'call echo' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(2);
    expect(kosong.callCount).toBe(2);
    expect(echo.calls).toHaveLength(1);
    expect(echo.calls[0]).toMatchObject({ id: 'call_1', args: { text: 'first' } });
  });

  it('usage is accumulated across every step in the turn', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'a' })], {
          input: 11,
          output: 7,
        }),
        makeToolUseResponse([makeToolCall('echo', { text: 'b' })], {
          input: 13,
          output: 9,
        }),
        makeEndTurnResponse('final', { input: 2, output: 1 }),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    const result = await runSoulTurn(
      { text: 'multi-step' },
      config,
      context,
      runtime,
      sink,
      new AbortController().signal,
    );

    expect(result.steps).toBe(3);
    expect(result.usage.input).toBe(11 + 13 + 2);
    expect(result.usage.output).toBe(7 + 9 + 1);
  });

  it('writes assistant message before tool results on every step', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([
          makeToolCall('echo', { text: 'alpha' }, 'call_a'),
          makeToolCall('echo', { text: 'beta' }, 'call_b'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    // Phase 25 Stage C — slice 25c-2: Soul writes atomic
    // step_begin / step_end around each step, streams one
    // content_part per streamed content block (none in this fixture
    // because both scripted responses carry tool_calls or plain text),
    // and only writes appendToolResult inside the tool loop.
    //
    // In 25c-2 the happy-path tool_call write is deferred to the
    // orchestrator (25c-3). Soul does NOT write appendToolCall here,
    // so the expected atomic sequence for a 2-step turn with 2 tool
    // calls in step 1 is:
    //   appendStepBegin      (step 1)
    //   appendStepEnd        (step 1)
    //   appendToolResult     (call_a)
    //   appendToolResult     (call_b)
    //   appendStepBegin      (step 2)
    //   appendContentPart    ('done')
    //   appendStepEnd        (step 2)
    const kinds = context.calls.map((c) => c.kind);
    expect(kinds).toEqual([
      'appendStepBegin',
      'appendStepEnd',
      'appendToolResult',
      'appendToolResult',
      'appendStepBegin',
      'appendContentPart',
      'appendStepEnd',
    ]);
    // Soul must NOT emit appendAssistantMessage or appendToolCall on
    // the happy path in this slice.
    expect(context.assistantCalls()).toHaveLength(0);
    expect(context.toolCallCalls()).toHaveLength(0);
    // Happy-path tool_result.parentUuid is undefined until 25c-3
    // orchestrator wires the appendToolCall counterpart.
    for (const tr of context.toolResultCalls()) {
      expect(tr.parentUuid).toBeUndefined();
    }
  });

  it('emits step.begin / step.end symmetrically once per step', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'x' })]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    expect(sink.count('step.begin')).toBe(2);
    expect(sink.count('step.end')).toBe(2);
    expect(sink.count('step.interrupted')).toBe(0);
  });

  it('emits tool.call event for every tool invocation', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([
          makeToolCall('echo', { text: 'one' }, 'call_x'),
          makeToolCall('echo', { text: 'two' }, 'call_y'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    const toolCallEvents = sink.byType('tool.call');
    expect(toolCallEvents).toHaveLength(2);
    expect(toolCallEvents[0]?.toolCallId).toBe('call_x');
    expect(toolCallEvents[1]?.toolCallId).toBe('call_y');
    expect(toolCallEvents[0]?.name).toBe('echo');
    expect(toolCallEvents[0]?.args).toEqual({ text: 'one' });
  });

  it('calls context.beforeStep() before each buildMessages() in a multi-step turn (M3)', async () => {
    const callOrder: string[] = [];
    const context = new FakeContextState();
    context.beforeStep = () => callOrder.push('beforeStep');
    // Intercept buildMessages to track call order
    const origBuildMessages = context.buildMessages.bind(context);
    context.buildMessages = () => {
      callOrder.push('buildMessages');
      return origBuildMessages();
    };

    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'call_1')], {
          input: 5,
          output: 3,
        }),
        makeEndTurnResponse('done', { input: 4, output: 2 }),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [new EchoTool()] };

    await runSoulTurn({ text: 'go' }, config, context, runtime, sink, new AbortController().signal);

    // Two steps → two pairs of beforeStep + buildMessages
    expect(callOrder).toEqual(['beforeStep', 'buildMessages', 'beforeStep', 'buildMessages']);
  });
});
