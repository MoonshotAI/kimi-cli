/**
 * SoulRegistry — per-session `Map<SoulKey, SoulHandle>` (v2 §5.2.3).
 *
 * Slice 3 scope: only the `main` Soul is created; subagent / team-member
 * extension is Slice 7 (when `SubagentHost.spawn` is filled in).
 *
 * Responsibilities:
 *   - `getOrCreate(key)` — idempotent handle creation. The caller-supplied
 *     factory decides what a handle looks like; the registry only owns the
 *     key → handle table.
 *   - `has(key)` — lookup without side-effects.
 *   - `destroy(key)` — abort the handle's AbortController, then drop the
 *     registry entry. Unknown keys are a silent no-op.
 */

import type { SoulHandle, SoulKey } from './types.js';

export interface SoulRegistryDeps {
  /**
   * Factory invoked on first `getOrCreate(key)`. The registry does not own
   * the handle construction — TurnManager / SoulPlus decide what goes
   * inside a handle.
   */
  readonly createHandle: (key: SoulKey) => SoulHandle;
}

export class SoulRegistry {
  private readonly handles = new Map<SoulKey, SoulHandle>();
  private readonly createHandle: (key: SoulKey) => SoulHandle;

  constructor(deps: SoulRegistryDeps) {
    this.createHandle = deps.createHandle;
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
}
