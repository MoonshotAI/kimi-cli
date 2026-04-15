/**
 * HookEngine — hook dispatcher (v2 §9-C.3).
 *
 * Manages hook registration, matching, and parallel execution through
 * registered HookExecutors. Aggregation: any `blockAction=true` blocks;
 * `additionalContext` strings accumulate; `updatedInput` is ignored in
 * Phase 1 (PreToolUse cannot modify args).
 *
 * Error isolation: a single executor failure does not affect other hooks
 * (learned from Slice 3 SessionEventBus — listener errors must be isolated).
 */

import type {
  AggregatedHookResult,
  HookConfig,
  HookEventType,
  HookExecutor,
  HookInput,
} from './types.js';

export interface HookEngineDeps {
  readonly executors: ReadonlyMap<string, HookExecutor>;
  readonly onExecutorError?: ((hook: HookConfig, error: Error) => void) | undefined;
}

export class HookEngine {
  constructor(private readonly deps: HookEngineDeps) {}

  private readonly hooks: HookConfig[] = [];

  register(hook: HookConfig): void {
    this.hooks.push(hook);
  }

  unregister(hook: HookConfig): void {
    const idx = this.hooks.indexOf(hook);
    if (idx !== -1) this.hooks.splice(idx, 1);
  }

  list(event?: HookEventType): HookConfig[] {
    if (event === undefined) return [...this.hooks];
    return this.hooks.filter((h) => h.event === event);
  }

  async executeHooks(
    event: HookEventType,
    input: HookInput,
    signal: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const matching = this.hooks.filter((h) => h.event === event);
    if (matching.length === 0) {
      return { blockAction: false, additionalContext: [] };
    }

    const settled = await Promise.allSettled(
      matching.map((hook) => {
        const executor = this.deps.executors.get(hook.type);
        // oxlint-disable-next-line unicorn/no-useless-undefined
        if (executor === undefined) return Promise.resolve(undefined);
        return executor.execute(hook, input, signal);
      }),
    );

    let blockAction = false;
    let reason: string | undefined;
    const additionalContext: string[] = [];

    for (const [i, result] of settled.entries()) {
      if (result.status === 'rejected') {
        const hook = matching[i];
        if (hook !== undefined) {
          this.deps.onExecutorError?.(
            hook,
            result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
          );
        }
        continue;
      }
      const value = result.value;
      if (value === undefined) continue;
      if (value.blockAction) {
        blockAction = true;
        if (value.reason !== undefined) reason = value.reason;
      }
      if (value.additionalContext !== undefined) {
        additionalContext.push(value.additionalContext);
      }
    }

    return { blockAction, reason, additionalContext };
  }
}
