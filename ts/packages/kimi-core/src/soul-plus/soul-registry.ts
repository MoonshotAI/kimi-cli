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

import type { SessionJournal } from '../storage/session-journal.js';
import { RESULT_SUMMARY_MAX_LEN } from './subagent-constants.js';
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

  /**
   * Phase 6 (决策 #88 / §3.6.1) — when supplied, `spawn()` writes the
   * three subagent lifecycle records (`subagent_spawned` /
   * `subagent_completed` / `subagent_failed`) to the parent session
   * journal so the parent wire carries lifecycle references without ever
   * touching the child's conversation payload (which now lives on the
   * child's own `wire.jsonl`). Optional so unit tests that only
   * exercise registry mechanics (without a journal) keep compiling.
   */
  readonly parentSessionJournal?: SessionJournal | undefined;
}

export class SoulRegistry implements SubagentHost {
  private readonly handles = new Map<SoulKey, SoulHandle>();
  private readonly createHandle: (key: SoulKey) => SoulHandle;
  private readonly runSubagentTurnFn:
    | ((agentId: string, request: SpawnRequest, signal: AbortSignal) => Promise<AgentResult>)
    | undefined;
  private readonly parentSessionJournal: SessionJournal | undefined;

  constructor(deps: SoulRegistryDeps) {
    this.createHandle = deps.createHandle;
    this.runSubagentTurnFn = deps.runSubagentTurn;
    this.parentSessionJournal = deps.parentSessionJournal;
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

    // Phase 6 (决策 #88) — write `subagent_spawned` to the parent journal
    // BEFORE invoking the runner so the parent wire records the spawn
    // even if the runner setup throws synchronously. The cleanup chain
    // below writes `subagent_completed` / `subagent_failed` once the
    // turn settles. The runner itself does NOT write these records when
    // SoulRegistry owns the lifecycle channel — soul-plus.ts wires
    // parentSessionJournal here and OMITS it from SubagentRunnerDeps to
    // avoid double-writes.
    if (this.parentSessionJournal !== undefined) {
      await this.parentSessionJournal.appendSubagentSpawned({
        type: 'subagent_spawned',
        data: {
          agent_id: agentId,
          ...(request.agentName !== undefined ? { agent_name: request.agentName } : {}),
          parent_tool_call_id: request.parentToolCallId,
          ...(request.parentAgentId !== undefined &&
          request.parentAgentId !== '' &&
          request.parentAgentId !== 'agent_main'
            ? { parent_agent_id: request.parentAgentId }
            : {}),
          run_in_background: request.runInBackground ?? false,
        },
      });
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
    //
    // Phase 6 — the lifecycle journal write happens BEFORE destroy() so
    // a downstream replay sees the completed/failed record alongside
    // the spawned record. We queue the destroy through queueMicrotask
    // (preserving the Slice 7 ordering guarantee) only after the
    // journal write resolves.
    const onSettled = async (
      outcome: { ok: true; result: AgentResult } | { ok: false; error: unknown },
    ): Promise<void> => {
      if (this.parentSessionJournal !== undefined) {
        try {
          if (outcome.ok) {
            const summary = outcome.result.result.length > 0
              ? outcome.result.result.substring(0, RESULT_SUMMARY_MAX_LEN)
              : '';
            await this.parentSessionJournal.appendSubagentCompleted({
              type: 'subagent_completed',
              data: {
                agent_id: agentId,
                parent_tool_call_id: request.parentToolCallId,
                result_summary: summary,
                usage: outcome.result.usage,
              },
            });
          } else {
            const errorMessage =
              outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
            await this.parentSessionJournal.appendSubagentFailed({
              type: 'subagent_failed',
              data: {
                agent_id: agentId,
                parent_tool_call_id: request.parentToolCallId,
                error: errorMessage,
              },
            });
          }
        } catch {
          // Never let a journal write failure mask the underlying
          // outcome — the registry's job is to surface the original
          // result/error to the awaiter, not to crash on bookkeeping.
        }
      }
      queueMicrotask(() => {
        this.destroy(soulKey);
      });
    };
    void completion.then(
      (result) => onSettled({ ok: true, result }),
      (error: unknown) => onSettled({ ok: false, error }),
    );

    return {
      agentId,
      parentToolCallId: request.parentToolCallId,
      completion,
    };
  }
}
