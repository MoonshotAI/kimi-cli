/**
 * Plan mode tools — lets the LLM enter/exit plan mode.
 * Corresponds to Python tools/plan/enter.py and tools/plan/__init__.py
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError, ToolOk } from "../types.ts";
import { getPlanFilePath, readPlanFile } from "./heroes.ts";

// ── EnterPlanMode ──────────────────────────────────

const ENTER_DESCRIPTION = `Use this tool proactively when you're about to start a non-trivial implementation task.
Getting user sign-off on your approach before writing code prevents wasted effort.

Use it when ANY of these conditions apply:
1. New Feature Implementation
2. Multiple Valid Approaches
3. Code Modifications
4. Architectural Decisions
5. Multi-File Changes
6. Unclear Requirements
7. User Preferences Matter

When NOT to use:
- Single-line or few-line fixes
- User gave very specific, detailed instructions
- Pure research/exploration tasks`;

const EnterParamsSchema = z.object({});

export class EnterPlanMode extends CallableTool<typeof EnterParamsSchema> {
  readonly name = "EnterPlanMode";
  readonly description = ENTER_DESCRIPTION;
  readonly schema = EnterParamsSchema;

  /** Session ID for plan file management. */
  private _sessionId: string;
  private _isYolo: (() => boolean) | null = null;

  constructor(sessionId = "default") {
    super();
    this._sessionId = sessionId;
  }

  /** Bind optional YOLO mode checker. */
  bindYolo(isYolo: () => boolean): void {
    this._isYolo = isYolo;
  }

  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    // Guard: already in plan mode
    if (ctx.getPlanMode?.()) {
      return ToolError(
        "Already in plan mode. Use ExitPlanMode when your plan is ready.",
      );
    }

    const planPath = getPlanFilePath(this._sessionId);

    // In YOLO mode, auto-approve entering plan mode
    if (this._isYolo?.()) {
      ctx.setPlanMode?.(true);
      return ToolOk(
        `Plan mode activated (auto-approved in non-interactive mode).\n` +
          `Plan file: ${planPath}\n` +
          `Workflow: identify key questions about the codebase → ` +
          `use Agent(subagent_type='explore') to investigate if needed → ` +
          `design approach → ` +
          `modify the plan file with WriteFile or StrReplaceFile ` +
          `(create it with WriteFile first if it does not exist) → ` +
          `call ExitPlanMode.\n`,
        "Plan mode on (auto)",
      );
    }

    // In interactive mode, ask user for confirmation
    if (ctx.askUser) {
      try {
        const answer = await ctx.askUser("Enter plan mode?", ["Yes", "No"]);

        if (answer === "Yes") {
          ctx.setPlanMode?.(true);
          return ToolOk(
            `Plan mode activated. You MUST NOT edit code files — only read and plan.\n` +
              `Plan file: ${planPath}\n` +
              `Workflow: identify key questions about the codebase → ` +
              `use Agent(subagent_type='explore') to investigate if needed → ` +
              `design approach → ` +
              `modify the plan file with WriteFile or StrReplaceFile ` +
              `(create it with WriteFile first if it does not exist) → ` +
              `call ExitPlanMode.\n` +
              `Use AskUserQuestion only to clarify missing requirements or choose ` +
              `between approaches.\n` +
              `Do NOT use AskUserQuestion to ask about plan approval.`,
            "Plan mode on",
          );
        } else {
          return ToolOk(
            "User declined to enter plan mode. Please check with user whether " +
              "to proceed with implementation directly.",
            "Declined",
          );
        }
      } catch {
        // askUser not supported, fall through to auto-enter
      }
    }

    // Fallback: auto-enter plan mode
    ctx.setPlanMode?.(true);
    return ToolOk(
      "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.\n" +
        "In plan mode, you should:\n" +
        "1. Thoroughly explore the codebase to understand existing patterns\n" +
        "2. Consider multiple approaches and their trade-offs\n" +
        "3. Design a concrete implementation strategy\n" +
        `4. Write your plan to: ${planPath}\n` +
        "5. When ready, use ExitPlanMode to present your plan for approval\n" +
        "\n" +
        "Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.",
      "Plan mode activated.",
    );
  }
}

// ── ExitPlanMode ──────────────────────────────────

const EXIT_DESCRIPTION = `Use this tool when you are in plan mode and have finished writing your plan.
This signals that you're done planning and ready for the user to review and approve.

IMPORTANT: Only use this tool when the task requires planning the implementation of a task that requires writing code.`;

const RESERVED_LABELS = new Set(["reject", "revise", "approve", "reject and exit"]);

const PlanOptionSchema = z.object({
  label: z.string().describe(
    "Short name for this option (1-8 words). Append '(Recommended)' if you recommend this option.",
  ),
  description: z.string().default("").describe(
    "Brief summary of this approach and its trade-offs.",
  ),
});

const ExitParamsSchema = z.object({
  options: z
    .array(PlanOptionSchema)
    .max(3)
    .nullish()
    .describe(
      "When the plan contains multiple alternative approaches, list them here " +
        "so the user can choose which one to execute. 2-3 options. " +
        "Do not use 'Reject', 'Revise', 'Approve', or 'Reject and Exit' as labels.",
    ),
});

type ExitParams = z.infer<typeof ExitParamsSchema>;

