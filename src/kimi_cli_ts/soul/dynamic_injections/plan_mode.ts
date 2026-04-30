/**
 * Plan mode dynamic injection — corresponds to Python soul/dynamic_injections/plan_mode.py
 * Periodically injects read-only reminders while plan mode is active.
 */

import type { Message } from "../../types.ts";
import type { KimiSoul } from "../kimisoul.ts";
import type {
	DynamicInjection,
	DynamicInjectionProvider,
} from "../dynamic_injection.ts";

/** Inject a reminder every N assistant turns. */
const TURN_INTERVAL = 5;
/** Every N-th reminder is the full version; others are sparse. */
const FULL_EVERY_N = 5;

export class PlanModeInjectionProvider implements DynamicInjectionProvider {
	private _injectCount = 0;

	async getInjections(
		history: readonly Message[],
		soul: KimiSoul,
	): Promise<DynamicInjection[]> {
		if (!soul.planMode) {
			this._injectCount = 0;
			return [];
		}

		const planPath = soul.getPlanFilePath();
		const planPathStr = planPath ?? null;
		const planExists = planPath != null && (await fileExists(planPath));

		// Manual toggles schedule a one-shot activation reminder for the next LLM step.
		if (soul.consumePendingPlanActivationInjection()) {
			this._injectCount = 1;
			if (planExists) {
				return [
					{ type: "plan_mode_reentry", content: reentryReminder(planPathStr) },
				];
			}
			return [
				{ type: "plan_mode", content: fullReminder(planPathStr, planExists) },
			];
		}

		// Scan history backwards to find the last plan mode reminder.
		let turnsSinceLast = 0;
		let foundPrevious = false;
		for (let i = history.length - 1; i >= 0; i--) {
			const msg = history[i]!;
			if (msg.role === "user" && hasPlanReminder(msg)) {
				foundPrevious = true;
				break;
			}
			if (msg.role === "assistant") {
				turnsSinceLast++;
			}
		}

		// First time (no reminder in history yet) -> inject full version.
		if (!foundPrevious) {
			this._injectCount = 1;
			return [
				{ type: "plan_mode", content: fullReminder(planPathStr, planExists) },
			];
		}

		// Not enough turns since last reminder -> skip.
		if (turnsSinceLast < TURN_INTERVAL) {
			return [];
		}

		// Inject.
		this._injectCount++;
		const isFull = this._injectCount % FULL_EVERY_N === 1;
		const content = isFull
			? fullReminder(planPathStr, planExists)
			: sparseReminder(planPathStr);
		return [{ type: "plan_mode", content }];
	}
}

// ── Reminder text builders ───────────────────────────

function hasPlanReminder(msg: Message): boolean {
	const sparseKey = sparseReminder().split(".")[0]!;
	const fullKey = fullReminder().split("\n")[0]!;

	const text = extractText(msg.content);
	return text.includes(sparseKey) || text.includes(fullKey);
}

