// Covers: abort-signal handling in `runSoulTurn` (§5.1.7 catch block).
// Golden rule: abort resolves the turn with stopReason='aborted' (NOT throw);
// only non-abort errors rethrow. See §5.1.7 L1519-L1528.

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { SoulConfig, ToolResult } from '../../src/soul/index.js';
import { CollectingEventSink } from './fixtures/collecting-event-sink.js';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/common.js';
import { FakeContextState } from './fixtures/fake-context-state.js';
import { createFakeRuntime } from './fixtures/fake-runtime.js';
import { EchoTool, SlowTool } from './fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from './fixtures/scripted-kosong.js';

describe('runSoulTurn — abort paths', () => {
  it('pre-abort: signal already aborted before turn starts → aborted', async () => {
    const context = new FakeContextState();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('should not run')],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const controller = new AbortController();
    controller.abort();

    const result = await runSoulTurn(
      { text: 'abort me' },
      { tools: [] },
      context,
      runtime,
      sink,
      controller.signal,
    );

    expect(result.stopReason).toBe('aborted');
    expect(kosong.callCount).toBe(0);
    // Nothing should be written to context when aborted before the first LLM call
    expect(context.calls).toHaveLength(0);
    // step.interrupted should fire once, with reason 'aborted'
    const interrupted = sink.byType('step.interrupted');
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.reason).toBe('aborted');
  });

  it('abort during LLM call mid-turn → resolves with stopReason=aborted', async () => {
    const context = new FakeContextState();
    const controller = new AbortController();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeEndTurnResponse('never delivered')],
      abortOnIndex: { index: 0, controller },
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const config: SoulConfig = { tools: [] };

    const result = await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      controller.signal,
    );

    expect(result.stopReason).toBe('aborted');
    expect(kosong.callCount).toBe(1);
    // Phase 25 Stage C — slice 25c-2: Soul writes appendStepBegin
    // BEFORE the LLM call so the WAL carries a "step opened" row even
    // when the LLM itself aborts. Per decision C6 (partial step) Soul
    // does NOT synthesise a matching appendStepEnd on abort — the
    // missing step_end is the signal the replay-projector uses to
    // detect an interrupted step. The legacy aggregated
    // appendAssistantMessage path remains dormant on this branch.
    expect(context.assistantCalls()).toHaveLength(0);
    expect(context.stepBeginCalls()).toHaveLength(1);
    expect(context.stepEndCalls()).toHaveLength(0);
    expect(sink.byType('step.interrupted')).toHaveLength(1);
  });

  it('abort during tool execution → synthetic error tool_result + aborted', async () => {
    const context = new FakeContextState();
    const controller = new AbortController();
    const kosong = new ScriptedKosongAdapter({
      responses: [makeToolUseResponse([makeToolCall('slow', {}, 'call_slow')])],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const slow = new SlowTool();
    const config: SoulConfig = { tools: [slow] };

    // Abort after the slow tool starts executing. We schedule it on the
    // next microtask tick so the tool has a chance to register its
    // signal listener.
    const turnPromise = runSoulTurn(
      { text: 'call slow' },
      config,
      context,
      runtime,
      sink,
      controller.signal,
    );
    queueMicrotask(() => {
      controller.abort();
    });

    const result = await turnPromise;

    expect(result.stopReason).toBe('aborted');
    // Soul should have written a synthetic error tool_result for the cancelled call
    const toolResults = context.toolResultCalls();
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.toolCallId).toBe('call_slow');
    expect(toolResults[0]?.result.isError).toBe(true);
    // step.interrupted emitted once
    expect(sink.count('step.interrupted')).toBe(1);
  });

  it('abort does NOT throw — Soul resolves cleanly with TurnResult', async () => {
    const context = new FakeContextState();
    const controller = new AbortController();
    controller.abort();
    const kosong = new ScriptedKosongAdapter({ responses: [] });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();

    // Key assertion: `await` resolves, does not throw
    await expect(
      runSoulTurn({ text: 'x' }, { tools: [] }, context, runtime, sink, controller.signal),
    ).resolves.toMatchObject({ stopReason: 'aborted' });
  });

  it('multi-step turn: abort between steps is caught on the while-top safe point', async () => {
    const context = new FakeContextState();
    const controller = new AbortController();
    const kosong = new ScriptedKosongAdapter({
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'step1' })]),
        makeEndTurnResponse('step2'),
      ],
    });
    const { runtime } = createFakeRuntime({ kosong });
    const sink = new CollectingEventSink();
    const echo = new EchoTool();
    // Subclass to abort right after the first tool execution completes,
    // so the next step's while-top safe point catches the aborted signal.
    class AbortAfterEcho extends EchoTool {
      override async execute(
        id: string,
        args: { text: string },
        signal: AbortSignal,
      ): Promise<ToolResult> {
        const r = await super.execute(id, args, signal);
        controller.abort();
        return r;
      }
    }
    const config: SoulConfig = { tools: [new AbortAfterEcho()] };

    const result = await runSoulTurn(
      { text: 'go' },
      config,
      context,
      runtime,
      sink,
      controller.signal,
    );

    expect(result.stopReason).toBe('aborted');
    // Step 1 finished its tool_result before abort landed
    expect(context.toolResultCalls().length).toBeGreaterThanOrEqual(1);
    // The second kosong.chat call should NOT have happened (abort caught at safe point)
    expect(kosong.callCount).toBe(1);
    // Silence "unused variable" lint on echo
    void echo;
  });
});
