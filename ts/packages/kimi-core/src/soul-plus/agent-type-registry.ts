/**
 * AgentTypeRegistry — registry of agent type definitions with tool subset
 * resolution.
 *
 * Python parity: `kimi_cli.soul.agent.LaborMarket` (builtin type registry)
 *
 * Populated at SoulPlus construction time from YAML agent definitions via
 * `loadSubagentTypes()`. At subagent spawn time, `resolveToolSet()` filters
 * the parent's tool array down to the subset declared in the YAML.
 */

import type { Tool } from '../soul/types.js';

// ── AgentTypeDefinition ───────────────────────────────────────────────

export interface AgentTypeDefinition {
  /** Registry name (e.g. "coder", "explore", "plan"). */
  name: string;
  /** Short description shown to the LLM for tool selection. */
  description: string;
  /** Extended guidance shown to the LLM about when to use this agent. */
  whenToUse: string;
  /** System prompt suffix (ROLE_ADDITIONAL) injected into child soul. */
  systemPromptSuffix: string;
  /**
   * Explicit tool allowlist (TS tool names). When non-null, the child
   * receives ONLY tools whose `name` appears in this list — filtered
   * from the parent's full tool set. When null, the child inherits
   * the parent's full tool set (minus excludeTools).
   */
  allowedTools: string[] | null;
  /** Tools to remove from the child's tool set (TS tool names). */
  excludeTools: string[];
  /** Default model alias override for this agent type. */
  defaultModel: string | null;
  /**
   * Whether this agent type supports background execution.
   * When false, AgentTool rejects `runInBackground=true` requests.
   * Defaults to true when not explicitly set.
   *
   * Python parity: `agent_types.yaml` `supports_background` field.
   */
  supportsBackground?: boolean | undefined;
}

// ── AgentTypeRegistry ─────────────────────────────────────────────────

export class AgentTypeRegistry {
  private readonly types = new Map<string, AgentTypeDefinition>();

  /**
   * Register an agent type definition.
   */
  register(name: string, def: AgentTypeDefinition): void {
    this.types.set(name, def);
  }

  /**
   * Resolve an agent type by name. Throws if unknown.
   */
  resolve(name: string): AgentTypeDefinition {
    const def = this.types.get(name);
    if (def === undefined) {
      throw new Error(
        `Unknown agent type: "${name}". Available: ${[...this.types.keys()].join(', ')}`,
      );
    }
    // Apply default: supportsBackground defaults to true when not explicitly set
    return {
      ...def,
      supportsBackground: def.supportsBackground ?? true,
    };
  }

  /**
   * List all registered type definitions.
   */
  list(): AgentTypeDefinition[] {
    return [...this.types.values()];
  }

  /**
   * Check if a type is registered.
   */
  has(name: string): boolean {
    return this.types.has(name);
  }

  /**
   * Resolve the tool subset for a given agent type, filtered from the
   * parent's full tool array.
   *
   * Python parity: `agent.py:457-460`
   *   tools = allowed_tools if allowed_tools else agent_spec.tools
   *   tools = [t for t in tools if t not in exclude_tools]
   */
  resolveToolSet(name: string, parentTools: readonly Tool[]): Tool[] {
    const def = this.resolve(name);

    let base: Tool[];
    if (def.allowedTools !== null) {
      // Allowlist mode: only include tools whose name is in the whitelist
      const allowed = new Set(def.allowedTools);
      base = parentTools.filter((t) => allowed.has(t.name));
    } else {
      // Inherit mode: start with all parent tools
      base = [...parentTools];
    }

    if (def.excludeTools.length > 0) {
      const excluded = new Set(def.excludeTools);
      base = base.filter((t) => !excluded.has(t.name));
    }

    return base;
  }

  /**
   * Build the subagent type description lines for inclusion in the Agent
   * tool's schema / system prompt. Used by AgentTool to tell the LLM
   * which agent types are available.
   *
   * Python parity: `tools/agent/__init__.py:_builtin_type_lines()`
   */
  buildTypeDescriptions(): string {
    const lines: string[] = [];
    for (const def of this.types.values()) {
      lines.push(`- ${def.name}: ${def.description}`);
      if (def.whenToUse) {
        lines.push(`  When to use: ${def.whenToUse.trim()}`);
      }
      const bgSupported = def.supportsBackground ?? true;
      lines.push(`  Background: ${bgSupported ? 'yes' : 'no'}`);
    }
    return lines.join('\n');
  }
}
