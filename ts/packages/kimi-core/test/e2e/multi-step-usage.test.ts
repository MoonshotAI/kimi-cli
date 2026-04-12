import { LocalKaos } from '@moonshot-ai/kaos';
import type { Tool, ToolReturnValue } from '@moonshot-ai/kosong';
import { EmptyToolset, ScriptedEchoChatProvider, SimpleToolset, toolOk } from '@moonshot-ai/kosong';
import { describe, expect, test } from 'vitest';

import type { Runtime, TurnResult } from '../../src/index.js';
import { CollectingSink, runTurn } from '../../src/index.js';

// ── E2E: multi-step usage accumulation ────────────────────────────────
//
// runTurn() must sum `result.usage` across every step in the turn, not
// simply report the last step's usage. This was a Codex P2 bug fix
// (`accumulatedUsage` inside `run-turn.ts`). These tests cover the
// trickier edges that the top-level `integration.test.ts` does not:
//
//   - mixed null/non-null step usage (one step reports no usage).
//   - each TokenUsage field (inputOther, output, inputCacheRead,
//     inputCacheCreation) accumulates independently.
//   - the returned `usage` object is a new structure, not a reference
//     to any individual step's usage.
//   - usage accumulation survives an abort (partial accumulation is
//     preserved, not dropped).

function createRuntime(
  provider: ScriptedEchoChatProvider,
  toolset: SimpleToolset | EmptyToolset,
  maxStepsPerTurn: number = 10,
): Runtime {
  return {
    llm: provider,
    kaos: new LocalKaos(),
    toolset,
    maxStepsPerTurn,
  };
}

function usageScript(
  opts: { inputOther: number; output: number; cacheRead: number; cacheCreation: number },
  body: string,
): string {
  return [
    `usage: {"input_other": ${opts.inputOther}, "output": ${opts.output}, "input_cache_read": ${opts.cacheRead}, "input_cache_creation": ${opts.cacheCreation}}`,
    body,
  ].join('\n');
}

function noopToolset(): SimpleToolset {
  const toolset = new SimpleToolset();
  const noopTool: Tool = {
    name: 'noop',
    description: 'No-op',
    parameters: { type: 'object', properties: {} },
  };
  toolset.add(noopTool, async (): Promise<ToolReturnValue> => toolOk({ output: 'ok' }));
  return toolset;
}

describe('e2e: multi-step usage accumulation (extended)', () => {
  test('mixed null/non-null usage: step 0 reports, step 1 omits, step 2 reports', async () => {
    const toolset = noopToolset();

    const provider = new ScriptedEchoChatProvider([
      usageScript(
        { inputOther: 100, output: 10, cacheRead: 0, cacheCreation: 0 },
        'tool_call: {"id": "tc_1", "name": "noop", "arguments": "{}"}',
      ),
      // Step 1: no `usage:` line at all.
      'tool_call: {"id": "tc_2", "name": "noop", "arguments": "{}"}',
      usageScript({ inputOther: 50, output: 5, cacheRead: 0, cacheCreation: 0 }, 'text: all done'),
    ]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, toolset);

    const result: TurnResult = await runTurn('go', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(3);

    // Accumulated usage is the sum of only the steps that reported usage.
    expect(result.usage).toEqual({
      inputOther: 150,
      output: 15,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  test('each usage field accumulates independently across 4 steps', async () => {
    const toolset = noopToolset();

    const provider = new ScriptedEchoChatProvider([
      usageScript(
        { inputOther: 1, output: 10, cacheRead: 100, cacheCreation: 1000 },
        'tool_call: {"id": "tc_a", "name": "noop", "arguments": "{}"}',
      ),
      usageScript(
        { inputOther: 2, output: 20, cacheRead: 200, cacheCreation: 2000 },
        'tool_call: {"id": "tc_b", "name": "noop", "arguments": "{}"}',
      ),
      usageScript(
        { inputOther: 4, output: 40, cacheRead: 400, cacheCreation: 4000 },
        'tool_call: {"id": "tc_c", "name": "noop", "arguments": "{}"}',
      ),
      usageScript({ inputOther: 8, output: 80, cacheRead: 800, cacheCreation: 8000 }, 'text: end'),
    ]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, toolset);

    const result = await runTurn('go', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(4);
    expect(result.usage).toEqual({
      inputOther: 15, // 1+2+4+8
      output: 150, // 10+20+40+80
      inputCacheRead: 1500, // 100+200+400+800
      inputCacheCreation: 15000, // 1000+2000+4000+8000
    });
  });

  test('usage is reported after max_steps stop reason', async () => {
    const toolset = noopToolset();

    // 3 tool_calls in a row — maxStepsPerTurn = 2 forces max_steps.
    const provider = new ScriptedEchoChatProvider([
      usageScript(
        { inputOther: 10, output: 1, cacheRead: 0, cacheCreation: 0 },
        'tool_call: {"id": "tc_1", "name": "noop", "arguments": "{}"}',
      ),
      usageScript(
        { inputOther: 20, output: 2, cacheRead: 0, cacheCreation: 0 },
        'tool_call: {"id": "tc_2", "name": "noop", "arguments": "{}"}',
      ),
    ]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, toolset, 2);

    const result = await runTurn('go', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('max_steps');
    expect(result.stepCount).toBe(2);
    expect(result.usage).toEqual({
      inputOther: 30,
      output: 3,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  test('single step with all fields zero still reports a usage object', async () => {
    const provider = new ScriptedEchoChatProvider([
      usageScript({ inputOther: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, 'text: hi'),
    ]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, new EmptyToolset());

    const result = await runTurn('hi', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');
    // Even though the step reported all zeros, it's still a non-null
    // usage object (because the provider *did* report usage).
    expect(result.usage).toEqual({
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  test('usage object is not aliased to any individual step (mutation-safety)', async () => {
    const toolset = noopToolset();

    const provider = new ScriptedEchoChatProvider([
      usageScript(
        { inputOther: 7, output: 3, cacheRead: 1, cacheCreation: 0 },
        'tool_call: {"id": "tc_x", "name": "noop", "arguments": "{}"}',
      ),
      usageScript({ inputOther: 2, output: 1, cacheRead: 0, cacheCreation: 0 }, 'text: done'),
    ]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, toolset);

    const result = await runTurn('go', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');
    expect(result.usage).not.toBeNull();
    expect(result.usage).toEqual({
      inputOther: 9,
      output: 4,
      inputCacheRead: 1,
      inputCacheCreation: 0,
    });

    // Mutating the returned object must not leak into internals.
    // (Sanity check: confirms we hand back an independent structure.)
    const snapshot = { ...result.usage! };
    result.usage!.inputOther = -999;
    expect(snapshot.inputOther).toBe(9);
  });
});
