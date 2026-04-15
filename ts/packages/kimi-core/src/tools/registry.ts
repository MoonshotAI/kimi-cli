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
 *
 * Source precedence (Slice 4 audit m1 / v2 §9-F.5 decision #64):
 *   `builtin` > `sdk` > `mcp` > `plugin`
 * On a name collision between different sources, the higher-precedence
 * registration wins; the loser is dropped with an `onConflict` notification
 * (log-only, never throws). Two registrations from the *same* source
 * collide "for real" — those still throw so plugins cannot silently stomp
 * each other.
 */

import type { Tool } from '../soul/types.js';

export type ToolSource = 'builtin' | 'sdk' | 'mcp' | 'plugin';

// Lower rank = higher precedence.
const SOURCE_RANK: Record<ToolSource, number> = {
  builtin: 0,
  sdk: 1,
  mcp: 2,
  plugin: 3,
};

export interface ToolConflict {
  readonly name: string;
  readonly keptSource: ToolSource;
  readonly droppedSource: ToolSource;
}

export interface ToolRegistryOptions {
  readonly onConflict?: ((conflict: ToolConflict) => void) | undefined;
}

interface Entry {
  readonly tool: Tool;
  readonly source: ToolSource;
}

export class ToolRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly onConflict: ((conflict: ToolConflict) => void) | undefined;

  constructor(options: ToolRegistryOptions = {}) {
    this.onConflict = options.onConflict;
  }

  register(tool: Tool, source: ToolSource = 'builtin'): void {
    const existing = this.entries.get(tool.name);
    if (existing === undefined) {
      this.entries.set(tool.name, { tool, source });
      return;
    }

    const existingRank = SOURCE_RANK[existing.source];
    const incomingRank = SOURCE_RANK[source];

    if (existingRank === incomingRank) {
      // True conflict: two equals fighting for the same name. No winner.
      throw new Error(`Tool "${tool.name}" is already registered by source "${existing.source}"`);
    }

    if (existingRank < incomingRank) {
      // Existing has higher precedence: keep existing, drop incoming.
      this.onConflict?.({
        name: tool.name,
        keptSource: existing.source,
        droppedSource: source,
      });
      return;
    }

    // Incoming has higher precedence: replace.
    this.onConflict?.({
      name: tool.name,
      keptSource: source,
      droppedSource: existing.source,
    });
    this.entries.set(tool.name, { tool, source });
  }

  unregister(name: string): void {
    this.entries.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.entries.get(name)?.tool;
  }

  getOrThrow(name: string): Tool {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new Error(`Tool "${name}" is not registered`);
    }
    return entry.tool;
  }

  list(): Tool[] {
    return [...this.entries.values()].map((e) => e.tool);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }
}
