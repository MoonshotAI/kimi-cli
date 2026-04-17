/**
 * AskUserQuestionTool — structured user question tool (§9-F).
 *
 * Mirrors Python `kimi_cli/tools/ask_user/__init__.py`. The LLM calls
 * this tool when it needs structured input from the user (multiple-
 * choice, preference selection, disambiguation). The tool delegates to
 * a host-injected `QuestionRuntime` which handles the actual UI
 * interaction.
 *
 * Behaviour by permission mode:
 *   - `bypassPermissions` — immediately returns a "skipped" response
 *     so the LLM can proceed autonomously (Python parity: yolo mode).
 *   - all other modes — dispatches through `QuestionRuntime.askQuestion`
 *     and awaits the user's answer.
 */

import { z } from 'zod';

import type { PermissionMode } from '../soul-plus/permission/types.js';
import type { ToolResult, ToolUpdate, ToolMetadata } from '../soul/types.js';
import type { QuestionRuntime } from './question-runtime.js';

// ── Input schema (matches Python Params) ─────────────────────────────

const QuestionOptionSchema = z.object({
  label: z.string().describe('Concise display text (1-5 words).'),
  description: z.string().default('').describe('Brief explanation of trade-offs or implications.'),
});

const QuestionItemSchema = z.object({
  question: z.string().describe("A specific, actionable question. End with '?'."),
  header: z
    .string()
    .default('')
    .describe("Short category tag (max 12 chars, e.g. 'Auth', 'Style')."),
  options: z
    .array(QuestionOptionSchema)
    .min(2)
    .max(4)
    .describe('2-4 meaningful, distinct options.'),
  multi_select: z
    .boolean()
    .default(false)
    .describe('Whether the user can select multiple options.'),
});

export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multi_select: boolean;
  }>;
}

export const AskUserQuestionInputSchema: z.ZodType<AskUserQuestionInput> = z.object({
  questions: z
    .array(QuestionItemSchema)
    .min(1)
    .max(4)
    .describe('The questions to ask the user (1-4 questions).'),
});

// ── Tool description ─────────────────────────────────────────────────

const DESCRIPTION = `Use this tool when you need to ask the user questions with structured options during execution. This allows you to:
1. Collect user preferences or requirements before proceeding
2. Resolve ambiguous or underspecified instructions
3. Let the user decide between implementation approaches as you work
4. Present concrete options when multiple valid directions exist

**When NOT to use:**
- When you can infer the answer from context — be decisive and proceed
- Trivial decisions that don't materially affect the outcome

Overusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.

**Usage notes:**
- Users always have an "Other" option for custom input — don't create one yourself
- Use multi_select to allow multiple answers to be selected for a question
- Keep option labels concise (1-5 words), use descriptions for trade-offs and details
- Each question should have 2-4 meaningful, distinct options
- You can ask 1-4 questions at a time; group related questions to minimize interruptions
- If you recommend a specific option, list it first and append "(Recommended)" to its label`;

// ── Implementation ───────────────────────────────────────────────────

export class AskUserQuestionTool {
  readonly name = 'AskUserQuestion' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description: string = DESCRIPTION;
  readonly inputSchema: z.ZodType<AskUserQuestionInput> = AskUserQuestionInputSchema;

  constructor(
    private readonly questionRuntime: QuestionRuntime,
    private readonly getPermissionMode: () => PermissionMode,
  ) {}

  getActivityDescription(_args: AskUserQuestionInput): string {
    return 'Asking user a question';
  }

  async execute(
    toolCallId: string,
    args: AskUserQuestionInput,
    signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult> {
    // yolo / bypassPermissions — auto-dismiss (Python parity)
    if (this.getPermissionMode() === 'bypassPermissions') {
      return {
        isError: false,
        content:
          '{"answers": {}, "note": "Running in non-interactive (yolo) mode. Make your own decision."}',
      };
    }

    try {
      const result = await this.questionRuntime.askQuestion({
        toolCallId,
        questions: args.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({
            label: o.label,
            description: o.description,
          })),
          multiSelect: q.multi_select,
        })),
        signal,
      });

      if (!result.answer) {
        return {
          isError: false,
          content: '{"answers": {}, "note": "User dismissed the question without answering."}',
        };
      }

      return {
        isError: false,
        content: result.answer,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get user response.';
      return {
        isError: true,
        content: message,
      };
    }
  }
}
