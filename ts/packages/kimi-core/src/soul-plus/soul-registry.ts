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
 *   - `spawn(request)` — SubagentHost: creates `sub:<id>` entry, returns SubagentHandle
 */

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
    | ((request: SpawnRequest, signal: AbortSignal) => Promise<AgentResult>)
    | undefined;
}

export class SoulRegistry implements SubagentHost {
  private readonly handles = new Map<SoulKey, SoulHandle>();
  private readonly createHandle: (key: SoulKey) => SoulHandle;
  private readonly runSubagentTurnFn:
    | ((request: SpawnRequest, signal: AbortSignal) => Promise<AgentResult>)
    | undefined;
  private subagentSeq = 0;

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
    this.subagentSeq += 1;
    const agentId = `sub_${this.subagentSeq}`;
    const soulKey: SoulKey = `sub:${agentId}`;

    const soulHandle = this.getOrCreate(soulKey);

    const completion: Promise<AgentResult> = this.runSubagentTurnFn
      ? this.runSubagentTurnFn(request, soulHandle.abortController.signal)
      : Promise.resolve({ result: '', usage: { input: 0, output: 0 } });

    return { agentId, completion };
  }
}
