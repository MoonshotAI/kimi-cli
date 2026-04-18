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
 * Plan-mode cadence (Phase 18 §D.6 — Python parity):
 *   - `reentry` one-shot the turn after `notePlanActivation()` fires
 *     (plan mode just toggled on, remind the LLM of the re-entry flow).
 *   - `full` the first time (no prior reminder in history) or when at
 *     least `PLAN_MODE_FULL_REFRESH_TURNS` assistant turns have passed
 *     since the last reminder (long refresh cadence).
 *   - `sparse` in between — a short "still active" reminder so the LLM
 *     stays anchored on the read-only invariant without re-reading the
 *     whole workflow every turn.
 *   - None below `PLAN_MODE_DEDUP_MIN_TURNS` assistant turns (dedup).
 *
 * Yolo-mode mirrors Python: one reminder per activation; re-entering
 * non-bypass mode resets the one-shot flag.
 *
 * Integration (TurnManager.launchTurn):
 *   1. Build InjectionContext snapshot { planMode, permissionMode, ... }
 *   2. `manager.computeInjections(ctx)` → EphemeralInjection[]
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
  /**
   * Phase 18 §D.6 / §D.7 — resolved plan file path for the active
   * session. When present, the plan-mode full reminder surfaces it so
   * the LLM can target Write/Edit at the correct path without first
   * calling a tool that discloses it. Absent when plan mode is off or
   * the plan slug has not been bound yet.
   */
  readonly planFilePath?: string;
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
  ): EphemeralInjection[] | void;
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
 * Phase 18 §D.6 — reminder cadence constants.
 *
 *   - MIN: below this many assistant turns since the last reminder,
 *     dedup (no re-emit). Protects against double-reminding in the
 *     very next LLM step after one was already stashed.
 *   - FULL: at or above this many assistant turns, upgrade to the
 *     full reminder (the long refresh cadence). Between MIN and FULL
 *     the provider emits the sparse variant so the model stays
 *     anchored on the read-only invariant without re-reading the
 *     whole workflow every turn.
 */
const PLAN_MODE_DEDUP_MIN_TURNS = 2;
const PLAN_MODE_FULL_REFRESH_TURNS = 5;

export type PlanModeVariant = 'full' | 'sparse' | 'reentry';

/**
 * Plan-mode reminder ported from Python `plan_mode.py`. Phase 18 §D.6
 * brings the TS port to variant parity: three variants (`full` /
 * `sparse` / `reentry`) based on a history scan.
 *
 * Variant semantics:
 *   - `reentry`: one-shot after plan mode toggles on. Surfaced by the
 *     host calling `notePlanActivation()` before the next turn; the
 *     provider consumes the flag on the very next `getInjections`.
 *   - `full`: first-ever injection (no plan-mode fingerprint in
 *     history) OR at least `PLAN_MODE_TURN_INTERVAL` assistant turns
 *     have passed since the last reminder (the refresh cadence).
 *   - `sparse`: emitted every turn in between full reminders so the
 *     model stays anchored on the read-only invariant.
 */
export class PlanModeInjectionProvider implements DynamicInjectionProvider {
  readonly id = 'plan_mode' as const;

  private pendingReentry = false;

  /**
   * Phase 18 §D.6 — host-called signal that plan mode has just toggled
   * on (either via `/plan` or an explicit `setPlanMode(true)` call).
   * The next `getInjections` consumes this flag and emits the reentry
   * variant. Subsequent calls fall back to the full/sparse cadence.
   *
   * Arrow property so hosts can destructure it (the test suite does)
   * without losing `this` binding.
   */
  readonly notePlanActivation = (): void => {
    this.pendingReentry = true;
  };

