/**
 * ExitPlanModeTool — plan-mode exit tool (Slice 3.6).
 *
 * Ports Python `kimi_cli/tools/plan/__init__.py`. The LLM calls this
 * tool to surface a finalised plan to the user and exit plan mode. In
 * Phase 3 TS the flow is simplified vs Python:
 *
 *   Python                                      TS Slice 3.6
 *   ─────────────────────────────────────────  ─────────────────────────
 *   1. Verify plan mode is active               Same
 *   2. Read plan file from disk                 (plan text is passed
 *                                                inline via `plan` arg —
 *                                                no plan-file manager
 *                                                yet in TS)
 *   3. QuestionRuntime approval dialog          Deferred to a later slice
 *                                                (TS tool simply calls
 *                                                `setPlanMode(false)` and
 *                                                returns the plan text)
 *   4. Reject-and-exit / revise / approve       Not modelled — TS treats
 *                                                the call as "approve
 *                                                and exit"
 *
 * The simplification is intentional: Slice 3.6 ships the tool surface,
 * not the interactive UX. Hosts that want richer approval semantics can
 * wrap the tool or inject an `onExitPlanMode` callback that throws to
 * simulate a rejection.
 */

import { z } from 'zod';

import type { ToolResult, ToolUpdate, ToolMetadata } from '../soul/types.js';
import type { BuiltinTool } from './types.js';

// ── Input schema ─────────────────────────────────────────────────────

/**
 * Phase 18 §D.3 — user-selectable option surfaced at plan approval time.
 * The LLM supplies up to 3 of these when the plan contains multiple
 * approaches; the host's ApprovalRuntime presents them to the user and
 * returns the chosen `label` (or `{kind:'revise', feedback}` when the
 * user asks for revisions).
 */
export interface ExitPlanModeOption {
  label: string;
  description: string;
}

export interface ExitPlanModeInput {
  plan: string;
  options?: readonly ExitPlanModeOption[] | undefined;
}

export const ExitPlanModeInputSchema: z.ZodType<ExitPlanModeInput> = z.object({
  plan: z
    .string()
    .min(1)
    .describe('The finalised plan to present to the user. Markdown is rendered in the UI.'),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        description: z.string(),
      }),
    )
    .max(3)
    .optional()
    .describe(
      'Up to 3 alternative approaches surfaced to the user at approval time. Include a "Revise" option to keep plan mode active and collect feedback.',
    ),
});

// ── Tool description ─────────────────────────────────────────────────

const DESCRIPTION = `Use this tool when you are in plan mode and are ready to present the completed plan to the user. The tool:

1. Shows the plan to the user.
2. Exits plan mode so you can begin execution on the next turn.

**Usage notes:**
- Only call this tool after you have fully investigated the request and designed a concrete plan.
- Pass the full plan text as \`plan\` — include the steps you intend to take, files you intend to modify, and any open questions.
- Do NOT call this tool to ask clarifying questions (use AskUserQuestion for that). Call ExitPlanMode only when the plan is genuinely final.`;

// ── Callback surface ─────────────────────────────────────────────────

/**
 * Plan-mode gate callback injected by the host. The tool calls this at
 * the end of execute to flip plan mode off. The host is responsible
 * for:
 *   - Persisting the state change (ContextState.applyConfigChange)
 *   - Updating TurnManager's in-memory flag
 *   - Any UI-facing plan display rendering
 */
/**
 * Phase 18 §D.3 — result returned by the host when the user answers a
 * plan-approval dialog (multi-option or plain approve/reject).
 *   - `approved=true` + `chosenLabel` → LLM proceeds with that option.
 *   - `approved=false` + `chosenLabel='Revise'` + `feedback` → LLM
 *     stays in plan mode and revises.
 *   - `approved=false` without `Revise` → plan mode exits with feedback.
 */
export interface ExitPlanModeApprovalResult {
  approved: boolean;
  chosenLabel?: string;
  feedback?: string;
}

export interface ExitPlanModeDeps {
  /** Returns `true` if plan mode is currently active. */
  readonly isPlanModeActive: () => boolean;
  /**
   * Flip plan mode off. Called only after `isPlanModeActive()` returned
   * true. Errors propagate as a tool error so the LLM sees the reason.
   */
  readonly setPlanMode: (enabled: boolean) => Promise<void>;
  /**
   * Phase 18 §D.3 — invoked whenever `args.options` is present. Hosts
   * wire this to an ApprovalRuntime multi-option dialog. The presence
   * of this callback is how the tool distinguishes the options path
   * from the legacy approve-on-call path.
   */
  readonly requestApproval?: (args: ExitPlanModeInput) => Promise<ExitPlanModeApprovalResult>;
}

// ── Output shape (Phase 18 §D.3 / §D.4) ──────────────────────────────

