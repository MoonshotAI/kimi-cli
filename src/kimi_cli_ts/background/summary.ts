/**
 * Background task summary/formatting — corresponds to Python background/summary.py
 */

import type { TaskView } from "./models.ts";
import { isTerminalStatus } from "./models.ts";
import type { BackgroundTaskManager } from "./manager.ts";

export function listTaskViews(
	manager: BackgroundTaskManager,
	opts?: { activeOnly?: boolean; limit?: number },
): TaskView[] {
	const activeOnly = opts?.activeOnly ?? true;
	const limit = opts?.limit ?? 20;
	let views = manager.listTasks({ limit: undefined });
	if (activeOnly) {
		views = views.filter((v) => !isTerminalStatus(v.runtime.status));
	}
	return views.slice(0, limit);
}

export function formatTask(
	view: TaskView,
	opts?: { includeCommand?: boolean },
): string {
	const lines = [
		`task_id: ${view.spec.id}`,
		`kind: ${view.spec.kind}`,
		`status: ${view.runtime.status}`,
		`description: ${view.spec.description}`,
	];

	if (view.spec.kind === "agent" && view.spec.kindPayload) {
		const agentId = view.spec.kindPayload.agent_id;
		if (agentId) lines.push(`agent_id: ${agentId}`);
		const subagentType = view.spec.kindPayload.subagent_type;
		if (subagentType) lines.push(`subagent_type: ${subagentType}`);
	}

	if (opts?.includeCommand && view.spec.command) {
		lines.push(`command: ${view.spec.command}`);
	}
	if (view.runtime.exitCode != null) {
		lines.push(`exit_code: ${view.runtime.exitCode}`);
	}
	if (view.runtime.failureReason) {
		lines.push(`reason: ${view.runtime.failureReason}`);
	}
	return lines.join("\n");
}

export function formatTaskList(
	views: TaskView[],
	opts?: { activeOnly?: boolean; includeCommand?: boolean },
): string {
	const activeOnly = opts?.activeOnly ?? true;
	const includeCommand = opts?.includeCommand ?? true;
	const header = activeOnly ? "active_background_tasks" : "background_tasks";

	if (views.length === 0) {
		return `${header}: 0\n[no tasks]`;
	}

	const lines = [`${header}: ${views.length}`, ""];
	for (let i = 0; i < views.length; i++) {
		lines.push(`[${i + 1}]`, formatTask(views[i]!, { includeCommand }), "");
	}
	return lines.join("\n").trimEnd();
}

export function buildActiveTaskSnapshot(
	manager: BackgroundTaskManager,
	opts?: { limit?: number },
): string | undefined {
	const views = listTaskViews(manager, {
		activeOnly: true,
		limit: opts?.limit ?? 20,
	});
	if (views.length === 0) return undefined;
	return [
		"<active-background-tasks>",
		formatTaskList(views, { activeOnly: true, includeCommand: false }),
		"</active-background-tasks>",
	].join("\n");
}
