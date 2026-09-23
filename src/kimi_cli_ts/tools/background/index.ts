/**
 * Background task tools — TaskList, TaskOutput, TaskStop.
 * Corresponds to Python tools/background/__init__.py
 * Uses BackgroundTaskManager for real task management.
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError, ToolOk } from "../types.ts";
import { listTaskViews, formatTaskList } from "../../background/summary.ts";
import type { BackgroundTaskManager } from "../../background/manager.ts";
import { isTerminalStatus } from "../../background/models.ts";

// Shared manager reference — bound at session startup
let _manager: BackgroundTaskManager | undefined;

export function bindBackgroundManager(manager: BackgroundTaskManager): void {
	_manager = manager;
}

export function getBackgroundManager(): BackgroundTaskManager | undefined {
	return _manager;
}

// ── TaskList ────────────────────────────────────────────

const TaskListParamsSchema = z.object({
	active_only: z
		.boolean()
		.default(true)
		.describe("Whether to list only non-terminal background tasks."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Maximum number of tasks to return."),
});

export class TaskList extends CallableTool<typeof TaskListParamsSchema> {
	readonly name = "TaskList";
	readonly description =
		"List background tasks. Returns task IDs, statuses, and descriptions.";
	readonly schema = TaskListParamsSchema;

	async execute(
		params: z.infer<typeof TaskListParamsSchema>,
		_ctx: ToolContext,
	): Promise<ToolResult> {
		if (!_manager) {
			return ToolOk("No background tasks.", "Task list retrieved.");
		}
		_manager.reconcile();
		const views = listTaskViews(_manager, {
			activeOnly: params.active_only,
			limit: params.limit,
		});
		const text = formatTaskList(views, {
			activeOnly: params.active_only,
			includeCommand: true,
		});
		return ToolOk(text, "Task list retrieved.");
	}
}

// ── TaskOutput ──────────────────────────────────────────

const TaskOutputParamsSchema = z.object({
	task_id: z.string().describe("The background task ID to inspect."),
	block: z
		.boolean()
		.default(false)
		.describe("Whether to wait for the task to finish before returning."),
	timeout: z
		.number()
		.int()
		.min(0)
		.max(3600)
		.default(30)
		.describe("Maximum number of seconds to wait when block=true."),
});

export class TaskOutput extends CallableTool<typeof TaskOutputParamsSchema> {
	readonly name = "TaskOutput";
	readonly description = "Retrieve output from a background task by its ID.";
	readonly schema = TaskOutputParamsSchema;

	async execute(
		params: z.infer<typeof TaskOutputParamsSchema>,
		_ctx: ToolContext,
	): Promise<ToolResult> {
		if (!_manager) {
			return ToolError(`Task not found: ${params.task_id}`);
		}

		_manager.reconcile();
		let view = _manager.getTask(params.task_id);
		if (!view) {
			return ToolError(`Task not found: ${params.task_id}`);
		}

		// Block if requested and task is still running
		if (params.block && !isTerminalStatus(view.runtime.status)) {
			view = await _manager.wait(params.task_id, params.timeout);
		}

		const chunk = _manager.readOutput(params.task_id);
		const lines = [
			`task_id: ${view.spec.id}`,
			`status: ${view.runtime.status}`,
			`kind: ${view.spec.kind}`,
		];
		if (view.runtime.exitCode != null) {
			lines.push(`exit_code: ${view.runtime.exitCode}`);
		}
		if (view.runtime.failureReason) {
			lines.push(`reason: ${view.runtime.failureReason}`);
		}
		if (chunk.text) {
			lines.push("", "[output]", chunk.text);
		}
		if (!chunk.eof) {
			lines.push(`[truncated at offset ${chunk.nextOffset}]`);
		}
		return ToolOk(lines.join("\n"), `Output for task ${params.task_id}.`);
	}
}

// ── TaskStop ────────────────────────────────────────────

const TaskStopParamsSchema = z.object({
	task_id: z.string().describe("The background task ID to stop."),
	reason: z
		.string()
		.default("Stopped by TaskStop")
		.describe("Short reason recorded when the task is stopped."),
});

export class TaskStop extends CallableTool<typeof TaskStopParamsSchema> {
	readonly name = "TaskStop";
	readonly description = "Stop a running background task by its ID.";
	readonly schema = TaskStopParamsSchema;

	async execute(
		params: z.infer<typeof TaskStopParamsSchema>,
		_ctx: ToolContext,
	): Promise<ToolResult> {
		if (!_manager) {
			return ToolError(`Task not found: ${params.task_id}`);
		}

		const existing = _manager.getTask(params.task_id);
		if (!existing) {
			return ToolError(`Task not found: ${params.task_id}`);
		}

		if (isTerminalStatus(existing.runtime.status)) {
			return ToolOk(
				`Task ${params.task_id} already in terminal state: ${existing.runtime.status}`,
			);
		}

		const view = _manager.kill(params.task_id, params.reason);
		return ToolOk(
			`Task ${params.task_id} stop requested. Current status: ${view.runtime.status}`,
			`Task ${params.task_id} stopped.`,
		);
	}
}
