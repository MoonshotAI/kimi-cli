/**
 * Tool / Skill filtering — Slice 3.1.
 *
 * Applies `include` / `exclude` filters from an AgentSpec to the
 * tool and skill lists provided by the host. Used by the upper-layer
 * app when constructing `SoulPlusDeps.tools` and the SkillManager.
 *
 * Semantics:
 *   - If `filter` is undefined/null → return all items unchanged.
 *   - If `filter.include` is non-empty → only keep items whose name is in the list.
 *   - If `filter.exclude` is non-empty → remove items whose name is in the list.
 *   - If both `include` and `exclude` are set → include first, then exclude.
 */

import type { SkillDefinition } from '../soul-plus/skill/types.js';
import type { Tool } from '../soul/types.js';
import type { SkillFilter, ToolFilter } from './types.js';

export function applyToolFilter(tools: readonly Tool[], filter?: ToolFilter): readonly Tool[] {
  if (filter === undefined) return tools;
  let result: readonly Tool[] = tools;

  if (filter.include !== undefined && filter.include.length > 0) {
    const includeSet = new Set(filter.include);
    result = result.filter((t) => includeSet.has(t.name));
  }

  if (filter.exclude !== undefined && filter.exclude.length > 0) {
    const excludeSet = new Set(filter.exclude);
    result = result.filter((t) => !excludeSet.has(t.name));
  }

  return result;
}

export function applySkillFilter(
  skills: readonly SkillDefinition[],
  filter?: SkillFilter,
): readonly SkillDefinition[] {
  if (filter === undefined) return skills;
  let result: readonly SkillDefinition[] = skills;

  if (filter.include !== undefined && filter.include.length > 0) {
    const includeSet = new Set(filter.include);
    result = result.filter((s) => includeSet.has(s.name));
  }

  if (filter.exclude !== undefined && filter.exclude.length > 0) {
    const excludeSet = new Set(filter.exclude);
    result = result.filter((s) => !excludeSet.has(s.name));
  }

  return result;
}
