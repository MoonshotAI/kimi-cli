import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

import type { ToolCall } from './message.js';
import {
  toolNotFoundError,
  toolParseError,
  toolRuntimeError,
  toolValidateError,
} from './tool-errors.js';
import { validateToolSchema } from './tool.js';
import type { JsonType, Tool, ToolResult, ToolReturnValue, Toolset } from './tool.js';

const ajv = new Ajv({ strict: false, allErrors: true });

export type ToolArgsValidator = ValidateFunction<JsonType>;

function formatValidationError(error: ErrorObject): string {
  if (error.keyword === 'required' && 'missingProperty' in error.params) {
    return `must have required property '${String(error.params['missingProperty'])}'`;
  }

  if (error.keyword === 'additionalProperties' && 'additionalProperty' in error.params) {
    return `must NOT have additional property '${String(error.params['additionalProperty'])}'`;
  }

  const path = error.instancePath ? `${error.instancePath} ` : '';
  return `${path}${error.message ?? 'is invalid'}`;
}

export function compileToolArgsValidator(schema: Record<string, unknown>): ToolArgsValidator {
  return ajv.compile(schema) as ToolArgsValidator;
}

export function validateToolArgs(validator: ToolArgsValidator, args: JsonType): string | null {
  const valid = validator(args);
  if (valid) {
    return null;
  }

  const errors = validator.errors ?? [];
  if (errors.length === 0) {
    return 'Tool parameter validation failed';
  }

  return errors.map((error) => formatValidationError(error)).join('; ');
}

// ── Handler type ──────────────────────────────────────────────────────

export type ToolHandler = (args: JsonType) => Promise<ToolReturnValue>;

// ── SimpleToolset ─────────────────────────────────────────────────────

interface ToolEntry {
  tool: Tool;
  handler: ToolHandler;
  validator: ToolArgsValidator;
}

/**
 * A straightforward {@link Toolset} implementation that maps tool names to
 * handler functions.
 *
 * Each handler receives the parsed JSON arguments and returns a
 * `ToolReturnValue`. The toolset takes care of JSON parsing, error wrapping,
 * and async execution.
 */
export class SimpleToolset implements Toolset {
  private readonly toolMap: Map<string, ToolEntry> = new Map();

  get tools(): Tool[] {
    return [...this.toolMap.values()].map((entry) => entry.tool);
  }

  /**
   * Register a tool with its handler. Overwrites any existing tool with the same name.
   *
   * Throws `ToolDefinitionError` if `tool.parameters` is not a valid JSON
   * Schema (mirrors Python kosong's construct-time meta-schema check).
   */
  add(tool: Tool, handler: ToolHandler): void {
    validateToolSchema(tool);
    this.toolMap.set(tool.name, {
      tool,
      handler,
      validator: compileToolArgsValidator(tool.parameters),
    });
  }

  /** Remove a tool by name. Throws if the tool does not exist. */
  remove(name: string): void {
    if (!this.toolMap.has(name)) {
      throw new Error(`Tool \`${name}\` not found in the toolset.`);
    }
    this.toolMap.delete(name);
  }

  /**
   * Handle a tool call.
   *
   * 1. Look up the tool by name.
   * 2. Parse the JSON arguments.
   * 3. Invoke the handler.
   * 4. Wrap any runtime exception as a `toolRuntimeError`.
   */
  handle(toolCall: ToolCall): Promise<ToolResult> {
    const entry = this.toolMap.get(toolCall.function.name);
    if (entry === undefined) {
      return Promise.resolve({
        toolCallId: toolCall.id,
        returnValue: toolNotFoundError(toolCall.function.name),
      });
    }

    let args: JsonType;
    try {
      args = JSON.parse(toolCall.function.arguments ?? '{}') as JsonType;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return Promise.resolve({
        toolCallId: toolCall.id,
        returnValue: toolParseError(msg),
      });
    }

    const validationError = validateToolArgs(entry.validator, args);
    if (validationError !== null) {
      return Promise.resolve({
        toolCallId: toolCall.id,
        returnValue: toolValidateError(validationError),
      });
    }

    return (async (): Promise<ToolResult> => {
      try {
        const returnValue = await entry.handler(args);
        return { toolCallId: toolCall.id, returnValue };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { toolCallId: toolCall.id, returnValue: toolRuntimeError(msg) };
      }
    })();
  }
}