/**
 * Discriminated union of ExitPlanMode outputs. Callers can narrow on
 * `kind` to surface the Revise feedback loop, or check `chosen` for the
 * multi-option selection path. `plan` is echoed on every non-revise
 * outcome so downstream renderers have a single place to pull the
 * approved text from.
 */
export interface ExitPlanModeOutput {
  /** Discriminator set to `'revise'` when the user asked for revisions. */
  kind?: 'revise';
  plan?: string;
  /** Label the user selected when `options` was supplied. */
  chosen?: string;
  /** User-supplied feedback string on revise or plain reject. */
  feedback?: string;
}

// ── Implementation ───────────────────────────────────────────────────

export class ExitPlanModeTool implements BuiltinTool<ExitPlanModeInput, ExitPlanModeOutput> {
  readonly name = 'ExitPlanMode' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description: string = DESCRIPTION;
  readonly inputSchema: z.ZodType<ExitPlanModeInput> = ExitPlanModeInputSchema;

  constructor(private readonly deps: ExitPlanModeDeps) {}

  getActivityDescription(_args: ExitPlanModeInput): string {
    return 'Presenting plan and exiting plan mode';
  }

  async execute(
    _toolCallId: string,
    args: ExitPlanModeInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<ExitPlanModeOutput>> {
    if (!this.deps.isPlanModeActive()) {
      return {
        isError: true,
        content:
          'ExitPlanMode can only be called while plan mode is active. Use EnterPlanMode (or /plan) first.',
      };
    }

    // Phase 18 §D.3 — when `options` are present, route through the
    // ApprovalRuntime callback so the host can show a multi-option
    // dialog (or a plain approve/reject prompt for a single option).
    // When `options` is absent we keep the pre-Phase-18 path: callers
    // that only know the 2-field ExitPlanModeDeps shape must continue
    // to work without wiring `requestApproval`.
    if (args.options !== undefined) {
      if (this.deps.requestApproval === undefined) {
        return {
          isError: true,
          content:
            'ExitPlanMode.options requires a host with requestApproval support. '
            + 'Call ExitPlanMode without options, or wire ExitPlanModeDeps.requestApproval.',
        };
      }
      return this.executeWithApproval(args, this.deps.requestApproval);
    }

    return this.exitWithPlan(args.plan);
  }

  private async executeWithApproval(
    args: ExitPlanModeInput,
    requestApproval: NonNullable<ExitPlanModeDeps['requestApproval']>,
  ): Promise<ToolResult<ExitPlanModeOutput>> {
    let result: ExitPlanModeApprovalResult;
    try {
      result = await requestApproval(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Plan approval failed.';
      return {
        isError: true,
        content: `Plan approval failed: ${message}`,
      };
    }

    // Revise branch: user stayed in plan mode to collect more feedback.
    // Plan mode MUST NOT be toggled off — the LLM keeps its read-only
    // posture and iterates on the plan. Label match is case-insensitive
    // so hosts that normalise button text (e.g. ALL-CAPS UI) still hit
    // the revise path.
    if (!result.approved && result.chosenLabel?.toLowerCase() === 'revise') {
      const feedback = result.feedback ?? '';
      return {
        isError: false,
        content: `User asked to revise the plan. Feedback:\n\n${feedback}`,
        output: { kind: 'revise', feedback },
      };
    }

    // Any other outcome exits plan mode — both approve-with-selection
    // and outright reject-without-Revise are "the plan is settled,
    // stop being read-only" from the LLM's point of view.
    try {
      await this.deps.setPlanMode(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit plan mode.';
      return {
        isError: true,
        content: `Failed to exit plan mode: ${message}`,
      };
    }

    if (result.approved) {
      const chosen = result.chosenLabel ?? '';
      return {
        isError: false,
        content: chosen.length > 0
          ? `User approved option "${chosen}". Plan:\n\n${args.plan}`
          : `Exited plan mode. Plan:\n\n${args.plan}`,
        output: { plan: args.plan, ...(chosen.length > 0 ? { chosen } : {}) },
      };
    }

    const feedback = result.feedback ?? '';
    return {
      isError: false,
      content: feedback.length > 0
        ? `User rejected the plan. Feedback:\n\n${feedback}`
        : 'User rejected the plan.',
      output: { plan: args.plan, feedback },
    };
  }

  private async exitWithPlan(plan: string): Promise<ToolResult<ExitPlanModeOutput>> {
    try {
      await this.deps.setPlanMode(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit plan mode.';
      return {
        isError: true,
        content: `Failed to exit plan mode: ${message}`,
      };
    }

    return {
      isError: false,
      content: `Exited plan mode. Plan:\n\n${plan}`,
      output: { plan },
    };
  }
}
