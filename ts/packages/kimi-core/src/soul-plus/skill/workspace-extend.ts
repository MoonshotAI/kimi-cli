/**
 * WorkspaceConfig helper — Slice 2.5 P0-3.
 *
 * Skill roots that sit **outside** the workspace must be added to
 * `WorkspaceConfig.additionalDirs`; otherwise the Phase 1 path-guard
 * rejects Read/Glob calls against `SKILL.md` files when the LLM
 * follows a `${KIMI_SKILLS}` pointer. Roots that already sit inside
 * the workspace are filtered out to avoid duplicate entries in
 * `additionalDirs` (the guard already treats them as within the
 * primary `workspaceDir`).
 *
 * kimi-core does not mutate `WorkspaceConfig` directly — callers
 * hold the config and decide how to extend it. This helper
 * returns a fresh config so the tool wiring at application startup
 * can pass the extended shape into each tool's constructor.
 */

import { isWithinDirectory } from '../../tools/path-guard.js';
import type { WorkspaceConfig } from '../../tools/workspace.js';

/**
 * Return a new `WorkspaceConfig` whose `additionalDirs` also
 * contains every skill root that is **not** already within the
 * workspace. Roots that are equal to `workspaceDir` or are
 * descendants of it are skipped — adding them would be redundant.
 *
 * Roots that are duplicates of existing `additionalDirs` entries
 * are also skipped so repeat invocations stay idempotent.
 */
export function extendWorkspaceWithSkillRoots(
  workspace: WorkspaceConfig,
  skillRoots: readonly string[],
): WorkspaceConfig {
  const seen = new Set<string>(workspace.additionalDirs);
  const extra: string[] = [];
  for (const root of skillRoots) {
    if (isWithinDirectory(root, workspace.workspaceDir)) continue;
    let alreadyCovered = false;
    for (const existing of workspace.additionalDirs) {
      if (isWithinDirectory(root, existing)) {
        alreadyCovered = true;
        break;
      }
    }
    if (alreadyCovered) continue;
    if (seen.has(root)) continue;
    seen.add(root);
    extra.push(root);
  }
  if (extra.length === 0) return workspace;
  return {
    workspaceDir: workspace.workspaceDir,
    additionalDirs: [...workspace.additionalDirs, ...extra],
  };
}
