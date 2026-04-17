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

/**
 * Slice 7.2 (决策 #100) — async / batch path used by the MCP layer.
 * `added` lists newly-present names after the change; `removed` lists
 * names that were present before but are gone after.
 */
export interface ToolChange {
  added: string[];
  removed: string[];
}

export class ToolRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly onConflict: ((conflict: ToolConflict) => void) | undefined;

  /**
   * Slice 7.2 (决策 #100) — single subscriber slot for tool-set changes.
   * Set by the host (typically the wire-event publisher) after construction;
   * fired after every `register` / `unregister` / `registerBatch` /
   * `unregisterByPrefix` that mutates the registry.
   */
  onChanged: ((change: ToolChange) => void) | null = null;

  constructor(options: ToolRegistryOptions = {}) {
    this.onConflict = options.onConflict;
  }

  register(tool: Tool, source: ToolSource = 'builtin'): void {
    const change = this.registerNoNotify(tool, source);
    if (change !== null) {
      this.notifyChange(change);
    }
  }

  /** Internal helper used by both `register` and `registerBatch`. */
  private registerNoNotify(tool: Tool, source: ToolSource): ToolChange | null {
    const existing = this.entries.get(tool.name);
    if (existing === undefined) {
      this.entries.set(tool.name, { tool, source });
      return { added: [tool.name], removed: [] };
    }

    const existingRank = SOURCE_RANK[existing.source];
    const incomingRank = SOURCE_RANK[source];

    if (existingRank === incomingRank) {
      throw new Error(`Tool "${tool.name}" is already registered by source "${existing.source}"`);
    }

    if (existingRank < incomingRank) {
      this.onConflict?.({
        name: tool.name,
        keptSource: existing.source,
        droppedSource: source,
      });
      return null;
    }

    this.onConflict?.({
      name: tool.name,
      keptSource: source,
      droppedSource: existing.source,
    });
    this.entries.set(tool.name, { tool, source });
    // Replacement of an existing name — net membership unchanged, but
    // surface a no-op change so subscribers can refresh metadata.
    return { added: [tool.name], removed: [] };
  }

  unregister(name: string): void {
    if (this.entries.delete(name)) {
      this.notifyChange({ added: [], removed: [name] });
    }
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

  // ── Slice 7.2 (决策 #100) — async batch + prefix lifecycle ────────────

  /**
   * Atomically replace every tool whose name starts with `prefix` with
   * the supplied set. Used by the MCP layer to swap a server's tool set
   * after a `tools/list_changed` notification without exposing a
   * partially-updated state to callers.
   *
   * Tools registered under this batch use source `'mcp'` so a same-name
   * collision against a higher-precedence (`builtin` / `sdk`) entry is
   * dropped silently per existing precedence rules.
   */
  async registerBatch(prefix: string, tools: readonly Tool[]): Promise<void> {
    // Snapshot before so we can compute net `added` / `removed` correctly.
    const before = new Set(this.entries.keys());
    // Remove any entry under this prefix; we'll re-register the new set.
    for (const name of Array.from(this.entries.keys())) {
      if (name.startsWith(prefix)) this.entries.delete(name);
    }
    // Within a single batch, dedupe by name with last-wins semantics.
    // MCP servers occasionally publish a tools list with duplicate names
    // (e.g. mid-refresh re-emission); throwing here would tear down the
    // whole connection over a transient quirk.
    const deduped = new Map<string, Tool>();
    for (const tool of tools) deduped.set(tool.name, tool);
    for (const tool of deduped.values()) {
      // Re-use single-call registration logic but suppress per-call notify
      // — the batch fires one aggregate `onChanged`.
      this.registerNoNotify(tool, 'mcp');
    }
    const after = new Set(this.entries.keys());
    const added: string[] = [];
    const removed: string[] = [];
    for (const name of after) {
      if (!before.has(name)) added.push(name);
    }
    for (const name of before) {
      if (!after.has(name)) removed.push(name);
    }
    this.notifyChange({ added, removed });
  }

  /** Synchronous prefix-scoped removal. Fires one aggregate `onChanged`. */
  unregisterByPrefix(prefix: string): void {
    const removed: string[] = [];
    for (const name of Array.from(this.entries.keys())) {
      if (name.startsWith(prefix)) {
        this.entries.delete(name);
        removed.push(name);
      }
    }
    if (removed.length > 0) {
      this.notifyChange({ added: [], removed });
    }
  }

  private notifyChange(change: ToolChange): void {
    this.onChanged?.(change);
  }
}
