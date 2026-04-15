/**
 * TaskStopTool — stop a running background task (Slice 3.5).
 *
 * Ports Python `kimi_cli/tools/background/__init__.py:TaskStop`.
 */

import { z } from 'zod';

import type { ToolResult, ToolUpdate } from '../../soul/types.js';
import type { BuiltinTool } from '../types.js';
import type { BackgroundProcessManager } from './manager.js';

// ── Input schema ─────────────────────────────────────────────────────

export interface TaskStopInput {
  task_id: string;
  reason?: string | undefined;
}

const _rawTaskStopInputSchema = z.object({
  task_id: z.string().describe('The background task ID to stop.'),
  reason: z
    .string()
    .optional()
    .default('Stopped by TaskStop')
    .describe('Short reason recorded when the task is stopped.'),
});

export const TaskStopInputSchema: z.ZodType<TaskStopInput> = _rawTaskStopInputSchema;

// ── Implementation ───────────────────────────────────────────────────

export class TaskStopTool implements BuiltinTool<TaskStopInput, void> {
  readonly name = 'TaskStop' as const;
  readonly description = 'Stop a running background task.';
  readonly inputSchema: z.ZodType<TaskStopInput> = TaskStopInputSchema;

  constructor(private readonly manager: BackgroundProcessManager) {}

  async execute(
    _toolCallId: string,
    args: TaskStopInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<void>> {
    const info = this.manager.getTask(args.task_id);
    if (!info) {
      return { isError: true, content: `Task not found: ${args.task_id}` };
    }

    if (info.status !== 'running') {
      return {
        content: `Task ${args.task_id} is already in terminal state: ${info.status}`,
        isError: false,
      };
    }

    const result = await this.manager.stop(args.task_id);
    if (!result) {
      return { isError: true, content: `Failed to stop task: ${args.task_id}` };
    }

    return {
      content:
        `task_id: ${result.taskId}\n` +
        `status: ${result.status}\n` +
        `reason: ${args.reason ?? 'Stopped by TaskStop'}`,
      isError: false,
    };
  }

  getActivityDescription(args: TaskStopInput): string {
    return `Stopping task ${args.task_id}`;
  }
}
