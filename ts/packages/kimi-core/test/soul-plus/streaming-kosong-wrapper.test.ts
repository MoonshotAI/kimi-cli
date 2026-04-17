/**
 * Phase 15 B.4 D1 — StreamingKosongWrapper contract.
 *
 * v2 §3460-3492 + §5470-5474 + 决策 #97: once a streaming KosongAdapter
 * is wrapped, completed-partial tool_use blocks are pushed to the
 * orchestrator for "prefetch" execution while the LLM is still
 * streaming. When the LLM turn ends, the wrapper awaits every in-flight
 * prefetch and surfaces the results on `ChatResponse._prefetchedToolResults`
 * keyed by `ToolCall.id`. Soul's main loop (`run-turn.ts:213-244`) then
 * short-circuits its `tool.execute` call for any tool_call_id present
 * in the map.
 *
 * This file is the red-bar contract for the Phase 15 D1 implementation.
 * Current `src/soul-plus/` has no `streaming-kosong-wrapper.ts` module;
 * the tests below import from that future path. The 6 its pin:
 *
 *   (a) Two concurrent-safe tool calls → both prefetched.
 *   (b) One safe + one unsafe → only the safe one prefetched.
 *   (c) Abort during streaming → sub-controller aborts, map cleared.
 *   (d) Prefetch completed before abort → survives the abort.
 *   (e) Reverse assertion: a tool with NO `isConcurrencySafe` declared
 *       is NEVER prefetched (default-deny, protects Bash / Write / Edit).
 *   (f) Phase 5 placeholder regression: orchestrator's `drainPrefetched`
 *       returns non-empty AFTER the wrapper is in play (was empty-map
 *       pin in Phase 5).
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  ChatParams,
  ChatResponse,
  KosongAdapter,
} from '../../src/soul/runtime.js';
import type { ToolCall, ToolResult } from '../../src/soul/types.js';
// Red-bar import — this module does not yet exist. Phase 15 D1 creates
// `src/soul-plus/streaming-kosong-wrapper.ts`; until then the file
// fails to resolve and the describe block below is fully red.
import { StreamingKosongWrapper } from '../../src/soul-plus/streaming-kosong-wrapper.js';
import type { ToolCallOrchestrator } from '../../src/soul-plus/orchestrator.js';

// ── Test fixtures ────────────────────────────────────────────────────

interface StubOrchestratorOptions {
  readonly safeToolNames: ReadonlySet<string>;
  /** Per-tool-call-id delay to simulate streaming tool execution latency. */
  readonly delays?: Readonly<Record<string, number>>;
}

/**
 * Minimal ToolCallOrchestrator stub exposing the three streaming-slot
 * methods (`executeStreaming` / `drainPrefetched` / `discardStreaming`)
 * in their Phase 15 shape. `executeStreaming` returns a Promise<ToolResult>
 * for tools whose name is in `safeToolNames`, and `undefined` for
 * anything else (default-deny). `discardStreaming` aborts the internal
 * controller and empties the in-flight map.
 */
