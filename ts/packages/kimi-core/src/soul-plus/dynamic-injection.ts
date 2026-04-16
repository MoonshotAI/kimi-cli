/**
 * DynamicInjectionManager — conditional prompt injection system (Slice 3.6).
 *
 * Ports Python `kimi_cli/soul/dynamic_injection.py` +
 * `kimi_cli/soul/dynamic_injections/{plan_mode,yolo_mode}.py`. The manager
 * holds a list of {@link DynamicInjectionProvider}s, each of which may emit
 * zero or more {@link EphemeralInjection}s per turn based on runtime
 * context. Results are stashed into `ContextState.pendingEphemeralInjections`
 * by TurnManager so the next `buildMessages()` call surfaces them to the
 * LLM as `<system-reminder>` XML blocks (the same rendering path already
 * used by NotificationManager in Slice 2.4).
 *
 * Key differences from Python:
 *   - TS simplifies Python's turn-counting throttle on plan-mode. The TS
 *     port injects a single concise reminder every turn while plan mode
 *     is active, eschewing the `full` / `sparse` / `reentry` variants
 *     (simpler; cost delta is marginal because the reminder is short).
 *   - Yolo-mode mirrors Python: one reminder per activation; re-entering
 *     non-bypass mode resets the one-shot flag.
 *
 * Integration (TurnManager.launchTurn):
 *   1. Build InjectionContext snapshot { planMode, permissionMode, ... }
 *   2. `manager.computeInjections(ctx)` → readonly EphemeralInjection[]
 *   3. Stash each entry via `contextState.stashEphemeralInjection`
 *   4. Continue with drainPendingNotificationsIntoContext
 *
 * This happens *before* Soul's first `buildMessages()` call so the
 * reminders land in the same outbound LLM step.
 */

import type { EphemeralInjection } from '../storage/projector.js';
import type { PermissionMode } from './permission/types.js';

// ── Injection context ─────────────────────────────────────────────────

/**
 * Per-turn runtime snapshot passed to every provider. TurnManager builds
 * this at `launchTurn` time. Providers treat the context as read-only.
 */
export interface InjectionContext {
  readonly planMode: boolean;
  readonly permissionMode: PermissionMode;
  /**
   * Monotonic 1-based turn counter. Providers that need throttling read
   * this value (plan-mode in the Python port used it to back off the
   * reminder every N turns — the TS port keeps the field for forward
   * compatibility even though the default provider does not consult it).
   */
  readonly turnNumber: number;
  /**
   * Phase 1 (Decision #89) — current conversation history for dedup
   * scanning. Providers can scan this to avoid re-injecting a reminder
   * that is already present in the history with no new user message
   * since. Optional for backward compat.
   */
  readonly history?: readonly { role: string; content: readonly { type: string; text?: string }[]; toolCalls: readonly unknown[] }[];
}

// ── Provider interface ────────────────────────────────────────────────

/**
 * Dynamic injection provider. Each provider owns its own throttling /
 * one-shot state. `getInjections` is invoked exactly once per turn.
 *
 * Providers must NOT mutate the context and must NOT throw — the
 * manager's `computeInjections` wraps each provider in a try/catch so a
 * single faulty provider cannot brick the turn, but well-behaved
 * providers should keep failures internal (matches Slice 3 SessionEventBus
 * isolation invariant).
 */
export interface DynamicInjectionProvider {
  readonly id: string;
  getInjections(
    ctx: InjectionContext,
    contextState?: { appendSystemReminder(d: { content: string }): Promise<void> },
  ): readonly EphemeralInjection[] | void;
}

// ── Manager ───────────────────────────────────────────────────────────

export interface DynamicInjectionManagerDeps {
  readonly initialProviders?: readonly DynamicInjectionProvider[];
  /**
   * Optional error callback invoked when a provider throws. Mirrors the
   * HookEngine `onExecutorError` surface so hosts can log misbehaving
   * providers without coupling to a specific logger.
   */
  readonly onProviderError?:
    | ((provider: DynamicInjectionProvider, error: Error) => void)
    | undefined;
}

export class DynamicInjectionManager {
  private readonly providers: DynamicInjectionProvider[] = [];
  private readonly onProviderError?:
    | ((provider: DynamicInjectionProvider, error: Error) => void)
    | undefined;

