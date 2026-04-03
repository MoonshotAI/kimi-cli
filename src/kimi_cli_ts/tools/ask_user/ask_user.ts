/**
 * AskUserQuestion tool — ask the user structured questions.
 * Corresponds to Python tools/ask_user/__init__.py
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolOk } from "../types.ts";

const DESCRIPTION = `Use this tool when you need to ask the user questions with structured options during execution. This allows you to:
1. Collect user preferences or requirements before proceeding
2. Resolve ambiguous or underspecified instructions
3. Let the user decide between implementation approaches as you work
4. Present concrete options when multiple valid directions exist

**When NOT to use:**
- When you can infer the answer from context — be decisive and proceed
- Trivial decisions that don't materially affect the outcome

**Usage notes:**
- Users always have an "Other" option for custom input
- Use multi_select to allow multiple answers
- Keep option labels concise (1-5 words)
- Each question should have 2-4 meaningful, distinct options`;

const QuestionOptionSchema = z.object({
  label: z
    .string()
    .describe(
      "Concise display text (1-5 words). If recommended, append '(Recommended)'.",
    ),
  description: z
    .string()
    .default("")
    .describe("Brief explanation of trade-offs or implications."),
});

const QuestionSchema = z.object({
  question: z
    .string()
    .describe("A specific, actionable question. End with '?'."),
  header: z
    .string()
    .default("")
    .describe("Short category tag (max 12 chars, e.g. 'Auth', 'Style')."),
  options: z
    .array(QuestionOptionSchema)
    .min(2)
    .max(4)
    .describe("2-4 meaningful, distinct options."),
  multi_select: z
    .boolean()
    .default(false)
    .describe("Whether the user can select multiple options."),
});

const ParamsSchema = z.object({
  questions: z
    .array(QuestionSchema)
    .min(1)
    .max(4)
    .describe("The questions to ask the user (1-4 questions)."),
});

type Params = z.infer<typeof ParamsSchema>;

export class AskUserQuestion extends CallableTool<typeof ParamsSchema> {
  readonly name = "AskUserQuestion";
  readonly description = DESCRIPTION;
  readonly schema = ParamsSchema;

  async execute(params: Params, ctx: ToolContext): Promise<ToolResult> {
    const answers: Record<string, string> = {};

    for (const q of params.questions) {
      const optionLabels = q.options.map((o) => o.label);

      if (ctx.askUser) {
        // Wire-connected: actually ask the user
        try {
          const answer = await ctx.askUser(q.question, optionLabels);
          answers[q.question] = answer;
        } catch {
          // User didn't respond or error — use first option as default
          answers[q.question] = optionLabels[0] ?? "No answer";
        }
      } else {
        // Not connected (print mode, yolo mode, etc.) — auto-select first option
        answers[q.question] = optionLabels[0] ?? "No answer";
      }
    }

    return ToolOk(
      JSON.stringify({ answers }, null, 2),
      "User responses collected.",
    );
  }
}