function makeStubOrchestrator(opts: StubOrchestratorOptions): {
  orchestrator: ToolCallOrchestrator;
  executeStreamingSpy: ReturnType<typeof vi.fn>;
  discardStreamingSpy: ReturnType<typeof vi.fn>;
  pending: Map<string, { resolve: (r: ToolResult) => void; reject: (e: Error) => void }>;
} {
  const pending = new Map<
    string,
    { resolve: (r: ToolResult) => void; reject: (e: Error) => void }
  >();

  const executeStreamingSpy = vi.fn((toolCall: ToolCall, signal: AbortSignal) => {
    if (!opts.safeToolNames.has(toolCall.name)) return undefined;
    return new Promise<ToolResult>((resolve, reject) => {
      pending.set(toolCall.id, { resolve, reject });
      const delay = opts.delays?.[toolCall.id] ?? 0;
      const timer = setTimeout(() => {
        resolve({ content: `prefetched:${toolCall.id}`, output: toolCall.id });
        pending.delete(toolCall.id);
      }, delay);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
        pending.delete(toolCall.id);
      });
    });
  });

  const discardStreamingSpy = vi.fn();

  const orchestrator: Pick<
    ToolCallOrchestrator,
    'executeStreaming' | 'drainPrefetched' | 'discardStreaming'
  > = {
    executeStreaming: executeStreamingSpy as unknown as ToolCallOrchestrator['executeStreaming'],
    drainPrefetched: (() => new Map<string, ToolResult>()) as ToolCallOrchestrator['drainPrefetched'],
    discardStreaming: discardStreamingSpy as unknown as ToolCallOrchestrator['discardStreaming'],
  };

  return {
    orchestrator: orchestrator as ToolCallOrchestrator,
    executeStreamingSpy,
    discardStreamingSpy,
    pending,
  };
}

/**
 * A raw KosongAdapter whose `chat()` emits a scripted list of
 * `onToolCallReady` events synchronously (to simulate the streaming
 * wrapper's internal sub-controller telling the orchestrator about
 * each tool_use block as it completes), then returns a finished
 * response listing the same tool_calls.
 */
function makeScriptedAdapter(toolCalls: readonly ToolCall[]): KosongAdapter {
  return {
    async chat(params: ChatParams): Promise<ChatResponse> {
      // Drive the streaming callback for each tool_use block — the
      // wrapper reads these to decide when to prefetch.
      for (const tc of toolCalls) {
        params.onToolCallReady?.(tc);
      }
      return {
        message: { role: 'assistant', content: '', tool_calls: [...toolCalls] },
        toolCalls: [...toolCalls],
        stopReason: 'tool_use',
        usage: { input: 10, output: 5 },
      };
    },
  };
}

function tc(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, args };
}

