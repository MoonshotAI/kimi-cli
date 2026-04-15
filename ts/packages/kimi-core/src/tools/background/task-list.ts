/**
 * TaskListTool — list background tasks (Slice 3.5).
 *
 * Ports Python `kimi_cli/tools/background/__init__.py:TaskList`.
 */

import { z } from 'zod';

import type { ToolResult, ToolUpdate } from '../../soul/types.js';
import type { BuiltinTool } from '../types.js';
import type { BackgroundProcessManager, BackgroundTaskInfo } from './manager.js';

// ── Input schema ─────────────────────────────────────────────────────

export interface TaskListInput {
  active_only?: boolean | undefined;
  limit?: number | undefined;
}

const _rawTaskListInputSchema = z.object({
  active_only: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to list only non-terminal background tasks.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Maximum number of tasks to return.'),
});

export const TaskListInputSchema: z.ZodType<TaskListInput> = _rawTaskListInputSchema;

// ── Implementation ───────────────────────────────────────────────────

function formatTaskList(tasks: BackgroundTaskInfo[]): string {
  if (tasks.length === 0) return 'No background tasks found.';
  return tasks
    .map(
      (t) =>
        `task_id: ${t.taskId}\n` +
        `status: ${t.status}\n` +
        `command: ${t.command}\n` +
        `description: ${t.description}\n` +
        `pid: ${String(t.pid ?? 'N/A')}`,
    )
    .join('\n---\n');
}

export class TaskListTool implements BuiltinTool<TaskListInput, void> {
  readonly name = 'TaskList' as const;
  readonly description = 'List background tasks and their current status.';
  readonly inputSchema: z.ZodType<TaskListInput> = TaskListInputSchema;

  constructor(private readonly manager: BackgroundProcessManager) {}

  async execute(
    _toolCallId: string,
    args: TaskListInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<void>> {
    const tasks = this.manager.list(args.active_only ?? true, args.limit ?? 20);
    return {
      content: formatTaskList(tasks),
      isError: false,
    };
  }

  getActivityDescription(_args: TaskListInput): string {
    return 'Listing background tasks';
  }
}