  constructor(deps: DynamicInjectionManagerDeps = {}) {
    if (deps.initialProviders !== undefined) {
      for (const provider of deps.initialProviders) {
        this.register(provider);
      }
    }
    this.onProviderError = deps.onProviderError;
  }

  /**
   * Register a provider. Registration is idempotent on `id`: a second
   * register with the same id replaces the previous entry in place.
   * This keeps host-side re-initialisation (e.g. SessionManager resume)
   * from double-injecting a built-in reminder.
   */
  register(provider: DynamicInjectionProvider): void {
    const existing = this.providers.findIndex((p) => p.id === provider.id);
    if (existing === -1) {
      this.providers.push(provider);
      return;
    }
    this.providers[existing] = provider;
  }

  unregister(id: string): void {
    const idx = this.providers.findIndex((p) => p.id === id);
    if (idx !== -1) this.providers.splice(idx, 1);
  }

  /** Read-only view of registered providers. Primarily for tests. */
  list(): readonly DynamicInjectionProvider[] {
    return this.providers;
  }

  /**
   * Collect every active injection for the upcoming LLM step. Providers
   * are iterated in registration order; a provider that throws is
   * isolated (error forwarded to `onProviderError`, remaining providers
   * still run). Same error-isolation pattern as HookEngine / SessionEventBus.
   */
  computeInjections(
    ctx: InjectionContext,
    contextState?: { appendSystemReminder(d: { content: string }): Promise<void> },
  ): EphemeralInjection[] {
    const out: EphemeralInjection[] = [];
    for (const provider of this.providers) {
      try {
        const injections = provider.getInjections(ctx, contextState);
        if (injections !== undefined && injections !== null && Array.isArray(injections) && injections.length > 0) {
          out.push(...injections);
        }
      } catch (error) {
        this.onProviderError?.(provider, error instanceof Error ? error : new Error(String(error)));
      }
    }
    return out;
  }
}

// ── Built-in: plan mode provider ──────────────────────────────────────

/**
 * Plan-mode reminder ported from Python `plan_mode.py`.
 *
 * Simplification vs Python:
 *   - No "full/sparse/reentry" variants — we emit the concise reminder
 *     every turn while plan mode is active.
 *   - No plan-file existence check — plan-file lifecycle is host-side
 *     (Slice 3.6 ships the tool, not the plan-file manager).
 */
export class PlanModeInjectionProvider implements DynamicInjectionProvider {
  readonly id = 'plan_mode' as const;

  getInjections(
    ctx: InjectionContext,
    contextState?: { appendSystemReminder(d: { content: string }): Promise<void> },
  ): readonly EphemeralInjection[] | void {
    if (!ctx.planMode) return [];

    // Phase 1 dedup: scan history to avoid re-injecting if the plan mode
    // reminder is already the most recent system_reminder with no new
    // user message since. Ported from Python plan_mode.py:64-81.
    if (ctx.history !== undefined && hasPlanReminderWithoutNewUser(ctx.history)) {
      return [];
    }

    // Phase 1: when contextState is provided, write durably and return void
    if (contextState !== undefined) {
      void contextState.appendSystemReminder({ content: PLAN_MODE_REMINDER });
      return undefined;
    }

    return [
      {
        kind: 'system_reminder',
        content: PLAN_MODE_REMINDER,
      },
    ];
  }
}

const PLAN_MODE_REMINDER = [
  'Plan mode is active. You MUST NOT make any edits, run non-readonly tools, or otherwise change the system. This supersedes any other instructions.',
  '',
  'In plan mode you should:',
  "  1. Understand the user's request by reading files and exploring the codebase.",
  '  2. Design a plan — list the concrete steps, files to change, and any open questions.',
  '  3. When the plan is ready, call ExitPlanMode to present it to the user and exit plan mode.',
  '',
  'You may use read-only tools freely (Read / Grep / Glob / etc.). Do NOT use Edit / Write / Bash (non-readonly) while plan mode is active. End your turn with AskUserQuestion or ExitPlanMode — never end with a bare assistant message.',
].join('\n');

// ── Built-in: yolo mode provider ──────────────────────────────────────

