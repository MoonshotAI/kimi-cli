/**
 * workspace-monorepo — auto-discover sibling packages in a pnpm / npm /
 * yarn monorepo and add them to WorkspaceConfig.additionalDirs.
 *
 * Rationale: when the user starts kimi-cli inside one package of a
 * monorepo (e.g. `ts/apps/kimi-cli`), the path-guard otherwise rejects
 * any cross-package access (e.g. `ts/packages/kimi-core/src/...`), and
 * sub-agents tasked with exploring the full codebase hit "outside the
 * workspace" on every sibling. Treating siblings as additionalDirs lets
 * Read/Glob/Grep work across the whole repo without forcing the user
 * to enumerate every package via `--add-dir`.
 *
 * Detection:
 *   - Walk up from `workDir` (up to MAX_PARENT_WALK levels) looking for
 *     `pnpm-workspace.yaml`, or a `package.json` containing a
 *     `workspaces` field (npm / yarn).
 *   - Parse the packages globs (strings like `packages/*`, `apps/*`).
 *   - Expand each glob relative to the monorepo root using fs.readdir,
 *     filtering to directories. Only trailing `/*` and `/**` patterns
 *     are expanded; plain directories are kept literally; anything more
 *     exotic is skipped.
 *
 * Output:
 *   - Paths that are `workDir` itself or live inside it are filtered out
 *     (the primary workspace already covers them).
 *   - Duplicates and paths already covered by an existing additionalDir
 *     are filtered out (same rule as workspace-extend.ts).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { isWithinDirectory } from './path-guard.js';
import type { WorkspaceConfig } from './workspace.js';

const MAX_PARENT_WALK = 5;

export interface MonorepoDiscoveryResult {
  readonly root: string;
  readonly siblings: readonly string[];
}

/**
 * Walk up from `startDir` looking for a pnpm / npm / yarn monorepo root.
 * Returns the root path and an unfiltered list of sibling package
 * directories (absolute, canonical). Returns `undefined` if no monorepo
 * manifest is found within MAX_PARENT_WALK levels.
 */
export function discoverMonorepoSiblings(
  startDir: string,
): MonorepoDiscoveryResult | undefined {
  let dir = resolve(startDir);
  for (let i = 0; i <= MAX_PARENT_WALK; i++) {
    const pnpmPath = join(dir, 'pnpm-workspace.yaml');
    if (existsSync(pnpmPath)) {
      try {
        const globs = parsePnpmWorkspaces(readFileSync(pnpmPath, 'utf8'));
        return { root: dir, siblings: expandPackageGlobs(dir, globs) };
      } catch {
        /* malformed yaml — fall through to the next candidate */
      }
    }
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          workspaces?: unknown;
        };
        const globs = extractNpmWorkspaces(pkg.workspaces);
        if (globs !== undefined) {
          return { root: dir, siblings: expandPackageGlobs(dir, globs) };
        }
      } catch {
        /* malformed json — skip */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Parse the minimal subset of pnpm-workspace.yaml we need: the
 * top-level `packages:` list of strings. Anything exotic falls back to
 * returning `[]` (no siblings discovered).
 */
function parsePnpmWorkspaces(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const result: string[] = [];
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (/^[a-zA-Z_][a-zA-Z0-9_-]*\s*:/.test(line) && !/^\s/.test(line)) {
        break;
      }
      const m = line.match(/^\s+-\s+['"]?([^'"#\s]+)['"]?\s*$/);
      if (m?.[1]) result.push(m[1]);
    }
  }
  return result;
}

function extractNpmWorkspaces(workspaces: unknown): string[] | undefined {
  if (Array.isArray(workspaces)) {
    return workspaces.filter((x): x is string => typeof x === 'string');
  }
  if (
    typeof workspaces === 'object' &&
    workspaces !== null &&
    'packages' in workspaces &&
    Array.isArray((workspaces as { packages: unknown }).packages)
  ) {
    return (workspaces as { packages: unknown[] }).packages.filter(
      (x): x is string => typeof x === 'string',
    );
  }
  return undefined;
}

/**
 * Expand glob-ish package entries into concrete directory paths.
 * Supported shapes:
 *   - `packages/*`            → every immediate child of packages/
 *   - `packages/**`           → treated as `*` (no deep recursion)
 *   - `packages/foo`          → literal path (must be a directory)
 *   - `packages/foo-*`        → prefix match within packages/
 * Anything more exotic (e.g. nested globs) is skipped.
 */
function expandPackageGlobs(root: string, globs: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of globs) {
    if (g === '' || g.startsWith('!')) continue;
    const parts = g.split('/');
    const last = parts[parts.length - 1];
    if (last === undefined) continue;

    const prefixPath = resolve(root, parts.slice(0, -1).join('/') || '.');

    if (last === '*' || last === '**') {
      let names: string[];
      try {
        names = readdirSync(prefixPath);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = join(prefixPath, name);
        try {
          if (statSync(full).isDirectory()) out.push(full);
        } catch {
          /* broken symlink — skip */
        }
      }
    } else if (last.includes('*')) {
      const regex = new RegExp(
        '^' + last.split('*').map(escapeRegex).join('.*') + '$',
      );
      let names: string[];
      try {
        names = readdirSync(prefixPath);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!regex.test(name)) continue;
        const full = join(prefixPath, name);
        try {
          if (statSync(full).isDirectory()) out.push(full);
        } catch {
          /* skip */
        }
      }
    } else {
      const full = resolve(root, g);
      try {
        if (statSync(full).isDirectory()) out.push(full);
      } catch {
        /* missing package — skip */
      }
    }
  }
  return [...new Set(out)].sort();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Given a starting WorkspaceConfig and a workDir, extend additionalDirs
 * with every discovered monorepo sibling package that:
 *   - is not `workDir` itself
 *   - does not live under `workDir`
 *   - is not already covered by an existing additionalDir
 */
export function extendWorkspaceWithMonorepoSiblings(
  workspace: WorkspaceConfig,
  workDir: string,
): WorkspaceConfig {
  const discovery = discoverMonorepoSiblings(workDir);
  if (discovery === undefined) return workspace;

  const resolvedWorkDir = resolve(workDir);
  const seen = new Set<string>(workspace.additionalDirs);
  const extra: string[] = [];
  for (const sibling of discovery.siblings) {
    if (sibling === resolvedWorkDir) continue;
    if (isWithinDirectory(sibling, resolvedWorkDir)) continue;
    let alreadyCovered = false;
    for (const existing of workspace.additionalDirs) {
      if (isWithinDirectory(sibling, existing)) {
        alreadyCovered = true;
        break;
      }
    }
    if (alreadyCovered) continue;
    if (seen.has(sibling)) continue;
    seen.add(sibling);
    extra.push(sibling);
  }
  if (extra.length === 0) return workspace;
  return {
    workspaceDir: workspace.workspaceDir,
    additionalDirs: [...workspace.additionalDirs, ...extra],
  };
}
