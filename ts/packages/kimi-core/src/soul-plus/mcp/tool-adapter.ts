/**
 * MCP tool adapter — Slice 2.6.
 *
 * Converts an MCP `MCPToolDefinition` into a kimi-core {@link Tool}.
 * The produced tool:
 *
 *   - Has name `mcp__<serverName>__<mcpToolName>` (v2 §9-F.5 naming
 *     convention; avoids collisions between servers and between MCP
 *     and built-in tools).
 *   - Uses `z.unknown()` for its `inputSchema`. MCP tools declare a
 *     JSON Schema at the protocol level; translating JSON Schema →
 *     zod at runtime is both lossy and large, and the downstream MCP
 *     server already validates arguments itself. Kimi-core therefore
 *     accepts whatever the LLM sends and lets the server reject bad
 *     inputs with its own error message.
 *   - Marks the description so the LLM knows this is an external tool
 *     (matches Python `MCPTool.__init__` prefix from `toolset.py:549`).
 *   - Wraps the SDK `callTool` in a hard {@link MCPTimeoutError}
 *     timeout via `Promise.race` + `AbortController`. Default timeout
 *     mirrors Python's `tool_call_timeout_ms = 60_000`.
 *   - Runs the result through {@link convertMcpToolResult} to apply
 *     the shared char budget + unsupported-content guard.
 *
 * Approval is **not** handled here. The `beforeToolCall` hook in
 * `permission/before-tool-call.ts` intercepts every tool call before
 * `execute` runs; the `action-label.ts` `mcp__*` rule feeds the right
 * `approve_for_session` label. Adapter stays stateless and
 * approval-agnostic.
 */

import { z } from 'zod';

import type { Tool, ToolResult, ToolUpdate } from '../../soul/index.js';
import type { MCPClient, MCPToolDefinition } from './client.js';
import { MCPTimeoutError } from './errors.js';
import { convertMcpToolResult } from './output-budget.js';

/**
 * Default per-call hard timeout for MCP tool invocations. Matches
 * Python `MCPClientConfig.tool_call_timeout_ms = 60_000`
 * (`src/kimi_cli/config.py:160-172`).
 */
export const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 60_000;

export const MCP_TOOL_NAME_PREFIX = 'mcp__';

/** Compose the kimi-core tool name for an MCP tool on a given server. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${serverName}__${toolName}`;
}

/** Parse an MCP tool name back into its `(server, tool)` components. */
export function parseMcpToolName(name: string): { serverName: string; toolName: string } | null {
  if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
  // Server and tool names are separated by the `__` double underscore.
  // A single underscore may appear inside either half (e.g. `get_files`),
  // so we split on the **first** `__` occurrence.
  const sep = rest.indexOf('__');
  if (sep < 0) return null;
  return {
    serverName: rest.slice(0, sep),
    toolName: rest.slice(sep + 2),
  };
}

export interface McpToolAdapterOptions {
  readonly serverName: string;
  readonly mcpTool: MCPToolDefinition;
  readonly client: MCPClient;
  readonly timeoutMs?: number | undefined;
}

/**
 * Adapt an MCP tool definition to a kimi-core {@link Tool}. The
 * returned object is a plain value; callers register it into their
 * `ToolRegistry` (or merge it into a `Tool[]`) themselves.
 */
export function mcpToolToKimiTool(options: McpToolAdapterOptions): Tool {
  const { serverName, mcpTool, client } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS;
  const kimiName = mcpToolName(serverName, mcpTool.name);
  const description = composeDescription(serverName, mcpTool.description);

  return {
    name: kimiName,
    description,
    inputSchema: z.unknown(),
    // Slice 7.2 (决策 #100) — provenance metadata so the orchestrator can
    // tell MCP-supplied tools from built-ins and locate the source server.
    metadata: {
      source: 'mcp',
      serverId: serverName,
      originalName: mcpTool.name,
    },
    // Slice 7.2 (决策 #100) — MCP results can be large; cap at 100k chars
    // unless the upstream layer explicitly overrides.
    maxResultSizeChars: 100_000,
    // Slice 7.2 (决策 #100) — explicit `display: undefined` so callers can
    // probe the slot via property access without `in` guards.
    display: undefined,
    async execute(
      toolCallId: string,
      args: unknown,
      signal: AbortSignal,
      _onUpdate?: (update: ToolUpdate) => void,
    ): Promise<ToolResult> {
      void toolCallId;
      void _onUpdate;
      // The MCP tool's arguments are always a JSON object. Soul has
      // already parsed `toolCall.args` via `inputSchema` which is
      // `z.unknown()` for us, so we widen back to the shape the SDK
      // wants. Non-objects are coerced to `{}` — defensive for LLMs
      // that occasionally emit a bare string or array.
      const argsObj: Record<string, unknown> =
        args !== null && typeof args === 'object' && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};

      try {
        const rawResult = await callToolWithTimeout(
          client,
          mcpTool.name,
          argsObj,
          timeoutMs,
          signal,
        );
        return convertMcpToolResult(rawResult);
      } catch (error) {
        if (error instanceof MCPTimeoutError) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  `MCP tool "${mcpTool.name}" timed out after ${timeoutMs}ms. ` +
                  'The server may be overloaded or the configured timeout is too low.',
              },
            ],
          };
        }
        if (signal.aborted) {
          // Let Soul's abort handling produce the standard synthetic
          // result; don't swallow abort as a regular tool error.
          throw error;
        }
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `MCP tool "${mcpTool.name}" failed: ${errorMessage(error)}`,
            },
          ],
        };
      }
    },
  };
}

function composeDescription(serverName: string, raw: string): string {
  const trimmed = raw.trim().length > 0 ? raw.trim() : 'No description provided.';
  return (
    `This is an MCP (Model Context Protocol) tool from MCP server \`${serverName}\`.\n\n` + trimmed
  );
}

/**
 * Run `client.callTool` under a hard timeout. Rejects with
 * {@link MCPTimeoutError} when the timer fires; rejects with a plain
 * abort error when the parent signal fires. Both cases cascade into
 * the SDK via a linked `AbortController` — the child signal is
 * handed to `client.callTool(...)` so aborting the turn actually
 * cancels the in-flight MCP request instead of leaving the SDK
 * sitting on a socket waiting for a response that the caller has
 * already abandoned (M1).
 */
async function callToolWithTimeout(
  client: MCPClient,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<Awaited<ReturnType<MCPClient['callTool']>>> {
  // Child controller forwarded into the SDK. Aborting this controller
  // cancels the MCP request at the transport layer. We abort it in
  // three situations: the timer fires, the parent signal fires, or
  // the `finally` block cleans up after a normal resolution.
  const childController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;

  try {
    return await new Promise((resolve, reject) => {
      if (parentSignal.aborted) {
        childController.abort();
        reject(new Error('aborted'));
        return;
      }
      abortListener = () => {
        childController.abort();
        reject(new Error('aborted'));
      };
      parentSignal.addEventListener('abort', abortListener, { once: true });

      timer = setTimeout(() => {
        childController.abort();
        reject(new MCPTimeoutError(toolName, timeoutMs));
      }, timeoutMs);

      client.callTool(toolName, args, { signal: childController.signal }).then(resolve, reject);
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (abortListener !== null) {
      parentSignal.removeEventListener('abort', abortListener);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
