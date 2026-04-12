import type { ToolReturnValue } from './tool.js';

/**
 * Tool-level error constructors.
 *
 * These produce ToolReturnValue objects with isError=true.
 * They are NOT exceptions — they represent structured tool error responses.
 */

export class ToolDefinitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ToolDefinitionError';
  }
}

/** The requested tool does not exist. */
export function toolNotFoundError(toolName: string): ToolReturnValue {
  const message = `Tool \`${toolName}\` not found`;
  return {
    isError: true,
    output: '',
    message,
    display: [{ type: 'brief', text: message }],
  };
}

/** Failed to parse tool call arguments (e.g. invalid JSON). */
export function toolParseError(message: string): ToolReturnValue {
  const toolMessage = `Error parsing JSON arguments: ${message}`;
  return {
    isError: true,
    output: '',
    message: toolMessage,
    display: [{ type: 'brief', text: 'Invalid arguments' }],
  };
}

/** Tool arguments failed schema validation. */
export function toolValidateError(message: string): ToolReturnValue {
  const toolMessage = `Error validating JSON arguments: ${message}`;
  return {
    isError: true,
    output: '',
    message: toolMessage,
    display: [{ type: 'brief', text: 'Invalid arguments' }],
  };
}

/** Tool execution failed at runtime. */
export function toolRuntimeError(message: string): ToolReturnValue {
  const toolMessage = `Error running tool: ${message}`;
  return {
    isError: true,
    output: '',
    message: toolMessage,
    display: [{ type: 'brief', text: 'Tool runtime error' }],
  };
}
