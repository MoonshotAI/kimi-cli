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
 * Matcher semantics (Slice 4 audit M4, ports Python `hooks/engine.py:196-230`,
 * Phase 18 B.2 alignment):
 *   - `matcher` is a regex applied to the tool name (or "" for non-tool events)
 *   - absent / empty `matcher` → match-all
 *   - invalid regex → fail-CLOSED (no match), with a log-only warning. A
 *     block-action hook with a broken regex must NOT inadvertently block
 *     every tool call. The optional `onInvalidMatcher` hook makes the
 *     misconfig visible without bricking the turn.
 *
 * Wire event emission (Phase 17 B.7, v2 §3.6 + §3.7):
 *   - optional `sink` dependency receives SoulEvent `hook.triggered` at
 *     the start of `executeHooks` and `hook.resolved` per settled hook.
 *     Events are debug-only and MUST NOT be persisted (铁律 W4 —
 *     `hook.triggered` / `hook.resolved` are in the "不落盘" list).
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
  private readonly deps: HookEngineDeps;
  /**
   * Mutable executor registry. Seeded from `deps.executors` at
   * construction so the constructor arg can stay `ReadonlyMap`-typed
   * while `registerExecutor` still lets callers install additional
   * executors (e.g. `WireHookExecutor`) after the engine is wired.
   */
  private readonly executors: Map<string, HookExecutor>;
  private readonly hooks: HookConfig[] = [];
  /**
   * Phase 18 L3-2 — invalid-regex warn dedupe. Each distinct invalid
   * matcher fires `onInvalidMatcher` once per engine instance so a
   * misconfigured block-action hook doesn't flood logs on every
   * tool call.
   */
  private readonly warnedInvalidMatchers = new Set<string>();

  constructor(deps: HookEngineDeps) {
    this.deps = deps;
    this.executors = new Map(deps.executors);
  }

  register(hook: HookConfig): void {
    this.hooks.push(hook);
  }

  /**
   * Phase 18 L2-4 — install / replace an executor for a given `type`
   * label at runtime. Used by the wire layer to bolt a
   * `WireHookExecutor` onto an engine that was constructed with only
   * the `command` executor. Replacing an existing entry is silent;
   * callers wanting a conflict check can probe `hasExecutor(type)`.
   */
  registerExecutor(type: string, executor: HookExecutor): void {
    this.executors.set(type, executor);
  }

  /** Returns true when an executor has been registered under `type`. */
  hasExecutor(type: string): boolean {
    return this.executors.has(type);
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
      // Phase 18 B.2 — invalid regex: fail-CLOSED (no match). A
      // block-action hook with a broken regex must not inadvertently
      // block every tool call. Notify the caller via the optional
      // observability callback so the misconfig is visible in logs;
      // dedupe by matcher pattern so the warning fires at most once
      // per engine instance (L3-2).
      if (!this.warnedInvalidMatchers.has(matcher)) {
        this.warnedInvalidMatchers.add(matcher);
        this.deps.onInvalidMatcher?.(hook, matcher);
      }
      return false;
    }
    return re.test(value);
  }

  async executeHooks(
    event: HookEventType,
    input: HookInput,
    signal: AbortSignal,
  ): Promise<AggregatedHookResult> {
    // Phase 18 B.1 — dedupe by `command` single-field (matches Python
    // `hooks/engine.py::dedup_hooks`, 2026-03-23 commit). Only the
    // executable identity matters; two hooks that resolve to the same
    // `command` string should run exactly once per executeHooks call,
    // even if their matcher / event / type differ. The dedupe is
    // scoped to this call — a second executeHooks re-evaluates from
    // scratch.
    const matched = this.getMatchingHooks(event, input);
    const deduped = dedupeByCommand(matched);
    if (deduped.length === 0) {
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
      matchers: deduped.map((h) => h.matcher ?? ''),
      matched_count: deduped.length,
    });

    const settled = await Promise.allSettled(
      deduped.map((hook) => {
        const executor = this.executors.get(hook.type);
        // oxlint-disable-next-line unicorn/no-useless-undefined
        if (executor === undefined) return Promise.resolve(undefined);
        return executor.execute(hook, input, signal);
      }),
    );

    let blockAction = false;
    let reason: string | undefined;
    const additionalContext: string[] = [];

    for (const [i, result] of settled.entries()) {
      const hook = deduped[i];
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

// ── Dedupe helper (Phase 18 B.1) ────────────────────────────────────────

/**
 * Collapse hook configs that share the same `command` string. `wire` hooks
 * (no `command` field) key on their subscription id so different wire
 * subscriptions still run in parallel; identical subscriptions collapse
 * like identical commands.
 */
function dedupeByCommand(hooks: readonly HookConfig[]): HookConfig[] {
  const seen = new Map<string, HookConfig>();
  for (const hook of hooks) {
    const key = hookDedupeKey(hook);
    if (!seen.has(key)) seen.set(key, hook);
  }
  return [...seen.values()];
}

function hookDedupeKey(hook: HookConfig): string {
  if (hook.type === 'command') return `command:${hook.command}`;
  if (hook.type === 'wire') return `wire:${hook.subscriptionId}`;
  // Exhaustiveness guard — future HookConfig variants must extend the
  // dedupe key so two hooks do not accidentally collapse.
  const exhaustive: never = hook;
  return `unknown:${JSON.stringify(exhaustive)}`;
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
