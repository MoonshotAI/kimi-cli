/**
 * AgentRegistry -- Slice 3.1.
 *
 * Central registry of agent specs. Manages built-in agents
 * (registered at construction), user agents (scanned from
 * ~/.kimi/agents/<name>/agent.yaml), and resolution with
 * full inheritance chain.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_AGENT } from './default-agent.js';
import { AgentNotFoundError } from './errors.js';
import { resolveInheritance } from './inherit.js';
import { loadAgentFile } from './loader.js';
import type { AgentSpec } from './types.js';

export class AgentRegistry {
  private readonly agents = new Map<string, AgentSpec>();

  constructor() {
    // Register built-in agents
    this.register(DEFAULT_AGENT);
  }

  /**
   * Register an agent spec. Overwrites any existing entry with the same name.
   */
  register(spec: AgentSpec): void {
    this.agents.set(spec.name, spec);
  }

  /**
   * Get a raw (unresolved) agent spec by name.
   */
  get(name: string): AgentSpec | undefined {
    return this.agents.get(name);
  }

  /**
   * Resolve an agent by name with full inheritance chain applied.
   * @throws AgentNotFoundError if the agent is not registered.
   * @throws AgentInheritanceCycleError if a cycle is detected.
   */
  resolve(name: string): AgentSpec {
    const spec = this.agents.get(name);
    if (spec === undefined) {
      throw new AgentNotFoundError(name);
    }
    return resolveInheritance(spec, (n) => this.agents.get(n));
  }

  /**
   * List all registered agent specs (unresolved).
   */
  listAgents(): readonly AgentSpec[] {
    return [...this.agents.values()];
  }

  /**
   * Scan a directory for agent subdirectories containing agent.yaml.
   * Each valid agent is registered; invalid files emit a warning and
   * are skipped.
   *
   * Expected layout:
   *   agentsDir/
   *     my-agent/
   *       agent.yaml
   *     another-agent/
   *       agent.yaml
   */
  scanDirectory(agentsDir: string, onWarning?: (msg: string) => void): void {
    if (!existsSync(agentsDir)) return;

    let entries: string[];
    try {
      entries = readdirSync(agentsDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const subDir = join(agentsDir, entry);
      try {
        if (!statSync(subDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const agentFile = join(subDir, 'agent.yaml');
      if (!existsSync(agentFile)) continue;

      try {
        const spec = loadAgentFile(agentFile);
        this.register(spec);
      } catch (error) {
        onWarning?.(
          `Skipping agent at ${agentFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
