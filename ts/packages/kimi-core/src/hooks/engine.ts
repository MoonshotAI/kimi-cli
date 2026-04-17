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
 *
 * Matcher semantics (Slice 4 audit M4, ports Python `hooks/engine.py:196-230`):
 *   - `matcher` is a regex applied to the tool name (or "" for non-tool events)
 *   - absent / empty `matcher` → match-all
 *   - invalid regex → fail-open, matches everything, with a log-only warning
 *     (v2 §9-C requires hooks never to brick a turn)
 */

import type { EventSink } from '../soul/event-sink.js';
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
  readonly onInvalidMatcher?: ((hook: HookConfig, matcher: string) => void) | undefined;
  /**
   * Phase 17 §B.7 — Optional SoulEvent sink for `hook.triggered` /
   * `hook.resolved` lifecycle observability. When provided, the engine
   * emits one `hook.triggered` per matcher dispatch + one `hook.resolved`
   * per settled hook. Optional so test fixtures that don't care about
   * wire-side observability need not wire a sink.
   */
  readonly sink?: EventSink | undefined;
}

/**
 * Synthesises a stable id for `hook.resolved` emissions. Hooks are
 * registered without an intrinsic id; we derive one from
 * `event:type:matcher`, suffixed with the hook's position inside
 * `this.hooks` (its registration order). The `registrationIndex` is
 * stable across multiple `executeHooks` calls — using the per-call
 * `settled[]` index instead would hand the same id to different hooks
 * across different dispatches, breaking client-side correlation.
 */
function hookId(hook: HookConfig, registrationIndex: number): string {
  return `${hook.event}:${hook.type}:${hook.matcher ?? ''}:${registrationIndex}`;
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

  /**
   * Pre-filters hooks by both `event` and `matcher` regex against the
   * target value (tool name for tool-scoped events). Exported-ish via
   * `executeHooks` — v2 §9-C.3 requires "getMatchingHooks(event, input)
   * then concurrent execute" ordering.
   */
  getMatchingHooks(event: HookEventType, input: HookInput): HookConfig[] {
    const matcherValue = extractMatcherValue(input);
    return this.hooks.filter((h) => {
      if (h.event !== event) return false;
      return this.matchesTarget(h, matcherValue);
    });
  }

  private matchesTarget(hook: HookConfig, value: string): boolean {
    const matcher = hook.matcher;
    if (matcher === undefined || matcher === '') return true;
    let re: RegExp;
    try {
      re = new RegExp(matcher);
    } catch {
      // Invalid regex: fail-open (match-all). Notify caller via the
      // optional observability callback so mis-configured hooks are
      // visible, but never brick the turn. (Task spec deviates from
      // Python here — Python treats invalid regex as no-match.)
      this.deps.onInvalidMatcher?.(hook, matcher);
      return true;
    }
    return re.test(value);
  }

  async executeHooks(
    event: HookEventType,
    input: HookInput,
    signal: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const matching = this.getMatchingHooks(event, input);
    if (matching.length === 0) {
      // Still emit `hook.triggered` with matched_count=0 so wire-side
      // observability can see that the event was considered. Keeps the
      // protocol symmetric — clients get one trigger record per hook
      // dispatch regardless of match count.
      this.deps.sink?.emit({
        type: 'hook.triggered',
        event,
        matchers: [],
        matched_count: 0,
      });
      return { blockAction: false, additionalContext: [] };
    }

    this.deps.sink?.emit({
      type: 'hook.triggered',
      event,
      matchers: matching.map((h) => h.matcher ?? ''),
      matched_count: matching.length,
    });

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
      const hook = matching[i];
      // Registration index — stable across executeHooks calls (unlike
      // `i`, which is reset per dispatch). Hand this to `hookId` so
      // `hook.resolved` frames correlate across retries and re-entries.
      const registrationIndex = hook !== undefined ? this.hooks.indexOf(hook) : -1;
      if (result.status === 'rejected') {
        if (hook !== undefined) {
          this.deps.onExecutorError?.(
            hook,
            result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
          );
          this.deps.sink?.emit({
            type: 'hook.resolved',
            hook_id: hookId(hook, registrationIndex),
            outcome: 'error',
          });
        }
        continue;
      }
      const value = result.value;
      if (hook !== undefined) {
        // Order matters: executor-reported failure (`ok === false`)
        // outranks the `blockAction` flag because a failed executor's
        // `blockAction` is not trustworthy. rejected / ok=false / blocked
        // map onto `error` / `error` / `blocked` respectively; successful
        // non-blocking falls through to `ok`.
        const outcome: 'ok' | 'blocked' | 'error' =
          value?.ok === false
            ? 'error'
            : value?.blockAction === true
              ? 'blocked'
              : 'ok';
        this.deps.sink?.emit({
          type: 'hook.resolved',
          hook_id: hookId(hook, registrationIndex),
          outcome,
        });
      }
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

// ── Matcher value extraction ─────────────────────────────────────────────

/**
 * Extracts the string fed to a hook's matcher regex. Event-dependent:
 *
 *   - `PreToolUse` / `PostToolUse` / `OnToolFailure` — tool name
 *     (mirrors Python's `matcher_value=toolCall.name` contract).
 *   - `UserPromptSubmit` — the prompt text itself (Python parity).
 *   - `Stop` — the turn reason (`done` / `cancelled` / `error`), so
 *     hooks can filter e.g. `/^error$/`.
 *   - `Notification` — the notification type string, so a single hook
 *     can subscribe to an entire notification class via regex.
 */
function extractMatcherValue(input: HookInput): string {
  switch (input.event) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'OnToolFailure': {
      return input.toolCall.name;
    }
    case 'UserPromptSubmit': {
      return input.prompt;
    }
    case 'Stop': {
      return input.reason;
    }
    case 'Notification': {
      return input.notificationType;
    }
    case 'StopFailure': {
      return input.error;
    }
    case 'SubagentStart':
    case 'SubagentStop': {
      return input.agentName;
    }
    case 'SessionStart':
    case 'SessionEnd':
    case 'PreCompact':
    case 'PostCompact': {
      return '';
    }
  }
}
