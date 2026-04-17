/**
 * EnterPlanModeTool — plan-mode entry tool (Slice 5.4).
 *
 * Python parity: `kimi_cli/tools/plan/enter.py`
 *
 * The LLM calls this tool to request entering plan mode. In interactive
 * mode, a Yes/No question dialog is shown to the user. In yolo mode,
 * plan mode is auto-approved without user interaction.
 *
 * Mirrors ExitPlanModeTool's dependency injection pattern: the host
 * provides callbacks for plan-mode state queries and mutations.
 */

import { z } from 'zod';

import type { ToolResult, ToolUpdate, ToolMetadata } from '../soul/types.js';
import type { BuiltinTool } from './types.js';
import type { QuestionRuntime } from './question-runtime.js';

// ── Input schema ─────────────────────────────────────────────────────

export interface EnterPlanModeInput {
  /** Optional reason for entering plan mode (shown to user in dialog). */
  reason?: string | undefined;
}

export const EnterPlanModeInputSchema: z.ZodType<EnterPlanModeInput> = z.object({
  reason: z
    .string()
    .optional()
    .describe('Optional reason for entering plan mode, shown to the user.'),
});

// ── Tool description ─────────────────────────────────────────────────

const DESCRIPTION = `Request to enter plan mode. In plan mode, you investigate the request and design a plan before making any changes.

**When to use:**
- Before tackling complex, multi-step tasks that benefit from upfront planning.
- When the user explicitly asks you to plan first.

**What happens:**
- In interactive mode: the user is asked to confirm entering plan mode.
- In non-interactive (yolo) mode: plan mode is entered automatically.
- Once in plan mode, you should only use read-only tools until you call ExitPlanMode with the finished plan.`;

// ── Callback surface ─────────────────────────────────────────────────

export interface EnterPlanModeDeps {
  /** Returns `true` if plan mode is currently active. */
  readonly isPlanModeActive: () => boolean;
  /** Flip plan mode on/off. */
  readonly setPlanMode: (enabled: boolean) => Promise<void>;
  /** Returns `true` if running in yolo (non-interactive) mode. */
  readonly isYoloMode: () => boolean;
  /** QuestionRuntime for interactive user dialogs. */
  readonly questionRuntime: QuestionRuntime;
}

// ── Implementation ───────────────────────────────────────────────────

export class EnterPlanModeTool implements BuiltinTool<EnterPlanModeInput, void> {
  readonly name = 'EnterPlanMode' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description: string = DESCRIPTION;
  readonly inputSchema: z.ZodType<EnterPlanModeInput> = EnterPlanModeInputSchema;

  constructor(private readonly deps: EnterPlanModeDeps) {}

  getActivityDescription(_args: EnterPlanModeInput): string {
    return 'Requesting to enter plan mode';
  }

  async execute(
    toolCallId: string,
    args: EnterPlanModeInput,
    signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<void>> {
    // Guard: already in plan mode
    if (this.deps.isPlanModeActive()) {
      return {
        isError: true,
        content: 'Plan mode is already active. Use ExitPlanMode when the plan is ready.',
      };
    }

    // Yolo mode: auto-approve without user interaction (Python parity)
    if (this.deps.isYoloMode()) {
      try {
        await this.deps.setPlanMode(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to enter plan mode.';
        return { isError: true, content: `Failed to enter plan mode: ${message}` };
      }
      return { content: ENTERED_PLAN_MODE_MESSAGE };
    }

    // Interactive mode: ask user via QuestionRuntime (Python parity)
    const reasonSuffix = args.reason ? `\n\nReason: ${args.reason}` : '';
    const result = await this.deps.questionRuntime.askQuestion({
      toolCallId,
      questions: [
        {
          header: 'Plan Mode',
          question: `Enter plan mode? In plan mode I'll investigate and design a plan before making changes.${reasonSuffix}`,
          options: [
            { label: 'Yes', description: 'Enter plan mode' },
            { label: 'No', description: 'Proceed without planning' },
          ],
        },
      ],
      signal,
    });

    // Parse answer: TUIQuestionRuntime returns JSON like
    // {"answers":{"<question>":"<label>"}}, while test mocks may return
    // plain strings. Handle both formats (Python parity: enter.py:152
    // uses exact label matching, not substring).
    if (!parseApproval(result.answer)) {
      return {
        content:
          'Plan mode declined by user. Proceed directly with the task — read files, make changes, and iterate as needed.',
      };
    }

    // User approved: toggle plan mode
    try {
      await this.deps.setPlanMode(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to enter plan mode.';
      return { isError: true, content: `Failed to enter plan mode: ${message}` };
    }

    return { content: ENTERED_PLAN_MODE_MESSAGE };
  }
}

/**
 * Parse the QuestionResult answer to determine if user approved.
 *
 * TUIQuestionRuntime returns JSON: `{"answers":{"<question>":"<label>"}}`.
 * Test mocks may return plain strings like "Yes" or "No".
 * Python parity: `enter.py:152` uses `any(v == "Yes" for v in answers.values())`.
 */
function parseApproval(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;

  // Try JSON format first (real wire runtime)
  try {
    const parsed = JSON.parse(trimmed) as { answers?: Record<string, string> };
    if (parsed.answers !== undefined) {
      return Object.values(parsed.answers).some((v) => v === 'Yes');
    }
  } catch {
    // Not JSON — fall through to plain string check
  }

  // Plain string fallback (test mocks, simple runtimes)
  const lower = trimmed.toLowerCase();
  return lower !== 'no' && !lower.startsWith('no');
}

const ENTERED_PLAN_MODE_MESSAGE = [
  'Plan mode is now active. Your workflow:',
  '',
  '1. Use read-only tools (Read, Grep, Glob) to investigate the codebase.',
  '2. Design a concrete, step-by-step plan.',
  '3. When the plan is ready, call ExitPlanMode with the full plan text.',
  '',
  'Do NOT use Edit, Write, or Bash (non-readonly) while plan mode is active.',
].join('\n');
