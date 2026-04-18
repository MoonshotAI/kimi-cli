/**
 * Skill filesystem scanner — Slice 2.5.
 *
 * Ports the layered discovery Python `skill/__init__.py:93-205` uses:
 *
 *   builtin → user (brand + generic, each independent) → project (brand + generic, each independent)
 *
 * **P0-1 regression** (Python commit `107965a2`): brand and generic
 * groups must be independently "take the first existing" — NOT the
 * entire candidate chain. Otherwise an empty user generic directory
 * shadows a populated user brand directory.
 *
 * **P0-2** (symlink canonicalisation): every discovered root is
 * resolved through `fs.realpath` so Phase 1 path-guard (which uses
 * lexical `path.normalize`) matches subsequent Read/Glob calls that
 * originate from the LLM.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UnsupportedSkillTypeError, SkillParseError, parseSkillFromFile } from './parser.js';
import type { SkillDefinition, SkillRoot, SkillSource } from './types.js';
import { normalizeSkillName } from './types.js';

// ── Candidate lists (mirror Python `_get_*_skills_dir_candidates`) ──

const USER_BRAND_DIRS: readonly string[] = ['.kimi/skills', '.claude/skills', '.codex/skills'];
const USER_GENERIC_DIRS: readonly string[] = ['.config/agents/skills', '.agents/skills'];
const PROJECT_BRAND_DIRS: readonly string[] = ['.kimi/skills', '.claude/skills', '.codex/skills'];
const PROJECT_GENERIC_DIRS: readonly string[] = ['.agents/skills'];

export interface ResolveSkillRootsOptions {
  /** Absolute path to the project / working directory. */
  readonly workDir: string;
  /**
   * Absolute path to the package-bundled built-in skill root (Slice
   * 2.5 D5). When `undefined`, built-in discovery is skipped.
   */
  readonly builtinDir?: string | undefined;
  /**
   * Explicit override list. When provided, user/project discovery is
   * skipped but the built-in directory is still prepended (matches
   * Python `resolve_skills_roots` with `skills_dirs=...`).
   */
  readonly explicitDirs?: readonly string[] | undefined;
  /** Override `os.homedir()` (injectable for tests). */
  readonly homeDir?: string | undefined;
  /** Injectable realpath (for deterministic symlink tests). */
  readonly realpath?: (p: string) => Promise<string>;
  /** Injectable "is existing directory" check. */
  readonly isDir?: (p: string) => Promise<boolean>;
}

/**
 * Resolve all skill roots in priority order. Each root is
 * canonicalised via `realpath` and tagged with its source layer.
 * Built-ins come first, then user, then project — this is the
 * "outer-first" order that pairs with first-wins merging in the
 * manager.
 */
export async function resolveSkillRoots(
  opts: ResolveSkillRootsOptions,
): Promise<readonly SkillRoot[]> {
  const home = opts.homeDir ?? os.homedir();
  const realpathImpl = opts.realpath ?? ((p: string) => fs.realpath(p));
  const isDirImpl = opts.isDir ?? defaultIsDir;
  const collected: SkillRoot[] = [];

  if (opts.builtinDir !== undefined && (await isDirImpl(opts.builtinDir))) {
    collected.push({
      path: await realpathImpl(opts.builtinDir),
      source: 'builtin',
    });
  }

  if (opts.explicitDirs !== undefined && opts.explicitDirs.length > 0) {
    for (const dir of opts.explicitDirs) {
      if (await isDirImpl(dir)) {
        collected.push({ path: await realpathImpl(dir), source: 'user' });
      }
    }
  } else {
    // P0-1: brand and generic groups are taken independently, then
    // merged. Never collapse the whole chain into "first existing".
    const userBrand = await firstExistingDir(
      USER_BRAND_DIRS.map((d) => path.join(home, d)),
      isDirImpl,
    );
    if (userBrand !== undefined) {
      collected.push({ path: await realpathImpl(userBrand), source: 'user' });
    }
    const userGeneric = await firstExistingDir(
      USER_GENERIC_DIRS.map((d) => path.join(home, d)),
      isDirImpl,
    );
    if (userGeneric !== undefined) {
      collected.push({ path: await realpathImpl(userGeneric), source: 'user' });
    }

    const projectBrand = await firstExistingDir(
      PROJECT_BRAND_DIRS.map((d) => path.join(opts.workDir, d)),
      isDirImpl,
    );
    if (projectBrand !== undefined) {
      collected.push({ path: await realpathImpl(projectBrand), source: 'project' });
    }
    const projectGeneric = await firstExistingDir(
      PROJECT_GENERIC_DIRS.map((d) => path.join(opts.workDir, d)),
      isDirImpl,
    );
    if (projectGeneric !== undefined) {
      collected.push({ path: await realpathImpl(projectGeneric), source: 'project' });
    }
  }

  return collected;
}

