import type { ToolCall } from './message.js';
import { toolNotFoundError } from './tool-errors.js';
import type { Tool, ToolResult, Toolset } from './tool.js';

/**
 * A {@link Toolset} that contains no tools.
 *
 * Any tool call dispatched to it is answered with a "tool not found" error.
 */
export class EmptyToolset implements Toolset {
  readonly tools: Tool[] = [];

  handle(toolCall: ToolCall): ToolResult {
    return {
      toolCallId: toolCall.id,
      returnValue: toolNotFoundError(toolCall.function.name),
    };
  }
}
