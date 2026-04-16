/**
 * TaskOutputTool — read output from a background task (Slice 3.5).
 *
 * Ports Python `kimi_cli/tools/background/__init__.py:TaskOutput`.
 */

import { z } from 'zod';

import type { ToolResult, ToolUpdate } from '../../soul/types.js';
import type { BuiltinTool } from '../types.js';
import type { BackgroundProcessManager } from './manager.js';

// ── Input schema ─────────────────────────────────────────────────────

export interface TaskOutputInput {
  task_id: string;
  block?: boolean | undefined;
  timeout?: number | undefined;
}

const _rawTaskOutputInputSchema = z.object({
  task_id: z.string().describe('The background task ID to inspect.'),
  block: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether to wait for the task to finish before returning.'),
  timeout: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .optional()
    .default(30)
    .describe('Maximum number of seconds to wait when block=true.'),
});

export const TaskOutputInputSchema: z.ZodType<TaskOutputInput> = _rawTaskOutputInputSchema;

// ── Implementation ───────────────────────────────────────────────────

export class TaskOutputTool implements BuiltinTool<TaskOutputInput, void> {
  readonly name = 'TaskOutput' as const;
  readonly description: string =
    'Read the output of a background task. Use block=true to wait for completion.';
  readonly inputSchema: z.ZodType<TaskOutputInput> = TaskOutputInputSchema;

  constructor(private readonly manager: BackgroundProcessManager) {}

  async execute(
    _toolCallId: string,
    args: TaskOutputInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<void>> {
    const info = this.manager.getTask(args.task_id);
    if (!info) {
      return { isError: true, content: `Task not found: ${args.task_id}` };
    }

    if (args.block && info.status === 'running') {
      await this.manager.wait(args.task_id, (args.timeout ?? 30) * 1000);
    }

    // Re-fetch after potential wait.
    const current = this.manager.getTask(args.task_id)!;
    const output = this.manager.getOutput(args.task_id);
    const retrievalStatus =
      current.status === 'running' ? (args.block ? 'timeout' : 'not_ready') : 'success';

    const lines = [
      `retrieval_status: ${retrievalStatus}`,
      `task_id: ${current.taskId}`,
      `status: ${current.status}`,
      `description: ${current.description}`,
      `command: ${current.command}`,
    ];
    if (current.exitCode !== null) {
      lines.push(`exit_code: ${String(current.exitCode)}`);
    }
    lines.push('', '[output]', output || '[no output available]');

    return {
      content: lines.join('\n'),
      isError: false,
    };
  }

  getActivityDescription(args: TaskOutputInput): string {
    return `Reading output of task ${args.task_id}`;
  }
}