export function fullReminder(
	planFilePath: string | null = null,
	planExists = false,
): string {
	const lines: string[] = [
		"Plan mode is active. You MUST NOT make any edits " +
			"(with the exception of the plan file below), run non-readonly tools, " +
			"or otherwise make changes to the system. " +
			"This supersedes any other instructions you have received.",
	];

	if (planFilePath) {
		lines.push("");
		if (planExists) {
			lines.push(
				`Plan file: ${planFilePath} ` +
					"(exists — read first, then update it with WriteFile or StrReplaceFile)",
			);
		} else {
			lines.push(
				`Plan file: ${planFilePath} ` +
					"(create it with WriteFile; once it exists, you can modify it with " +
					"WriteFile or StrReplaceFile)",
			);
		}
		lines.push("This is the only file you are allowed to edit.");
	}

	lines.push(
		"",
		"Workflow:",
		"1. Understand — explore the codebase with Glob, Grep, ReadFile",
		"2. Design — converge on the best approach; " +
			"consider trade-offs but aim for a single recommendation",
		"3. Review — re-read key files to verify understanding",
		"4. Write Plan — modify the plan file with WriteFile or StrReplaceFile. " +
			"Use WriteFile if the plan file does not exist yet",
		"5. Exit — call ExitPlanMode for user approval",
	);

	lines.push(
		"",
		"## Handling multiple approaches",
		"Keep it focused: at most 2-3 meaningfully different approaches. " +
			"Do NOT pad with minor variations — if one approach is clearly " +
			"superior, just propose that one.",
		"When the best approach depends on user preferences, constraints, " +
			"or context you don't have, use AskUserQuestion to clarify first. " +
			"This helps you write a better, more targeted plan rather than " +
			"dumping multiple options for the user to sort through.",
		"When you do include multiple approaches in the plan, you MUST pass them " +
			"as the `options` parameter when calling ExitPlanMode, so the user can select which " +
			"approach to execute at approval time.",
		"NEVER write multiple approaches in the plan and call ExitPlanMode without the " +
			"`options` parameter — the user will only see Approve/Reject with no way to choose.",
	);

	lines.push(
		"",
		"AskUserQuestion is for clarifying missing requirements or user preferences " +
			"that affect the plan.",
		"Never ask about plan approval via text or AskUserQuestion.",
		"Your turn must end with either AskUserQuestion " +
			"(to clarify requirements or preferences) " +
			"or ExitPlanMode (to request plan approval). " +
			"Do NOT end your turn any other way.",
		"Do NOT use AskUserQuestion to ask about plan approval or reference " +
			'"the plan" — the user cannot see the plan until you call ExitPlanMode.',
	);

	return lines.join("\n");
}

export function sparseReminder(planFilePath: string | null = null): string {
	const parts: string[] = [
		"Plan mode still active (see full instructions earlier).",
	];

	if (planFilePath) {
		parts.push(`Read-only except plan file (${planFilePath}).`);
	} else {
		parts.push("Read-only.");
	}

	parts.push(
		"Use WriteFile or StrReplaceFile to modify the plan file. " +
			"If it does not exist yet, create it with WriteFile first.",
		"Use AskUserQuestion to clarify user preferences " +
			"when it helps you write a better plan.",
		"If the plan has multiple approaches, " +
			"pass options to ExitPlanMode so the user can choose.",
		"End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for approval).",
		"Never ask about plan approval via text or AskUserQuestion.",
	);

	return parts.join(" ");
}

function reentryReminder(planFilePath: string | null = null): string {
	const lines: string[] = [
		"Plan mode is active. You MUST NOT make any edits " +
			"(with the exception of the plan file below), run non-readonly tools, " +
			"or otherwise make changes to the system. " +
			"This supersedes any other instructions you have received.",
		"",
		"## Re-entering Plan Mode",
		planFilePath
			? `A plan file exists at ${planFilePath} from a previous planning session.`
			: "A plan file from a previous planning session already exists.",
		"Before proceeding:",
		"1. Read the existing plan file to understand what was previously planned",
		"2. Evaluate the user's current request against that plan",
		"3. If different task: replace the old plan with a fresh one. " +
			"If same task: update the existing plan.",
		"4. You may use WriteFile or StrReplaceFile to modify the plan file. " +
			"If the file does not exist yet, create it with WriteFile first.",
		"5. Use AskUserQuestion to clarify missing requirements " +
			"or user preferences that affect the plan.",
		"6. Always edit the plan file before calling ExitPlanMode.",
		"",
		"Your turn must end with either AskUserQuestion (to clarify requirements) " +
			"or ExitPlanMode (to request plan approval).",
	];
	return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────

function extractText(
	content: string | readonly { type: string; [key: string]: unknown }[],
): string {
	if (typeof content === "string") return content;
	return content
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("");
}

async function fileExists(path: string): Promise<boolean> {
	try {
		const file = Bun.file(path);
		return await file.exists();
	} catch {
		return false;
	}
}
