import Ajv from 'ajv';

import type { ContentPart, ToolCall } from './message.js';
import { ToolDefinitionError } from './tool-errors.js';

const META_SCHEMA_VALIDATOR = new Ajv({ strict: false });

// ── JSON Type ──────────────────────────────────────────────────────────

export type JsonType = null | number | string | boolean | JsonArray | JsonObject;

/** @internal */
export interface JsonArray extends Array<JsonType> {}
/** @internal */
export interface JsonObject extends Record<string, JsonType> {}

// ── Tool Definition ────────────────────────────────────────────────────

/**
 * A tool that the model may invoke during generation.
 *
 * The definition is provider-agnostic; each provider implementation converts
 * it to the appropriate wire format (e.g. OpenAI function-calling, Anthropic
 * tool-use, Google function declarations).
 */
export interface Tool {
  /** Unique tool name used to match invocations. */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** JSON Schema describing the tool's parameters. */
  parameters: Record<string, unknown>;
}

export function validateToolSchema(tool: Tool): void {
  try {
    META_SCHEMA_VALIDATOR.compile(tool.parameters);
  } catch (error) {
    throw new ToolDefinitionError(
      `Invalid parameters schema for tool '${tool.name}': ${(error as Error).message}`,
    );
  }
}

// ── Display Blocks ─────────────────────────────────────────────────────

export interface BriefDisplayBlock {
  type: 'brief';
  text: string;
}

export interface UnknownDisplayBlock {
  type: string;
  data: Record<string, unknown>;
}

export type DisplayBlock = BriefDisplayBlock | UnknownDisplayBlock;

// ── Tool Return Value ──────────────────────────────────────────────────

/**
 * The value returned by a tool handler after execution.
 *
 * Contains the raw output to feed back to the model, a human-readable
 * message, display blocks for the UI, and an error flag.
 */
export interface ToolReturnValue {
  /** Whether the tool execution resulted in an error. */
  isError: boolean;
  /** Raw output fed back to the model (text string or rich content parts). */
  output: string | ContentPart[];
  /** Human-readable summary of what happened. */
  message: string;
  /** UI display blocks (e.g. brief text summaries). */
  display: DisplayBlock[];
  /** Optional extra metadata attached to the result. */
  extras?: Record<string, JsonType>;
}

// ── Tool Result ────────────────────────────────────────────────────────

/**
 * A completed tool call result, pairing the originating call ID with the
 * handler's {@link ToolReturnValue}.
 */
export interface ToolResult {
  /** The ID of the tool call that produced this result. */
  toolCallId: string;
  /** The return value produced by the tool handler. */
  returnValue: ToolReturnValue;
}

// ── Toolset ────────────────────────────────────────────────────────────

/**
 * A collection of tools with a dispatcher that routes {@link ToolCall}
 * invocations to the appropriate handler.
 *
 * Implementations include {@link SimpleToolset} (registry-based) and
 * {@link EmptyToolset} (no tools available).
 */
export interface Toolset {
  /** The tool definitions available for model invocation. */
  readonly tools: Tool[];
  /**
   * Dispatch a tool call to the matching handler.
   * May return synchronously or asynchronously.
   */
  handle(toolCall: ToolCall): Promise<ToolResult> | ToolResult;
}

// ── Factory Helpers ────────────────────────────────────────────────────

function normalizeOutput(output: string | ContentPart | ContentPart[]): string | ContentPart[] {
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    return output;
  }
  return [output];
}

/** Create a successful ToolReturnValue. */
export function toolOk(opts: {
  output: string | ContentPart | ContentPart[];
  message?: string;
  brief?: string;
}): ToolReturnValue {
  const display: DisplayBlock[] = [];
  if (opts.brief) {
    display.push({ type: 'brief', text: opts.brief });
  }
  const result: ToolReturnValue = {
    isError: false,
    output: normalizeOutput(opts.output),
    message: opts.message ?? '',
    display,
  };
  return result;
}

/** Create an error ToolReturnValue. */
export function toolError(opts: {
  message: string;
  brief: string;
  output?: string | ContentPart | ContentPart[];
}): ToolReturnValue {
  return {
    isError: true,
    output: opts.output !== undefined ? normalizeOutput(opts.output) : '',
    message: opts.message,
    display: [{ type: 'brief', text: opts.brief }],
  };
}
