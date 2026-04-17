/**
 * StreamingKosongWrapper — Phase 15 B.4 D1 / 决策 #97.
 *
 * Wraps a raw `KosongAdapter` so that `tool_use` blocks surfaced through
 * `ChatParams.onToolCallReady` during streaming can be dispatched to
 * `ToolCallOrchestrator.executeStreaming` ahead of the assistant
 * message completing. Results collected while streaming land on the
 * returned `ChatResponse._prefetchedToolResults` keyed by
 * `ToolCall.id`, which Soul's main loop (`run-turn.ts:213-244`) reads
 * to short-circuit `tool.execute`.
 *
 * 铁律 L14/L15/L16 (see `context/slice-15-edge-cases-tech-debt/PROGRESS.md`):
 *
 *   - Only tools that opt in via `isConcurrencySafe` are prefetched.
 *     Default-deny means Bash / Write / Edit / state-mutating tools are
 *     NEVER pre-executed under streaming, which matters because
 *     rollback is impossible for side-effects.
 *
 *   - `onToolCallReady` is a Phase 2 contract: only this wrapper sets
 *     the callback; `_prefetchedToolResults` is a leading-underscore
 *     internal field that only this wrapper populates. Third-party
 *     KosongAdapters MUST NOT write either.
 *
 *   - `discardStreaming` aborts the sub-controller BEFORE the parent
 *     `controller.abort()` fires, so results already resolved through
 *     `executeStreaming` stay in the in-flight map (they are harvested
 *     on chat settlement); only still-pending prefetches see the abort.
 *     Post-abort, the stashed results sit on
 *     `ToolCallOrchestrator.stashedPrefetched` as a *diagnostic/cleanup*
 *     surface — `TurnManager.abortTurn` drains the stash at the end of
 *     the abort sequence so it never leaks across turns. L16 only
 *     requires that completed prefetches aren't falsely cancelled
 *     DURING abort; discarding them afterwards is fine.
 *
 * BLK-3 regression (round-1 review): the wrapper must NOT route
 * `executeStreaming` through the binding — that caused infinite
 * recursion (wrapper → orchestrator.executeStreaming → binding → …).
 * The orchestrator now owns `executeStreaming` and the wrapper just
 * calls `this.orchestrator.executeStreaming(toolCall, subSignal)`
 * directly. The binding carries only `discardStreaming` +
 * `drainPrefetched`.
 */

import type {
  ChatParams,
  ChatResponse,
  KosongAdapter,
} from '../soul/runtime.js';
import type { ToolCall, ToolResult } from '../soul/types.js';
import type { ToolCallOrchestrator } from './orchestrator.js';

/**
 * Minimal view of `ToolCallOrchestrator` that the wrapper needs. Kept
 * separate from the class so unit tests can satisfy it with a stub
 * (see `test/soul-plus/streaming-kosong-wrapper.test.ts`).
 */
export interface StreamingOrchestrator {
  bindStreaming?: (binding: {
    drainPrefetched: () => ReadonlyMap<string, ToolResult>;
    discardStreaming: (reason: 'aborted' | 'timeout' | 'fallback') => void;
  }) => () => void;

  executeStreaming(
    toolCall: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolResult> | undefined;

  discardStreaming(reason: 'aborted' | 'timeout' | 'fallback'): void;

  drainPrefetched(): ReadonlyMap<string, ToolResult>;
}

export class StreamingKosongWrapper implements KosongAdapter {
  constructor(
    private readonly raw: KosongAdapter,
    private readonly orchestrator: ToolCallOrchestrator | StreamingOrchestrator,
  ) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    // Sub-controller keeps the prefetch lifetime scoped to THIS chat()
    // call. Linked to the caller's `signal` so external cancel / abort
    // propagates into in-flight prefetches, but distinct from it so
    // `discardStreaming('aborted')` can fire two steps before the
    // parent `controller.abort()` (铁律 L16).
    const sub = new AbortController();
    const inFlight = new Map<string, Promise<ToolResult>>();
    const completed = new Map<string, ToolResult>();

