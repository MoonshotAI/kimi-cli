/**
 * Agent inheritance chain resolution — Slice 3.1.
 *
 * Resolves an agent's `inherits` chain by recursively loading parent
 * agents and deep-merging their specs. Child values override parent
 * values; `undefined` fields in the child inherit from the parent.
 *
 * Cycle detection: tracks visited agent names and throws
 * `AgentInheritanceCycleError` if a name is seen twice.
 */

import { AgentInheritanceCycleError } from './errors.js';
import type { AgentSpec, SkillFilter, ToolFilter } from './types.js';

/**
 * Lookup function provided by the registry to resolve a parent agent
 * spec by name. This decouples `inherit.ts` from the registry itself,
 * making it testable without wiring up the full AgentRegistry.
 */
export type AgentLookup = (name: string) => AgentSpec | undefined;

/**
 * Resolve the full inheritance chain for an `AgentSpec`.
 *
 * @param spec  — the child spec (may have `inherits` set)
 * @param lookup — function to resolve parent by name
 * @returns A fully-merged AgentSpec with `inherits` cleared.
 */
export function resolveInheritance(spec: AgentSpec, lookup: AgentLookup): AgentSpec {
  return resolveChain(spec, lookup, []);
}

function resolveChain(spec: AgentSpec, lookup: AgentLookup, visited: string[]): AgentSpec {
  if (spec.inherits === undefined) return spec;

  const parentName = spec.inherits;
  const path = [...visited, spec.name];

  // Cycle detection
  if (path.includes(parentName)) {
    throw new AgentInheritanceCycleError([...path, parentName]);
  }

  const parent = lookup(parentName);
  if (parent === undefined) {
    // Parent not found — return spec as-is without inheritance
    return { ...spec, inherits: undefined };
  }

  // Recursively resolve the parent first
  const resolvedParent = resolveChain(parent, lookup, path);

  // Merge: child overrides parent
  return mergeSpecs(resolvedParent, spec);
}

/**
 * Deep merge two AgentSpecs. Child fields take precedence; parent
 * fields fill in where child has `undefined`. The `inherits` field
 * is cleared on the result.
 */
function mergeSpecs(parent: AgentSpec, child: AgentSpec): AgentSpec {
  let systemPrompt = child.systemPrompt ?? parent.systemPrompt;
  let systemPromptPath = child.systemPromptPath ?? parent.systemPromptPath;

  // When child explicitly sets one prompt source, clear the other
  // (inherited from parent) so assembleSystemPrompt picks the
  // child's intent, not the parent's stale field.
  if (child.systemPromptPath !== undefined && child.systemPrompt === undefined) {
    systemPrompt = undefined;
  } else if (child.systemPrompt !== undefined && child.systemPromptPath === undefined) {
    systemPromptPath = undefined;
  }

  return {
    name: child.name,
    description: child.description ?? parent.description,
    systemPrompt,
    systemPromptPath,
    model: child.model ?? parent.model,
    thinkingMode: child.thinkingMode ?? parent.thinkingMode,
    thinkingEffort: child.thinkingEffort ?? parent.thinkingEffort,
    tools: mergeFilter(parent.tools, child.tools),
    skills: mergeFilter(parent.skills, child.skills),
    inherits: undefined,
  };
}

/**
 * Merge filter: if child defines a filter, it replaces the parent's
 * entirely (not array-merged). This matches the Python semantics
 * where tools/allowed_tools/exclude_tools fully override.
 */
function mergeFilter<T extends ToolFilter | SkillFilter>(
  parent: T | undefined,
  child: T | undefined,
): T | undefined {
  if (child !== undefined) return child;
  return parent;
}