/**
 * Yolo-mode reminder ported from Python `yolo_mode.py`. One-shot per
 * activation: the first turn after `permissionMode` flips to
 * `bypassPermissions` emits the reminder; subsequent turns stay quiet
 * until the mode flips back to something non-bypass (at which point the
 * one-shot resets so re-entering yolo produces a fresh reminder).
 */
export class YoloModeInjectionProvider implements DynamicInjectionProvider {
  readonly id = 'yolo_mode' as const;
  private injected = false;

  getInjections(
    ctx: InjectionContext,
    contextState?: { appendSystemReminder(d: { content: string }): Promise<void> },
  ): readonly EphemeralInjection[] | void {
    if (ctx.permissionMode !== 'bypassPermissions') {
      // Reset one-shot so re-entering yolo produces a fresh reminder.
      this.injected = false;
      return [];
    }

    // Phase 1 dedup: scan history to avoid re-injecting if the yolo
    // reminder is already the most recent system_reminder with no new
    // user message since.
    if (ctx.history !== undefined && hasYoloReminderWithoutNewUser(ctx.history)) {
      return [];
    }

    if (this.injected) return [];
    this.injected = true;

    // Phase 1: when contextState is provided, write durably and return void
    if (contextState !== undefined) {
      void contextState.appendSystemReminder({ content: YOLO_MODE_REMINDER });
      return undefined;
    }

    return [
      {
        kind: 'system_reminder',
        content: YOLO_MODE_REMINDER,
      },
    ];
  }
}

const YOLO_MODE_REMINDER = [
  'You are running in non-interactive (yolo) mode. The user cannot answer questions or provide feedback during execution.',
  '  - Do NOT call AskUserQuestion. If you need to make a decision, make your best judgment and proceed.',
  '  - For ExitPlanMode, it will be auto-approved. You can use it normally but expect no user feedback.',
].join('\n');

// ── History-scanning dedup helpers (Phase 1 — Decision #89) ──────────

type HistoryMessage = { role: string; content: readonly { type: string; text?: string }[]; toolCalls: readonly unknown[] };

/**
 * Extract the text content from a history message.
 */
function historyMessageText(msg: HistoryMessage): string {
  return msg.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

/**
 * Scan history backwards for the most recent `<system-reminder>` that
 * contains the plan mode fingerprint. If found and no new user message
 * has appeared since, return true (dedup hit).
 */
function hasPlanReminderWithoutNewUser(history: readonly HistoryMessage[]): boolean {
  return hasReminderWithoutNewUser(history, 'Plan mode is active');
}

/**
 * Same as above but for yolo mode reminder.
 */
function hasYoloReminderWithoutNewUser(history: readonly HistoryMessage[]): boolean {
  return hasReminderWithoutNewUser(history, 'yolo');
}

function hasReminderWithoutNewUser(history: readonly HistoryMessage[], fingerprint: string): boolean {
  // Scan from the end, looking for the most recent system-reminder
  // containing the fingerprint. Track whether a user message appeared
  // after it.
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    const text = historyMessageText(msg);
    if (msg.role === 'user' && text.trimStart().startsWith('<system-reminder>') && text.toLowerCase().includes(fingerprint.toLowerCase())) {
      // Found the reminder — no new user message since (we scanned
      // backwards and haven't encountered a non-reminder user message)
      return true;
    }
    if (msg.role === 'user' && !text.trimStart().startsWith('<system-reminder>') && !text.trimStart().startsWith('<notification')) {
      // A real user message appeared more recently than any reminder —
      // the dedup check fails, we should re-inject.
      return false;
    }
    // assistant / tool messages don't affect the dedup decision
  }
  return false;
}

// ── Default factory ───────────────────────────────────────────────────

/**
 * Build a DynamicInjectionManager pre-populated with the two Phase 3
 * built-in providers (plan-mode + yolo-mode). Hosts that want additional
 * providers can `register` them after construction.
 */
export function createDefaultDynamicInjectionManager(
  deps: Omit<DynamicInjectionManagerDeps, 'initialProviders'> = {},
): DynamicInjectionManager {
  return new DynamicInjectionManager({
    ...deps,
    initialProviders: [new PlanModeInjectionProvider(), new YoloModeInjectionProvider()],
  });
}