    const onCallerAbort = (): void => {
      // External abort: tell the orchestrator (which routes to our
      // binding's `discardStreaming` below to cancel the sub-
      // controller) so any higher-layer state is notified. Fallback
      // for stub orchestrators that don't call back into our binding:
      // abort the sub-controller ourselves.
      try {
        this.orchestrator.discardStreaming('aborted');
      } catch {
        /* best-effort */
      }
      if (!sub.signal.aborted) sub.abort();
    };

    if (params.signal.aborted) {
      sub.abort();
    } else {
      params.signal.addEventListener('abort', onCallerAbort);
    }

    const onToolCallReady = (toolCall: ToolCall): void => {
      // Fan out to the orchestrator; if it declines (e.g. the tool did
      // not opt into `isConcurrencySafe`) we leave the call to Soul's
      // main loop. A second ready event for the same id is ignored so
      // flaky adapters that re-emit mid-stream can't double-execute.
      if (inFlight.has(toolCall.id) || completed.has(toolCall.id)) return;
      const pending = this.orchestrator.executeStreaming(toolCall, sub.signal);
      if (pending === undefined) return;
      inFlight.set(toolCall.id, pending);
      pending
        .then((result) => {
          inFlight.delete(toolCall.id);
          completed.set(toolCall.id, result);
        })
        .catch(() => {
          // Rejections are abort-driven — drop silently so Soul can
          // re-execute through the normal loop after the chat resolves.
          inFlight.delete(toolCall.id);
        });
    };

    // Expose discard + drain to the orchestrator so
    // `TurnManager.abortTurn → orchestrator.discardStreaming` routes
    // back here and `orchestrator.drainPrefetched` can harvest the
    // completed map on unbind.
    const binding = {
      drainPrefetched: (): ReadonlyMap<string, ToolResult> => {
        const snapshot = new Map(completed);
        completed.clear();
        return snapshot;
      },
      discardStreaming: (_reason: 'aborted' | 'timeout' | 'fallback'): void => {
        // Abort pending prefetches; completed results survive in
        // `completed` so Soul / downstream UI can still reuse them
        // (铁律 L16).
        if (!sub.signal.aborted) sub.abort();
      },
    };

    const unbind =
      typeof (this.orchestrator as StreamingOrchestrator).bindStreaming === 'function'
        ? (this.orchestrator as StreamingOrchestrator).bindStreaming!(binding)
        : (): void => {};

    try {
      // Forward the original params verbatim but splice in our
      // `onToolCallReady` handler (chaining any caller-provided one).
      const chained = params.onToolCallReady;
      const wrappedParams: ChatParams = {
        ...params,
        onToolCallReady: (tc) => {
          try {
            onToolCallReady(tc);
          } finally {
            chained?.(tc);
          }
        },
      };

      const response = await this.raw.chat(wrappedParams);

      // Wait for all still-pending prefetches; any that throw (e.g.
      // because the sub-controller was aborted while they were in
      // flight) are swallowed — Soul will run the tool normally.
      if (inFlight.size > 0) {
        await Promise.allSettled(inFlight.values());
      }

      const merged = new Map<string, ToolResult>(completed);
      // Snapshot complete — clear internal slot so a stale call to
      // `drainPrefetched` post-return doesn't see duplicates.
      completed.clear();

      const enriched: ChatResponse = {
        ...response,
        ...(merged.size > 0 ? { _prefetchedToolResults: merged } : {}),
      };
      return enriched;
    } finally {
      // `unbind()` copies whatever is left in `completed` onto the
      // orchestrator's stash (MAJ-2 — when `raw.chat` threw, merging
      // into `enriched` never happened, so the orchestrator's post-
      // chat `drainPrefetched()` is the canonical recovery path).
      unbind();
      params.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}
