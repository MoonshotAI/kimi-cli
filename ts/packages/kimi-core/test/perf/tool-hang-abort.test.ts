/**
 * Phase 13 §3.1 — Tool-level hang + abort propagation.
 *
 * A "HangTool" is a tool whose `execute()` returns a Promise that only
 * resolves when the caller-supplied `signal` fires. When the turn-level
 * abort controller triggers, Soul must converge on `stopReason =
 * 'aborted'` and write a synthetic error `tool_result` (never leak the
 * hung tool as a zombie running step).
 *
 * Fake timers: we fake ONLY `setTimeout` so the abort fires at a
 * specific simulated time. Promise resolution still uses real
 * microtasks, and no real `child_process` IO happens in this file
 * (§R4 — fake vs real timers invariant).
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const SKIP_PERF = process.env['SKIP_PERF'] === '1';

import { runSoulTurn } from '../../src/soul/index.js';
import type { SoulConfig, Tool, ToolResult } from '../../src/soul/index.js';
import { CollectingEventSink } from '../soul/fixtures/collecting-event-sink.js';
import {
  makeEndTurnResponse,
  makeToolCall,
  makeToolUseResponse,
} from '../soul/fixtures/common.js';
import { FakeContextState } from '../soul/fixtures/fake-context-state.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

// ── HangTool variants ────────────────────────────────────────────────

/**
 * Hang until aborted. Cooperates with the AbortSignal: when `signal`
 * fires, the pending promise rejects with an `AbortError`. This is
 * what well-behaved tools do — including the real `BashTool` and
 * subagent dispatch paths.
 */
class CooperativeHangTool implements Tool<Record<string, never>> {
  readonly name = 'hang';
  readonly description = 'Hang until aborted.';
  readonly inputSchema: z.ZodType<Record<string, never>> = z.object({});
  callCount = 0;

  async execute(
    _id: string,
    _args: Record<string, never>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    this.callCount += 1;
    return new Promise<ToolResult>((_resolve, reject) => {
      const onAbort = (): void => {
        const err = new Error('hang tool aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

describe.skipIf(SKIP_PERF)('Tool hang + abort (Phase 13 §3.1) [perf]', () => {
  it('cooperative hang: abort propagates → stopReason=aborted, synthetic tool_result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const context = new FakeContextState();
      const controller = new AbortController();
      const kosong = new ScriptedKosongAdapter({
        responses: [makeToolUseResponse([makeToolCall('hang', {}, 'call_hang')])],
      });
      const { runtime } = createFakeRuntime({ kosong });
      const sink = new CollectingEventSink();
      const hang = new CooperativeHangTool();
      const config: SoulConfig = { tools: [hang] };

      // Start the turn; schedule abort 100ms in the fake timeline.
      const turnPromise = runSoulTurn(
        { text: 'call hang' },
        config,
        context,
        runtime,
        sink,
        controller.signal,
      );

      setTimeout(() => {
        controller.abort();
      }, 100);

      await vi.advanceTimersByTimeAsync(150);
      const result = await turnPromise;

      expect(result.stopReason).toBe('aborted');
      expect(hang.callCount).toBe(1);
      // Soul writes a synthetic error tool_result for the aborted call.
      const toolResults = context.toolResultCalls();
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]?.toolCallId).toBe('call_hang');
      expect(toolResults[0]?.result.isError).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('multi tool_calls, first hangs: abort aborts first, the rest are skipped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const context = new FakeContextState();
      const controller = new AbortController();
      const kosong = new ScriptedKosongAdapter({
        responses: [
          makeToolUseResponse([
            makeToolCall('hang', {}, 'call_a'),
            makeToolCall('hang', {}, 'call_b'),
            makeToolCall('hang', {}, 'call_c'),
          ]),
        ],
      });
      const { runtime } = createFakeRuntime({ kosong });
      const sink = new CollectingEventSink();
      const hang = new CooperativeHangTool();
      const config: SoulConfig = { tools: [hang] };

      const turnPromise = runSoulTurn(
        { text: 'fan out hangs' },
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
      // Soul dispatches tool calls sequentially. Tool #1 gets its
      // synthetic aborted tool_result; tools #2+ are skipped because
      // Soul's `signal.throwIfAborted()` checkpoint at the top of the
      // next iteration converts the abort into a turn-level throw
      // (§5.1.7 L1425). The remaining tool_calls carry no
      // tool_result — a known property of the current run-turn loop,
      // not balanced-transcript behaviour; flagging via
      // `toolResultCalls` keeps this visible to future refactors.
      expect(hang.callCount).toBe(1);
      const resolved = context.toolResultCalls().map((c) => c.toolCallId);
      expect(resolved).toEqual(['call_a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clean re-dispatch: a new turn after abort starts with no leftover state', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const context = new FakeContextState();
      // Turn 1: hang + abort.
      const c1 = new AbortController();
      const k1 = new ScriptedKosongAdapter({
        responses: [makeToolUseResponse([makeToolCall('hang', {}, 'call_first')])],
      });
      const hang = new CooperativeHangTool();
      const config1: SoulConfig = { tools: [hang] };
      const { runtime: rt1 } = createFakeRuntime({ kosong: k1 });
      const sink1 = new CollectingEventSink();
      const turn1 = runSoulTurn(
        { text: 'go hang' },
        config1,
        context,
        rt1,
        sink1,
        c1.signal,
      );
      setTimeout(() => {
        c1.abort();
      }, 25);
      await vi.advanceTimersByTimeAsync(50);
      const result1 = await turn1;
      expect(result1.stopReason).toBe('aborted');

      // Turn 2: clean end_turn using a fresh controller + kosong script.
      const c2 = new AbortController();
      const k2 = new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('clean')] });
      const { runtime: rt2 } = createFakeRuntime({ kosong: k2 });
      const sink2 = new CollectingEventSink();
      const config2: SoulConfig = { tools: [] };
      const result2 = await runSoulTurn(
        { text: 'new work' },
        config2,
        context,
        rt2,
        sink2,
        c2.signal,
      );
      expect(result2.stopReason).toBe('end_turn');
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Known gap (Phase 13 risks R2) ──────────────────────────────────
  //
  // When a tool truly ignores its signal and never resolves, Soul has
  // no caller-side grace timeout — the turn hangs forever. The plan
  // (§3.1 "Phase 13 需先确认 ToolCallOrchestrator...") flags this as a
  // follow-up; today Soul relies on tools being cooperative.
  it.todo(
    'grace timeout: non-cooperative hang tool should be force-reaped after grace period',
  );
});