async function firstExistingDir(
  candidates: readonly string[],
  isDirImpl: (p: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isDirImpl(candidate)) return candidate;
  }
  return undefined;
}

async function defaultIsDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * A skill that was intentionally excluded from the registry because
 * its declared `type` is not in the supported set (currently only
 * `prompt` / `standard`). This is an expected, user-facing "feature
 * gap" rather than an error, so it is surfaced via a dedicated hook
 * instead of `onWarning` (which would spam stderr on every startup in
 * repos that carry `type: flow` skills).
 */
export interface SkippedByPolicy {
  readonly path: string;
  readonly type: string;
  readonly reason: string;
}

export interface DiscoverSkillsOptions {
  readonly roots: readonly SkillRoot[];
  /** Optional logger for parse-failure warnings. Defaults to no-op. */
  readonly onWarning?: (message: string, cause?: unknown) => void;
  /**
   * Called once per skill silently skipped because of an unsupported
   * `type` (e.g. `flow`). Separate from `onWarning` so hosts can batch
   * a single summary line instead of stderr-spamming.
   */
  readonly onSkippedByPolicy?: (info: SkippedByPolicy) => void;
  /** Injectable readdir (for tests). */
  readonly readdir?: (p: string) => Promise<string[]>;
  /** Injectable isFile check (for SKILL.md existence). */
  readonly isFile?: (p: string) => Promise<boolean>;
  /**
   * Override parser for tests. Real code uses `parseSkillFromFile`
   * directly.
   */
  readonly parse?: (args: {
    readonly skillMdPath: string;
    readonly skillDirName: string;
    readonly source: SkillSource;
  }) => Promise<SkillDefinition>;
}

/**
 * Walk a list of roots and return the merged skill set using
 * **first-wins + outer-first** semantics: the first skill seen for a
 * given (normalised) name wins, and roots are consumed in the order
 * returned by `resolveSkillRoots` (builtin → user → project). A
 * malformed SKILL.md is logged via `onWarning` and skipped — it must
 * never block session startup (P0-4).
 */
export async function discoverSkills(
  opts: DiscoverSkillsOptions,
): Promise<readonly SkillDefinition[]> {
  const readdirImpl = opts.readdir ?? ((p: string) => fs.readdir(p));
  const isFileImpl = opts.isFile ?? defaultIsFile;
  const parse = opts.parse ?? parseSkillFromFile;
  const warn = opts.onWarning ?? (() => {});
  const skipByPolicy = opts.onSkippedByPolicy ?? (() => {});

  const byName = new Map<string, SkillDefinition>();
  for (const root of opts.roots) {
    let entries: string[];
    try {
      entries = await readdirImpl(root.path);
    } catch (error) {
      warn(`Failed to read skill root ${root.path}`, error);
      continue;
    }
    for (const entry of entries) {
      const skillDir = path.join(root.path, entry);
      const skillMd = path.join(skillDir, 'SKILL.md');
      if (!(await isFileImpl(skillMd))) continue;
      try {
        const def = await parse({
          skillMdPath: skillMd,
          skillDirName: entry,
          source: root.source,
        });
        const key = normalizeSkillName(def.name);
        if (!byName.has(key)) {
          byName.set(key, def);
        }
      } catch (error) {
        if (error instanceof UnsupportedSkillTypeError) {
          // Policy skip — not an error. Host decides whether to surface
          // a summary (e.g. `--verbose`); default path is silent so
          // startup stays clean in repos that carry flow skills.
          skipByPolicy({
            path: skillMd,
            type: error.skillType,
            reason: `unsupported skill type "${error.skillType}"`,
          });
          continue;
        }
        if (error instanceof SkillParseError) {
          warn(`Skipping invalid skill at ${skillMd}: ${error.message}`, error);
          continue;
        }
        warn(`Skipping skill at ${skillMd} due to unexpected error`, error);
      }
    }
  }

  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

async function defaultIsFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}
