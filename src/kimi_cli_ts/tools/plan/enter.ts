/**
 * EnterPlanMode tool — lets the LLM request to enter plan mode.
 * Corresponds to Python tools/plan/enter.py
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError, ToolOk } from "../types.ts";
import { getPlanFilePath } from "./heroes.ts";

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
