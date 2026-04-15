/**
 * extendWorkspaceWithSkillRoots — Slice 2.5 P0-3 regression.
 *
 * Ensures skill roots outside the workspace get added to
 * `additionalDirs`, while roots that already sit inside the
 * workspace are filtered out (the path-guard treats them as within
 * the primary workspaceDir automatically).
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { extendWorkspaceWithSkillRoots } from '../../../src/soul-plus/skill/index.js';
import type { WorkspaceConfig } from '../../../src/tools/workspace.js';

function makeConfig(workspaceDir: string, additionalDirs: readonly string[] = []): WorkspaceConfig {
  return { workspaceDir, additionalDirs };
}

describe('extendWorkspaceWithSkillRoots', () => {
  it('adds skill roots that sit outside the workspace', () => {
    const config = makeConfig('/home/me/project');
    const extended = extendWorkspaceWithSkillRoots(config, [
      '/home/me/.kimi/skills',
      '/usr/local/share/kimi/builtin-skills',
    ]);
    expect(extended.additionalDirs).toEqual([
      '/home/me/.kimi/skills',
      '/usr/local/share/kimi/builtin-skills',
    ]);
  });

  it('skips skill roots that are equal to or inside the workspace', () => {
    const config = makeConfig('/home/me/project');
    const extended = extendWorkspaceWithSkillRoots(config, [
      '/home/me/project', // exact
      '/home/me/project/.kimi/skills', // descendant
      '/home/me/.kimi/skills', // outside
    ]);
    expect(extended.additionalDirs).toEqual(['/home/me/.kimi/skills']);
  });

  it('is idempotent when a root is already in additionalDirs', () => {
    const config = makeConfig('/workspace', ['/home/me/.kimi/skills']);
    const extended = extendWorkspaceWithSkillRoots(config, ['/home/me/.kimi/skills']);
    expect(extended).toBe(config);
  });

  it('skips roots already covered by an existing additionalDirs entry', () => {
    const config = makeConfig('/workspace', ['/home/me']);
    const extended = extendWorkspaceWithSkillRoots(config, ['/home/me/.kimi/skills']);
    expect(extended).toBe(config);
  });

  it('returns the same config object when no extra entries are added', () => {
    const config = makeConfig('/ws');
    const extended = extendWorkspaceWithSkillRoots(config, ['/ws/inside']);
    expect(extended).toBe(config);
  });

  it('handles cross-platform path separators via path-guard', () => {
    // Regression: ensure isWithinDirectory treats the separator
    // properly rather than a naive string prefix. "/ws-evil" must
    // NOT be considered inside "/ws".
    const config = makeConfig('/ws');
    const extended = extendWorkspaceWithSkillRoots(config, ['/ws-evil']);
    expect(extended.additionalDirs).toEqual(['/ws-evil']);
    // Sanity
    expect(path.isAbsolute(extended.additionalDirs[0] ?? '')).toBe(true);
  });
});
