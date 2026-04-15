/**
 * ToolRegistry — per-session tool registration (v2 §9-F.5).
 *
 * A flat name → Tool lookup table. Knows nothing about subagent /
 * TurnOverrides / PermissionMode — those are TurnManager concerns.
 *
 * Naming convention:
 *   - Built-in tools: no prefix (`Read`, `Write`, `Bash`, …)
 *   - MCP tools:      `mcp__<serverName>__<toolName>`
 *   - Plugin tools:   `plugin__<pluginName>__<toolName>`
 *
 * Separator is `__` (double underscore) — server / tool names may contain
 * single underscores, double underscore is unambiguous for reverse parsing.
 */

import type { Tool } from '../soul/types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getOrThrow(name: string): Tool {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new Error(`Tool "${name}" is not registered`);
    }
    return tool;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
