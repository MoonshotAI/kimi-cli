/**
 * Plan mode edit target validation.
 * Corresponds to Python tools/file/plan_mode.py
 */

import { resolve } from "node:path";
import type { ToolResult } from "../types.ts";
import { ToolError } from "../types.ts";

export interface PlanEditTarget {
	active: boolean;
	planPath: string | null;
	isPlanTarget: boolean;
}

/**
 * Resolve whether a file edit is targeting the current plan artifact.
 * Returns a PlanEditTarget on success, or a ToolResult error on failure.
 */
export function inspectPlanEditTarget(
	filePath: string,
	opts: {
		planModeChecker?: () => boolean;
		planFilePathGetter?: () => string | null;
	},
): PlanEditTarget | ToolResult {
	const { planModeChecker, planFilePathGetter } = opts;

	if (!planModeChecker || !planModeChecker()) {
		return { active: false, planPath: null, isPlanTarget: false };
	}

	const planPath = planFilePathGetter?.() ?? null;
	if (planPath === null) {
		return ToolError(
			"Plan mode is active, but the current plan file is unavailable.",
		);
	}

	const canonicalPlanPath = resolve(planPath);
	const canonicalFilePath = resolve(filePath);

	if (canonicalFilePath !== canonicalPlanPath) {
		return ToolError(
			`Plan mode is active. You may only edit the current plan file: \`${canonicalPlanPath}\`.`,
		);
	}

	return { active: true, planPath, isPlanTarget: true };
}
