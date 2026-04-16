/**
 * Default display-hook fallbacks (Slice 5 / 决策 #98).
 *
 * Six pure functions provide reasonable rendering hints for any tool that
 * has not explicitly wired its own `Tool.display` hooks. Plugin authors
 * compose these to keep boilerplate small.
 */

import type {
  Tool,
  ToolInputDisplay,
  ToolResult,
  ToolResultDisplay,
  ToolUpdate,
} from '../soul/types.js';

/** Single tool result content character ceiling for built-in tools. */
export const DEFAULT_BUILTIN_MAX_RESULT_CHARS = 50_000;
/** Single tool result content character ceiling for MCP-wrapped tools. */
export const DEFAULT_MCP_MAX_RESULT_CHARS = 100_000;

export function defaultGetUserFacingName(tool: Tool, _input: unknown): string {
  return tool.name;
}

export function defaultGetActivityDescription(tool: Tool, _input: unknown): string {
  return `Running ${tool.name}`;
}

export function defaultGetInputDisplay(tool: Tool, input: unknown): ToolInputDisplay {
  return { kind: 'generic', summary: tool.name, detail: input };
}

export function defaultGetResultDisplay(_tool: Tool, result: ToolResult): ToolResultDisplay {
  if (result.isError === true) {
    return { kind: 'error', message: contentToString(result.content) };
  }
  return { kind: 'text', text: contentToString(result.content) };
}

export function defaultGetProgressDescription(
  _tool: Tool,
  _input: unknown,
  update: ToolUpdate,
): string | undefined {
  if (update.kind === 'stdout' || update.kind === 'stderr' || update.kind === 'status') {
    return update.text;
  }
  if (update.kind === 'progress' && update.percent !== undefined) {
    return `${String(update.percent)}%`;
  }
  return undefined;
}

export function defaultGetCollapsedSummary(
  tool: Tool,
  _input: unknown,
  result: ToolResult,
): string {
  const status = result.isError === true ? 'error' : 'ok';
  return `${tool.name} (${status})`;
}

function contentToString(content: ToolResult['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : '[non-text block]'))
    .join('');
}