function emptyParams(signal: AbortSignal): ChatParams {
  return {
    messages: [],
    tools: [],
    model: 'test-model',
    systemPrompt: '',
    signal,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('StreamingKosongWrapper (Phase 15 B.4 D1)', () => {
  it('(a) two concurrent-safe tool calls → executeStreaming × 2 and _prefetchedToolResults has both', async () => {
    const calls = [tc('tc-1', 'Read'), tc('tc-2', 'Glob')];
    const raw = makeScriptedAdapter(calls);
    const { orchestrator, executeStreamingSpy } = makeStubOrchestrator({
      safeToolNames: new Set(['Read', 'Glob']),
    });

    const wrapper = new StreamingKosongWrapper(raw, orchestrator);
    const response = await wrapper.chat(emptyParams(new AbortController().signal));

    expect(executeStreamingSpy).toHaveBeenCalledTimes(2);
    expect(response._prefetchedToolResults).toBeDefined();
    expect(response._prefetchedToolResults!.size).toBe(2);
    expect(response._prefetchedToolResults!.get('tc-1')).toBeDefined();
    expect(response._prefetchedToolResults!.get('tc-2')).toBeDefined();
  });

  it('(b) one concurrent-safe + one unsafe → only the safe tool_call_id is prefetched', async () => {
    const calls = [tc('tc-read', 'Read'), tc('tc-bash', 'Bash')];
    const raw = makeScriptedAdapter(calls);
    const { orchestrator, executeStreamingSpy } = makeStubOrchestrator({
      safeToolNames: new Set(['Read']),
      // Bash is NOT in the safe set → orchestrator returns undefined,
      // wrapper skips it.
    });

    const wrapper = new StreamingKosongWrapper(raw, orchestrator);
    const response = await wrapper.chat(emptyParams(new AbortController().signal));

    // executeStreaming is offered both calls; the orchestrator decides.
    expect(executeStreamingSpy).toHaveBeenCalledTimes(2);
    expect(response._prefetchedToolResults).toBeDefined();
    expect(response._prefetchedToolResults!.size).toBe(1);
    expect(response._prefetchedToolResults!.has('tc-read')).toBe(true);
    expect(response._prefetchedToolResults!.has('tc-bash')).toBe(false);
  });

  it('(c) abort during streaming → discardStreaming called, in-flight prefetches rejected, map empty', async () => {
    const calls = [tc('tc-slow', 'Read')];
    const raw = makeScriptedAdapter(calls);
    const { orchestrator, discardStreamingSpy, pending } = makeStubOrchestrator({
      safeToolNames: new Set(['Read']),
      delays: { 'tc-slow': 10_000 }, // never resolves naturally
    });

    const controller = new AbortController();
    const wrapper = new StreamingKosongWrapper(raw, orchestrator);
    const chatPromise = wrapper.chat(emptyParams(controller.signal));

    // Give the adapter a microtask to invoke onToolCallReady + populate
    // the pending map.
    await new Promise((r) => setTimeout(r, 0));
    expect(pending.size).toBe(1);

    // Abort path: caller aborts before prefetch resolves. The wrapper
    // must issue discardStreaming('aborted') and clear its internal
    // map; the downstream chat promise resolves with an empty (or
    // missing) prefetch map, and in-flight executeStreaming Promises
    // reject via the sub-controller's abort event.
    controller.abort();

    // When the chat promise settles, `_prefetchedToolResults` must be
    // either absent or an empty Map — no half-aborted entries.
    const response = await chatPromise.catch((e: Error) => ({
      message: { role: 'assistant' as const, content: '' },
      toolCalls: [],
      usage: { input: 0, output: 0 },
      _prefetchedToolResults: new Map<string, ToolResult>(),
      _error: e,
    }));

    expect(discardStreamingSpy).toHaveBeenCalledWith('aborted');
    const map = response._prefetchedToolResults;
    expect(map === undefined || map.size === 0).toBe(true);
  });

  it('(d) prefetch already completed before abort → result survives in the map', async () => {
    const calls = [tc('tc-fast', 'Read'), tc('tc-slow', 'Read')];
    const raw = makeScriptedAdapter(calls);
    const { orchestrator } = makeStubOrchestrator({
      safeToolNames: new Set(['Read']),
      // tc-fast resolves immediately; tc-slow is pending when we abort.
      delays: { 'tc-fast': 0, 'tc-slow': 10_000 },
    });

    const controller = new AbortController();
    const wrapper = new StreamingKosongWrapper(raw, orchestrator);
    const chatPromise = wrapper.chat(emptyParams(controller.signal));

    // Yield so tc-fast's setTimeout(0) resolves into the in-flight map.
    await new Promise((r) => setTimeout(r, 5));

    controller.abort();

    const response = await chatPromise.catch(() => undefined);
    // Completed-before-abort result must still be observable — either
    // on the ChatResponse, or via a follow-up `orchestrator.drainPrefetched`
    // call. We keep the expectation flexible so the wrapper can commit
    // the completed entry to either surface.
    const combined =
      (response?._prefetchedToolResults ?? new Map<string, ToolResult>()).get('tc-fast') ??
      orchestrator.drainPrefetched().get('tc-fast');
    expect(combined?.content).toBe('prefetched:tc-fast');
  });

  it('(e) tool with no isConcurrencySafe declared is NEVER prefetched (default-deny)', async () => {
    // 铁律 L14: the safety predicate is opt-in. Bash / Write / Edit
    // never declare it, so the wrapper must never prefetch them even if
    // the LLM emits them as tool_use blocks. The orchestrator stub
    // models this by excluding the tool name from `safeToolNames`.
    const calls = [tc('tc-bash', 'Bash'), tc('tc-write', 'Write'), tc('tc-edit', 'Edit')];
    const raw = makeScriptedAdapter(calls);
    const { orchestrator } = makeStubOrchestrator({
      safeToolNames: new Set<string>(), // nobody is safe → nobody is prefetched
    });

    const wrapper = new StreamingKosongWrapper(raw, orchestrator);
    const response = await wrapper.chat(emptyParams(new AbortController().signal));

    // Map is either absent or empty — not a single prefetch entry.
    const map = response._prefetchedToolResults;
    expect(map === undefined || map.size === 0).toBe(true);
  });

  it('(f) Phase 5 "empty map" placeholder → after Phase 15 wiring drainPrefetched returns non-empty', async () => {
    // Regression guard for the Phase 5 note: orchestrator.drainPrefetched
    // used to return an empty Map unconditionally. Once
    // StreamingKosongWrapper is wired, calling chat() and then
    // drainPrefetched() (or reading response._prefetchedToolResults)
    // must produce at least one entry for any run that included a safe
    // tool call.
    const calls = [tc('tc-safe', 'Read')];
    const raw = makeScriptedAdapter(calls);
    const { orchestrator } = makeStubOrchestrator({
      safeToolNames: new Set(['Read']),
    });

    const wrapper = new StreamingKosongWrapper(raw, orchestrator);
    const response = await wrapper.chat(emptyParams(new AbortController().signal));

    const drained = response._prefetchedToolResults ?? orchestrator.drainPrefetched();
    expect(drained.size).toBeGreaterThan(0);
  });
});

// ── BLK-3 integration regression (round-1 review) ──────────────────────
//
// The stub-based tests above bypass `ToolCallOrchestrator` entirely; with
// the original binding shape a real orchestrator recursed into itself
// via `binding.executeStreaming → orchestrator.executeStreaming → binding
// → …` and blew the call stack in production. This block wires a REAL
// `ToolCallOrchestrator` + a real `Tool` (declaring `isConcurrencySafe =
// () => true`) and calls `wrapper.chat` end-to-end so any future drift
// back into a recursive shape trips the test.

import { HookEngine } from '../../src/hooks/engine.js';
import { AlwaysAllowApprovalRuntime } from '../../src/soul-plus/index.js';
import { ToolCallOrchestrator as RealToolCallOrchestrator } from '../../src/soul-plus/orchestrator.js';
import type { Tool as RealTool } from '../../src/soul/types.js';
import { z } from 'zod';

describe('StreamingKosongWrapper ↔ real ToolCallOrchestrator (BLK-3 regression)', () => {
  it('does not recurse when executeStreaming dispatches to a real concurrent-safe tool', async () => {
    const hookEngine = new HookEngine({ executors: new Map() });
    const orchestrator = new RealToolCallOrchestrator({
      hookEngine,
      sessionId: 'ses_blk3',
      agentId: 'agent_main',
      approvalRuntime: new AlwaysAllowApprovalRuntime(),
    });

    const toolExecuteSpy = vi.fn(
      async (_id: string, args: { q: string }): Promise<ToolResult> => ({
        content: `safe:${args.q}`,
      }),
    );
    const safeTool: RealTool = {
      name: 'SafeRead',
      description: 'read-only',
      inputSchema: z.object({ q: z.string() }),
      execute: toolExecuteSpy,
      isConcurrencySafe: () => true,
    };

    // `wrapTools` is what populates `orchestrator.currentTools`. The
    // production path (`TurnManager.launchTurn`) invokes it once per
    // turn; here we mimic that step directly.
    orchestrator.wrapTools([safeTool]);

    const calls = [
      { id: 'tc-real-1', name: 'SafeRead', args: { q: 'hello' } },
    ];
    const raw = makeScriptedAdapter(calls);
    const wrapper = new StreamingKosongWrapper(raw, orchestrator);

    // Entering an infinite recursion would blow the call stack well
    // before vitest's default 5 s timeout — the completion of this
    // chat() call IS the regression oracle. Tight explicit timeout as
    // belt-and-suspenders.
    const response = await Promise.race([
      wrapper.chat(emptyParams(new AbortController().signal)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('chat() timed out — possible recursion')), 2000),
      ),
    ]);

    expect(toolExecuteSpy).toHaveBeenCalledTimes(1);
    expect(response._prefetchedToolResults?.get('tc-real-1')?.content).toBe('safe:hello');
  });

  it('MAJ-2: raw.chat throw → completed map is stashed on orchestrator (drainPrefetched still yields it)', async () => {
    // Scenario the review flagged: abort fires mid-stream, the
    // underlying KosongAdapter throws (real adapters honour the
    // AbortSignal), and the wrapper's `try { … } return enriched`
    // branch is skipped. Before MAJ-2 the `completed` map was
    // unreachable after the throw — Soul's main loop had nowhere to
    // read the results that resolved before the abort. After the
    // fix, `unbind` stashes the map on the orchestrator so
    // `orchestrator.drainPrefetched()` recovers it.
    const hookEngine = new HookEngine({ executors: new Map() });
    const orchestrator = new RealToolCallOrchestrator({
      hookEngine,
      sessionId: 'ses_maj2',
      agentId: 'agent_main',
      approvalRuntime: new AlwaysAllowApprovalRuntime(),
    });

    const fastTool: RealTool = {
      name: 'FastRead',
      description: 'fast',
      inputSchema: z.object({}),
      execute: async (): Promise<ToolResult> => ({ content: 'fast-result' }),
      isConcurrencySafe: () => true,
    };
    orchestrator.wrapTools([fastTool]);

    // Adapter that fires onToolCallReady (so prefetch starts + completes)
    // then throws to simulate abort propagation through the real LLM path.
    const throwingAdapter: KosongAdapter = {
      async chat(params) {
        params.onToolCallReady?.({ id: 'tc-prefetched', name: 'FastRead', args: {} });
        // Let the prefetch promise resolve + land in `completed`.
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('simulated abort from provider');
      },
    };

    const wrapper = new StreamingKosongWrapper(throwingAdapter, orchestrator);
    await expect(
      wrapper.chat(emptyParams(new AbortController().signal)),
    ).rejects.toThrow(/simulated abort/);

    // orchestrator.drainPrefetched must now yield the stashed entry —
    // this is the "canonical abort-path recovery" contract.
    const stashed = orchestrator.drainPrefetched();
    expect(stashed.size).toBe(1);
    expect(stashed.get('tc-prefetched')?.content).toBe('fast-result');

    // Draining consumes the stash — second call returns empty.
    const secondDrain = orchestrator.drainPrefetched();
    expect(secondDrain.size).toBe(0);
  });

  it('unsafe tool (no isConcurrencySafe) falls through to Soul (no prefetch entry)', async () => {
    const hookEngine = new HookEngine({ executors: new Map() });
    const orchestrator = new RealToolCallOrchestrator({
      hookEngine,
      sessionId: 'ses_blk3_neg',
      agentId: 'agent_main',
      approvalRuntime: new AlwaysAllowApprovalRuntime(),
    });

    const toolExecuteSpy = vi.fn();
    const unsafeTool: RealTool = {
      name: 'UnsafeBash',
      description: 'stateful',
      inputSchema: z.object({ cmd: z.string() }),
      execute: toolExecuteSpy,
      // NOTE: no isConcurrencySafe → default-deny.
    };

    orchestrator.wrapTools([unsafeTool]);

    const calls = [
      { id: 'tc-real-2', name: 'UnsafeBash', args: { cmd: 'rm -rf /' } },
    ];
    const raw = makeScriptedAdapter(calls);
    const wrapper = new StreamingKosongWrapper(raw, orchestrator);
    const response = await wrapper.chat(emptyParams(new AbortController().signal));

    expect(toolExecuteSpy).not.toHaveBeenCalled();
    expect(response._prefetchedToolResults).toBeUndefined();
  });
});