  /**
   * Phase 18 §D.6 — compute the variant for this turn. Protected because
   * the variant decision is implementation detail; tests access it via
   * optional-chained cast (`(provider as { getVariant?: ... }).getVariant?.(ctx)`)
   * or `vi.spyOn(provider, 'getVariant' as any)`. Returns `null` when no
   * injection fires this turn (plan mode off or a too-recent reminder
   * triggers dedup).
   */
  protected getVariant(ctx: InjectionContext): PlanModeVariant | null {
    if (!ctx.planMode) return null;
    if (this.pendingReentry) return 'reentry';

    const history = ctx.history;
    if (history === undefined) {
      return 'full';
    }

    const scan = scanPlanReminderHistory(history);
    if (scan.newUserSinceReminder) return 'full';
    if (!scan.found) return 'full';
    if (scan.assistantTurnsSince >= PLAN_MODE_FULL_REFRESH_TURNS) return 'full';
    if (scan.assistantTurnsSince >= PLAN_MODE_DEDUP_MIN_TURNS) return 'sparse';
    return null;
  }

  getInjections(
    ctx: InjectionContext,
    contextState?: { appendSystemReminder(d: { content: string }): Promise<void> },
  ): EphemeralInjection[] | void {
    if (!ctx.planMode) {
      this.pendingReentry = false;
      return [];
    }

    const planFilePath = ctx.planFilePath;

    // Reentry one-shot takes priority over the history-scan cadence.
    if (this.pendingReentry) {
      this.pendingReentry = false;
      return emit(contextState, reentryReminder(planFilePath));
    }

    const variant = this.getVariant(ctx);
    if (variant === null) return [];
    const content =
      variant === 'full'
        ? fullReminder(planFilePath)
        : variant === 'sparse'
          ? sparseReminder(planFilePath)
          : reentryReminder(planFilePath);
    return emit(contextState, content);
  }
}

function emit(
  contextState: { appendSystemReminder(d: { content: string }): Promise<void> } | undefined,
  content: string,
): EphemeralInjection[] | undefined {
  if (contextState !== undefined) {
    void contextState.appendSystemReminder({ content });
    return undefined;
  }
  return [{ kind: 'system_reminder', content }];
}

// ── Plan-mode reminder variants (Phase 18 §D.6 — Python parity) ──────

/**
 * Phase 18 §D.7 — when the host has resolved the session's plan-file
 * path, append a `Plan file: {path}` footer so the LLM can target
 * Write/Edit at the correct path without first calling a tool that
 * discloses it. Matches Python `_full_reminder` (plan_mode.py).
 */
function withPlanFileFooter(body: string, planFilePath: string | undefined): string {
  if (planFilePath === undefined || planFilePath.length === 0) return body;
  return `${body}\n\nPlan file: ${planFilePath}`;
}

function fullReminder(planFilePath?: string): string {
  const body = [
    'Plan mode is active. You MUST NOT make any edits (with the exception of the current plan file), run non-readonly tools, or otherwise make changes to the system. This supersedes any other instructions you have received.',
    '',
    'Workflow:',
    '  1. Understand — explore the codebase with Glob, Grep, Read.',
    '  2. Design — converge on the best approach; consider trade-offs but aim for a single recommendation.',
    '  3. Review — re-read key files to verify understanding.',
    '  4. Write Plan — modify the plan file with Write or Edit. Use Write if the plan file does not exist yet.',
    '  5. Exit — call ExitPlanMode for user approval.',
    '',
    '## Handling multiple approaches',
    'Keep it focused: at most 2-3 meaningfully different approaches. Do NOT pad with minor variations — if one approach is clearly superior, just propose that one.',
    "When the best approach depends on user preferences, constraints, or context you don't have, use AskUserQuestion to clarify first. This helps you write a better, more targeted plan rather than dumping multiple options for the user to sort through.",
    'When you do include multiple approaches in the plan, you MUST pass them as the `options` parameter when calling ExitPlanMode, so the user can select which approach to execute at approval time.',
    'NEVER write multiple approaches in the plan and call ExitPlanMode without the `options` parameter — the user will only see Approve/Reject with no way to choose.',
    '',
    'AskUserQuestion is for clarifying missing requirements or user preferences that affect the plan.',
    'Never ask about plan approval via text or AskUserQuestion.',
    'Your turn must end with either AskUserQuestion (to clarify requirements or preferences) or ExitPlanMode (to request plan approval). Do NOT end your turn any other way.',
    'Do NOT use AskUserQuestion to ask about plan approval or reference "the plan" — the user cannot see the plan until you call ExitPlanMode.',
  ].join('\n');
  return withPlanFileFooter(body, planFilePath);
}