export class ExitPlanMode extends CallableTool<typeof ExitParamsSchema> {
  readonly name = "ExitPlanMode";
  readonly description = EXIT_DESCRIPTION;
  readonly schema = ExitParamsSchema;

  /** Session ID for plan file management. */
  private _sessionId: string;
  private _isYolo: (() => boolean) | null = null;

  constructor(sessionId = "default") {
    super();
    this._sessionId = sessionId;
  }

  /** Bind optional YOLO mode checker. */
  bindYolo(isYolo: () => boolean): void {
    this._isYolo = isYolo;
  }

  async execute(params: ExitParams, ctx: ToolContext): Promise<ToolResult> {
    // Guard: only works in plan mode
    if (!ctx.getPlanMode?.()) {
      return ToolError(
        "Not in plan mode. ExitPlanMode is only available during plan mode.",
      );
    }

    // Read the plan file
    const planPath = getPlanFilePath(this._sessionId);
    const planContent = readPlanFile(this._sessionId);

    if (!planContent) {
      return ToolError(
        `No plan file found. Write your plan to ${planPath} first, then call ExitPlanMode.`,
      );
    }

    // Validate option labels
    if (params.options) {
      for (const opt of params.options) {
        if (RESERVED_LABELS.has(opt.label.trim().toLowerCase())) {
          return ToolError(
            `Option label '${opt.label}' is reserved. Do not use Reject, Revise, Approve, or Reject and Exit as option labels.`,
          );
        }
      }
      // Check uniqueness
      const labels = params.options.map((o) => o.label);
      if (new Set(labels).size !== labels.length) {
        return ToolError("Option labels must be unique.");
      }
    }

    // In YOLO mode, auto-approve
    if (this._isYolo?.()) {
      ctx.setPlanMode?.(false);
      return ToolOk(
        `Plan approved (auto-approved in non-interactive mode). ` +
          `Plan mode deactivated. All tools are now available.\n` +
          `Plan saved to: ${planPath}\n\n` +
          `## Approved Plan:\n${planContent}`,
        "Plan approved (auto)",
      );
    }

    const hasOptions = params.options != null && params.options.length >= 2;

    // Interactive mode: ask user for approval
    if (ctx.askUser) {
      try {
        // Build option list
        let choices: string[];
        if (hasOptions) {
          choices = [
            ...params.options!.map((o) => o.label),
            "Reject",
            "Reject and Exit",
          ];
        } else {
          choices = ["Approve", "Reject", "Reject and Exit"];
        }

        // Display plan content via wireEmit if available
        ctx.wireEmit?.({
          type: "plan_display",
          content: planContent,
          filePath: planPath,
        });

        const answer = await ctx.askUser("Approve this plan", choices);

        // Handle the answer
        if (answer === "Reject and Exit") {
          ctx.setPlanMode?.(false);
          return ToolError(
            "Plan rejected by user. Plan mode deactivated. " +
              "All tools are now available. " +
              "Wait for the user's next message.",
          );
        }

        if (answer === "Reject") {
          return ToolError(
            "Plan rejected by user. Stay in plan mode. " +
              "The user will provide feedback via conversation. " +
              "Wait for the user's next message before revising.",
          );
        }

        // Approve — multi-approach (user selected a specific option)
        if (hasOptions) {
          const optionLabels = new Set(params.options!.map((o) => o.label));
          if (optionLabels.has(answer)) {
            ctx.setPlanMode?.(false);
            return ToolOk(
              `Plan approved by user. Selected approach: "${answer}"\n` +
                `Plan mode deactivated. All tools are now available.\n` +
                `Plan saved to: ${planPath}\n\n` +
                `IMPORTANT: Execute ONLY the selected approach "${answer}". ` +
                `Ignore other approaches in the plan.\n\n` +
                `## Approved Plan:\n${planContent}`,
              `Plan approved: ${answer}`,
            );
          }
        }

        // Approve — single-approach
        if (answer === "Approve") {
          ctx.setPlanMode?.(false);
          return ToolOk(
            `Plan approved by user. Plan mode deactivated. ` +
              `All tools are now available.\n` +
              `Plan saved to: ${planPath}\n\n` +
              `## Approved Plan:\n${planContent}`,
            "Plan approved",
          );
        }

        // Revise — user provided free-text feedback
        if (answer) {
          return ToolOk(
            `User wants to revise the plan. Stay in plan mode. ` +
              `Revise based on the feedback below.\n\n` +
              `User feedback: ${answer}`,
            "Plan revision requested",
          );
        }

        return ToolOk(
          "User dismissed without choosing. Plan mode remains active. " +
            "Continue working on your plan or call ExitPlanMode again when ready.",
          "Dismissed",
        );
      } catch {
        // askUser not supported, auto-approve
        ctx.setPlanMode?.(false);
        return ToolOk(
          `Plan approved (client does not support interactive review). ` +
            `Plan mode deactivated.\n` +
            `Plan saved to: ${planPath}\n\n` +
            `## Approved Plan:\n${planContent}`,
          "Plan approved",
        );
      }
    }

    // Fallback: auto-exit with plan content
    ctx.setPlanMode?.(false);
    return ToolOk(
      `Exited plan mode. All tools are now available.\n` +
        `Plan saved to: ${planPath}\n\n` +
        `## Plan:\n${planContent}`,
      "Plan mode deactivated.",
    );
  }
}
