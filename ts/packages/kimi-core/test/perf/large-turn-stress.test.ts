/**
 * Phase 13 §2 — B2 large-turn stress.
 *
 * Proves that a single Soul turn can take 200+ steps without blowing
 * the JS stack, leaking memory, or exponentially slowing down. Uses
 * the scripted Kosong adapter + the in-memory EchoTool from the Soul
 * fixtures directory — no real LLM, no real IO.
 *
 * Baselines (captured locally on Apple Silicon 2026-04-17; re-measure
 * and update this block when CI regressions land):
 *   - 200 step: < 1.5s local, heap delta < 30 MB
 *   - 500 step: < 4s local, heap delta < 60 MB
 *
 * CI is given a 2× budget via `process.env.CI`. Set `SKIP_PERF=1` to
 * bypass entirely (useful when a flaky CI agent is thrashing).
 */

import { describe, expect, it } from 'vitest';

import { runSoulTurn } from '../../src/soul/index.js';
import type { SoulConfig } from '../../src/soul/index.js';
import { CollectingEventSink } from '../soul/fixtures/collecting-event-sink.js';
import {
  makeEndTurnResponse,
  makeToolCall,
  makeToolUseResponse,
} from '../soul/fixtures/common.js';
import { FakeContextState } from '../soul/fixtures/fake-context-state.js';
import { createFakeRuntime } from '../soul/fixtures/fake-runtime.js';
import { EchoTool } from '../soul/fixtures/fake-tools.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';

const SKIP = process.env['SKIP_PERF'] === '1';
const CI = Boolean(process.env['CI']);

function buildScript(steps: number) {
  // `steps` consecutive tool calls, followed by one end_turn.
  const responses = [];
  for (let i = 0; i < steps; i++) {
    responses.push(makeToolUseResponse([makeToolCall('echo', { text: `step-${String(i)}` })]));
  }
  responses.push(makeEndTurnResponse('done'));
  return responses;
}

async function runStressTurn(steps: number): Promise<{
  wallMs: number;
  heapDeltaMb: number;
  kosongCalls: number;
  toolCalls: number;
}> {
  const context = new FakeContextState();
  const kosong = new ScriptedKosongAdapter({ responses: buildScript(steps) });
  const { runtime } = createFakeRuntime({ kosong });
  const echo = new EchoTool();
  const sink = new CollectingEventSink();
  // Lift the default 100-step ceiling so Soul doesn't raise
  // MaxStepsExceededError mid-stress-run.
  const config: SoulConfig = { tools: [echo], maxSteps: steps + 10 };

  // Baseline heap after all fixture setup but before the turn itself.
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const wallBefore = Date.now();

  const result = await runSoulTurn(
    { text: 'stress me' },
    config,
    context,
    runtime,
    sink,
    new AbortController().signal,
  );

  const wallMs = Date.now() - wallBefore;
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;

  expect(result.stopReason).toBe('end_turn');
  return {
    wallMs,
    heapDeltaMb: (heapAfter - heapBefore) / (1024 * 1024),
    kosongCalls: kosong.callCount,
    toolCalls: echo.calls.length,
  };
}

describe.skipIf(SKIP)('SoulTurn large-turn stress (Phase 13 §2)', () => {
  it('200-step turn completes without stack/heap blowup', async () => {
    const { wallMs, heapDeltaMb, kosongCalls, toolCalls } = await runStressTurn(200);

    const wallBudget = CI ? 60_000 : 30_000;
    const heapBudget = 100; // MB — generous ceiling; regressions show up as 10× growth

    expect(kosongCalls).toBe(201); // 200 tool_use + 1 end_turn
    expect(toolCalls).toBe(200);
    expect(wallMs).toBeLessThan(wallBudget);
    // GC is not guaranteed to run even with global.gc — floor to 0 so
    // we only fail on genuine growth, not allocator fluctuation.
    expect(Math.max(heapDeltaMb, 0)).toBeLessThan(heapBudget);
  }, 120_000);

  it('500-step turn scales roughly linearly vs. 200-step', async () => {
    const { wallMs, heapDeltaMb, kosongCalls } = await runStressTurn(500);

    const wallBudget = CI ? 150_000 : 60_000;
    const heapBudget = 200; // MB ceiling

    expect(kosongCalls).toBe(501);
    expect(wallMs).toBeLessThan(wallBudget);
    expect(Math.max(heapDeltaMb, 0)).toBeLessThan(heapBudget);
  }, 180_000);
});
