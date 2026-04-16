/**
 * SoulRegistry — per-session `Map<SoulKey, SoulHandle>` (v2 §5.2.3).
 *
 * Slice 3: only the `main` Soul is created.
 * Slice 7: SubagentHost.spawn for same-process subagents.
 *
 * Responsibilities:
 *   - `getOrCreate(key)` — idempotent handle creation
 *   - `has(key)` / `keys()` — lookup without side-effects
 *   - `destroy(key)` — abort + drop entry
 *   - `spawn(request)` — SubagentHost: creates `sub:<id>` entry, returns SubagentHandle;
 *                       the entry is automatically destroyed once the subagent
 *                       completion settles (Slice 7 audit Finding #5).
 */

import { randomUUID } from 'node:crypto';

import type { AgentResult, SpawnRequest, SubagentHandle, SubagentHost } from './subagent-types.js';
import type { SoulHandle, SoulKey } from './types.js';

export interface SoulRegistryDeps {
  /**
   * Factory invoked on first `getOrCreate(key)`. The registry does not own
   * the handle construction — TurnManager / SoulPlus decide what goes
   * inside a handle.
   */
  readonly createHandle: (key: SoulKey) => SoulHandle;

  /**
   * Optional callback invoked by `spawn()` to run the subagent Soul turn.
   * When omitted, completion resolves immediately with a stub AgentResult
   * (used by unit tests that only exercise registry mechanics).
   */
  readonly runSubagentTurn?:
    | ((agentId: string, request: SpawnRequest, signal: AbortSignal) => Promise<AgentResult>)
    | undefined;
}

export class SoulRegistry implements SubagentHost {
  private readonly handles = new Map<SoulKey, SoulHandle>();
  private readonly createHandle: (key: SoulKey) => SoulHandle;
  private readonly runSubagentTurnFn:
    | ((agentId: string, request: SpawnRequest, signal: AbortSignal) => Promise<AgentResult>)
    | undefined;

  constructor(deps: SoulRegistryDeps) {
    this.createHandle = deps.createHandle;
    this.runSubagentTurnFn = deps.runSubagentTurn;
  }

  getOrCreate(key: SoulKey): SoulHandle {
    const existing = this.handles.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const fresh = this.createHandle(key);
    this.handles.set(key, fresh);
    return fresh;
  }

  has(key: SoulKey): boolean {
    return this.handles.has(key);
  }

  destroy(key: SoulKey): void {
    const handle = this.handles.get(key);
    if (handle === undefined) {
      return;
    }
    handle.abortController.abort();
    this.handles.delete(key);
  }

  keys(): readonly SoulKey[] {
    return [...this.handles.keys()];
  }

  // ── SubagentHost implementation (Slice 7) ────────────────────────────

  async spawn(request: SpawnRequest): Promise<SubagentHandle> {
    // Slice 7 audit Finding #4: subagent ids must be stable across
    // session resume. A process-local counter collides on restart and
    // stomps the persisted `subagents/<id>` directory of the previous
    // session. Use a UUID (matches Python parity in
    // `kimi_cli.tools.agent.__init__.py:202` /
    // `kimi_cli.subagents.runner.py:373`, which derive their random
    // ids from `uuid.uuid4()`).
    const agentId = `sub_${randomUUID()}`;
    const soulKey: SoulKey = `sub:${agentId}`;

    const soulHandle = this.getOrCreate(soulKey);

    // Slice 2.1 — foreground abort cascade. When the parent turn forwards
    // its AbortSignal via `SpawnRequest.signal`, link it to the child
    // soul's AbortController so a parent `controller.abort()` reaches the
    // subagent (Python parity: `asyncio.CancelledError` propagates through
    // `await` chains). Background spawns are excluded because their
    // independence invariant (kimi-cli §5.9) requires the child to outlive
    // parent abort.
    const parentSignal = request.signal;
    if (parentSignal !== undefined && request.runInBackground !== true) {
      if (parentSignal.aborted) {
        soulHandle.abortController.abort(parentSignal.reason);
      } else {
        parentSignal.addEventListener(
          'abort',
          () => {
            soulHandle.abortController.abort(parentSignal.reason);
          },
          { once: true },
        );
      }
    }

    const completion: Promise<AgentResult> = this.runSubagentTurnFn
      ? this.runSubagentTurnFn(agentId, request, soulHandle.abortController.signal)
      : Promise.resolve({ result: '', usage: { input: 0, output: 0 } });

    // Slice 7 audit Finding #5: subagent handle lifecycle is bound to
    // the completion promise. When the subagent reaches a terminal
    // state (resolved = completed; rejected = failed / killed), the
    // registry entry is destroyed so it stops counting against
    // `keys()` / shutdown / recovery and the AbortController does not
    // leak. Matches the same explicit-transition pattern used for the
    // `main` Soul cleanup path introduced by Slice 3 M2.
    //
    // The cleanup is re-queued via `queueMicrotask` so it always runs
    // after the caller's `await host.spawn(...)` continuation. Without
    // this deferral, an already-settled completion (e.g. the stub path
    // in unit tests) would have its cleanup reaction dispatched before
    // the async-function-return microtask, destroying the handle
    // before the caller ever observes it.
    const cleanup = (): void => {
      queueMicrotask(() => {
        this.destroy(soulKey);
      });
    };
    void completion.then(cleanup, cleanup);

    return {
      agentId,
      parentToolCallId: request.parentToolCallId,
      completion,
    };
  }
}
