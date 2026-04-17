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

export interface ExitPlanModeInput {
  plan: string;
}

export const ExitPlanModeInputSchema: z.ZodType<ExitPlanModeInput> = z.object({
  plan: z
    .string()
    .min(1)
    .describe('The finalised plan to present to the user. Markdown is rendered in the UI.'),
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
export interface ExitPlanModeDeps {
  /** Returns `true` if plan mode is currently active. */
  readonly isPlanModeActive: () => boolean;
  /**
   * Flip plan mode off. Called only after `isPlanModeActive()` returned
   * true. Errors propagate as a tool error so the LLM sees the reason.
   */
  readonly setPlanMode: (enabled: boolean) => Promise<void>;
}

// ── Implementation ───────────────────────────────────────────────────

export class ExitPlanModeTool implements BuiltinTool<ExitPlanModeInput, { plan: string }> {
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
  ): Promise<ToolResult<{ plan: string }>> {
    if (!this.deps.isPlanModeActive()) {
      return {
        isError: true,
        content:
          'ExitPlanMode can only be called while plan mode is active. Use EnterPlanMode (or /plan) first.',
      };
    }

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
      content: `Exited plan mode. Plan:\n\n${args.plan}`,
      output: { plan: args.plan },
    };
  }
}
