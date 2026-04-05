/**
 * Toolset — corresponds to Python soul/toolset.py
 * Extended tool registry with hook integration, wire event emission,
 * currentToolCall tracking, and sessionId context.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CallableTool } from "../tools/base.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext, ToolResult } from "../tools/types.ts";
import type { HookEngine } from "../hooks/engine.ts";
import type { ToolCall } from "../types.ts";
import { logger } from "../utils/logging.ts";

// ── Context variables ─────────────────────────────────
// Use AsyncLocalStorage to mirror Python's ContextVar behavior:
// each concurrent execution (Promise / asyncio.Task) gets its own
// value, preventing races when multiple tools run in parallel.

const _toolCallStorage = new AsyncLocalStorage<ToolCall | null>();
let _currentSessionId = "";

/** Set the current session ID for tool call context. */
export function setSessionId(sid: string): void {
  _currentSessionId = sid;
}

/** Get the current session ID. */
export function getSessionId(): string {
  return _currentSessionId;
}

/** Get the current tool call, or null if not in a tool execution. */
export function getCurrentToolCallOrNull(): ToolCall | null {
  return _toolCallStorage.getStore() ?? null;
}

export interface ToolsetOptions {
  context: ToolContext;
  hookEngine?: HookEngine;
  onToolCall?: (toolCall: ToolCall) => void;
  onToolResult?: (toolCallId: string, result: ToolResult) => void;
}

export class KimiToolset {
  private registry: ToolRegistry;
  private hookEngine?: HookEngine;
  private hiddenTools = new Set<string>();
  private onToolCall?: (toolCall: ToolCall) => void;
  private onToolResult?: (toolCallId: string, result: ToolResult) => void;

  constructor(opts: ToolsetOptions) {
    this.registry = new ToolRegistry(opts.context);
    this.hookEngine = opts.hookEngine;
    this.onToolCall = opts.onToolCall;
    this.onToolResult = opts.onToolResult;
  }

  get context(): ToolContext {
    return this.registry.context;
  }

  // ── Tool management ─────────────────────────────

  add(tool: CallableTool): void {
    this.registry.register(tool);
  }

  find(name: string): CallableTool | undefined {
    return this.registry.find(name);
  }

  list(): CallableTool[] {
    return this.registry.list();
  }

  hide(toolName: string): void {
    this.hiddenTools.add(toolName);
  }

  unhide(toolName: string): void {
    this.hiddenTools.delete(toolName);
  }

  /** Get tool definitions for LLM, excluding hidden tools. */
  definitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    return this.registry
      .list()
      .filter((t) => !this.hiddenTools.has(t.name))
      .map((t) => t.toDefinition());
  }

  // ── Tool execution with hooks ────────────────────

  /**
   * Dispatch a tool call asynchronously.
   *
   * Returns a Promise that is already running (not awaited here),
   * so the caller can fire multiple handles concurrently and collect
   * them with Promise.all().
   *
   * Mirrors Python's pattern where toolset.handle() returns
   * asyncio.create_task(_call()) — the task starts immediately and
   * inherits the ContextVar value set before creation.
   *
   * We use AsyncLocalStorage.run() to give each execution its own
   * currentToolCall value (Python ContextVar equivalent).
   */
  handle(toolCall: ToolCall): Promise<ToolResult> {
    // Run the async execution inside an AsyncLocalStorage context
    // so getCurrentToolCallOrNull() returns the correct tool call
    // for each concurrent execution — mirrors Python ContextVar.
    return _toolCallStorage.run(toolCall, () =>
      this._executeToolAsync(toolCall),
    );
  }

  /**
   * Execute a single tool call with hooks.
   * Runs inside AsyncLocalStorage context — getCurrentToolCallOrNull()
   * returns the correct ToolCall throughout the execution.
   */
  private async _executeToolAsync(toolCall: ToolCall): Promise<ToolResult> {
    const { id, name, arguments: argsStr } = toolCall;

    try {
      // Notify about tool call
      this.onToolCall?.(toolCall);

      // Parse arguments
      let args: Record<string, unknown>;
      try {
        args = argsStr ? JSON.parse(argsStr) : {};
      } catch {
        const result: ToolResult = {
          isError: true,
          output: "",
          message: `Failed to parse arguments for tool "${name}": ${argsStr}`,
        };
        this.onToolResult?.(id, result);
        return result;
      }

      // Run PreToolUse hook
      if (this.hookEngine?.hasHooksFor("PreToolUse")) {
        const hookResults = await this.hookEngine.trigger("PreToolUse", {
          matcherValue: name,
          inputData: {
            session_id: _currentSessionId,
            tool_name: name,
            tool_input: args,
            tool_call_id: id,
          },
        });

        for (const hr of hookResults) {
          if (hr.action === "block") {
            const result: ToolResult = {
              isError: true,
              output: "",
              message: `Tool "${name}" blocked by hook: ${hr.reason}`,
            };
            this.onToolResult?.(id, result);
            return result;
          }
        }
      }

      // Execute tool
      let result: ToolResult;
      try {
        result = await this.registry.execute(name, args);
      } catch (err) {
        logger.error(`Tool "${name}" threw an error: ${err}`);
        result = {
          isError: true,
          output: "",
          message: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Run PostToolUse / PostToolUseFailure hook (fire-and-forget)
      if (this.hookEngine) {
        const hookEvent = result.isError ? "PostToolUseFailure" : "PostToolUse";
        if (this.hookEngine.hasHooksFor(hookEvent as any)) {
          this.hookEngine
            .trigger(hookEvent as any, {
              matcherValue: name,
              inputData: {
                session_id: _currentSessionId,
                tool_name: name,
                tool_input: args,
                tool_output: (result.output ?? "").slice(0, 2000),
                tool_error: result.isError ? result.message : undefined,
                tool_call_id: id,
              },
            })
            .catch(() => {}); // fire-and-forget
        }
      }

      // Notify about result
      this.onToolResult?.(id, result);

      return result;
    } catch (err) {
      // Defensive: catch any unexpected errors so the caller never hangs
      const result: ToolResult = {
        isError: true,
        output: "",
        message: `Tool "${name}" error: ${err instanceof Error ? err.message : String(err)}`,
      };
      this.onToolResult?.(id, result);
      return result;
    }
  }

  // ── Cleanup ───────────────────────────────────────

  async cleanup(): Promise<void> {
    // Cleanup MCP connections, etc. (future)
  }
}