function sparseReminder(planFilePath?: string): string {
  const body = [
    'Plan mode still active (see full instructions earlier).',
    'Read-only except the current plan file.',
    'Use Write or Edit to modify the plan file. If it does not exist yet, create it with Write first.',
    'Use AskUserQuestion to clarify user preferences when it helps you write a better plan.',
    'If the plan has multiple approaches, pass options to ExitPlanMode so the user can choose.',
    'End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for approval).',
    'Never ask about plan approval via text or AskUserQuestion.',
  ].join(' ');
  return withPlanFileFooter(body, planFilePath);
}

function reentryReminder(planFilePath?: string): string {
  const body = [
    'Plan mode is active. You MUST NOT make any edits (with the exception of the current plan file), run non-readonly tools, or otherwise make changes to the system. This supersedes any other instructions you have received.',
    '',
    '## Re-entering Plan Mode',
    'A plan file from a previous planning session already exists.',
    'Before proceeding:',
    '  1. Read the existing plan file to understand what was previously planned.',
    "  2. Evaluate the user's current request against that plan.",
    '  3. If different task: replace the old plan with a fresh one. If same task: update the existing plan.',
    '  4. You may use Write or Edit to modify the plan file. If the file does not exist yet, create it with Write first.',
    '  5. Use AskUserQuestion to clarify missing requirements or user preferences that affect the plan.',
    '  6. Always edit the plan file before calling ExitPlanMode.',
    '',
    'Your turn must end with either AskUserQuestion (to clarify requirements) or ExitPlanMode (to request plan approval).',
  ].join('\n');
  return withPlanFileFooter(body, planFilePath);
}

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
  ): EphemeralInjection[] | void {
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
/**
 * Scan history backwards and classify the plan-mode dedup state.
 *
 * The scan stops at the first `user` message it encounters going
 * backwards:
 *   - If that user message is a plan-mode reminder → returns
 *     `{found:true, newUserSinceReminder:false, assistantTurnsSince}`.
 *     The caller decides dedup vs sparse vs full by consulting the
 *     assistant-turn counter.
 *   - If that user message is a real user prompt (not a reminder) →
 *     returns `{found:false, newUserSinceReminder:true, …}`. The caller
 *     treats this as a fresh turn and emits the full reminder.
 *   - If no user message exists at all → returns
 *     `{found:false, newUserSinceReminder:false, …}`. First-time
 *     injection.
 *
 * Only counts ASSISTANT messages between the tail and the reminder.
 * Non-reminder user messages never appear inside that window because
 * the scan stops at them.
 */
function scanPlanReminderHistory(
  history: readonly HistoryMessage[],
): { found: boolean; newUserSinceReminder: boolean; assistantTurnsSince: number } {
  let assistantTurnsSince = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg === undefined) continue;
    if (msg.role === 'assistant') {
      assistantTurnsSince += 1;
      continue;
    }
    if (msg.role === 'user') {
      if (isPlanReminderMessage(msg)) {
        return { found: true, newUserSinceReminder: false, assistantTurnsSince };
      }
      // Real user message reached before any reminder → fresh turn.
      return { found: false, newUserSinceReminder: true, assistantTurnsSince };
    }
  }
  return { found: false, newUserSinceReminder: false, assistantTurnsSince };
}

function isPlanReminderMessage(msg: HistoryMessage): boolean {
  const text = historyMessageText(msg);
  if (!text.trimStart().startsWith('<system-reminder>')) return false;
  return (
    text.includes('Plan mode is active')
    || text.includes('Plan mode still active')
    || text.includes('Re-entering Plan Mode')
  );
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
    const msg = history[i];
    if (msg === undefined) continue;
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
