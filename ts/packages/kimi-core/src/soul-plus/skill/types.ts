/**
 * Skill system types — Slice 2.5 (v2 §9A).
 *
 * Scope: inline prompt injection only. Fork mode / TurnOverrides
 * enforcement / `type: flow` execution are explicitly out of scope
 * (see Slice 2.5 D3 / D4). The `allowedTools` field is parsed and
 * carried on `SkillDefinition` for forward compatibility but is not
 * enforced at activation time.
 */

import type { FullContextState } from '../../storage/context-state.js';

export type SkillSource = 'builtin' | 'user' | 'project';

/**
 * Raw frontmatter of a SKILL.md file, after kebab/snake → camelCase
 * normalisation. Unknown fields are preserved via the index signature
 * so forward-compatible parsers can inspect them without the scanner
 * rejecting the skill.
 */
export interface SkillMetadata {
  readonly name?: string;
  readonly description?: string;
  /** Python supports `standard` / `flow`; Slice 2.5 only ships `prompt`. */
  readonly type?: string;
  /** Forward-compat: parsed but not enforced in Slice 2.5 (D4). */
  readonly allowedTools?: readonly string[];
  readonly [key: string]: unknown;
}

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  /**
   * Canonical absolute path to the SKILL.md file (after `fs.realpath`).
   * Symlinked skill roots resolve to their real paths so the Phase 1
   * path-guard — which compares canonical paths — accepts Read/Glob
   * calls against them.
   */
  readonly path: string;
  /** SKILL.md body with frontmatter stripped. Trimmed of leading/trailing whitespace. */
  readonly content: string;
  readonly metadata: SkillMetadata;
  readonly source: SkillSource;
}

/**
 * A single skill-root directory after scanner-level canonicalisation.
 * Returned by `resolveSkillRoots` and consumed by `discoverSkills`.
 */
export interface SkillRoot {
  /** Canonical absolute path to the root directory (e.g. `~/.kimi/skills`). */
  readonly path: string;
  readonly source: SkillSource;
}

export interface SkillActivationContext {
  readonly contextState: FullContextState;
}

export interface SkillManager {
  /** Returns the skill with the given normalised name, or `undefined`. */
  getSkill(name: string): SkillDefinition | undefined;
  /** Returns all registered skills sorted by name. */
  listSkills(): readonly SkillDefinition[];
  /**
   * Activate a skill by name. Inline mode only: appends
   * `content + "\n\nUser request:\n" + args` as a user message on
   * the caller's ContextState. Throws `SkillNotFoundError` if the
   * skill is not registered.
   */
  activate(name: string, args: string, context: SkillActivationContext): Promise<void>;
  /**
   * Register a skill provided by host code (not from a filesystem
   * scan). Later built-in registrations replace earlier ones with the
   * same name (host has full control); filesystem-scanned skills
   * always win over host-registered ones because `init` runs the
   * filesystem scan last (first-wins from the outer-most source).
   *
   * Intended as a hook for plugin systems that want to inject
   * package-code skills at runtime. Slice 2.5 does not use it
   * internally.
   */
  registerBuiltinSkill(skill: SkillDefinition): void;
  /**
   * Returns the canonical skill-root paths (builtin + discovered
   * filesystem roots). Callers should merge these into
   * `WorkspaceConfig.additionalDirs` so Phase 1 path-guard accepts
   * Read/Glob against them.
   *
   * Roots that sit inside the workspace are filtered out by the
   * caller (see `extendWorkspaceWithSkillRoots`) to avoid duplicate
   * entries in the config.
   */
  getSkillRoots(): readonly string[];
  /**
   * Returns a markdown-formatted description of all registered
   * skills, suitable for injection into a system prompt via a
   * `${KIMI_SKILLS}` template variable. kimi-core does NOT modify
   * system prompts itself — upper layers (SoulPlus consumers) call
   * this and wire it into their prompt template.
   *
   * Format mirrors Python `soul/agent.py:249-256`:
   *
   *     - name
   *       - Path: /abs/path/to/skill-dir
   *       - Description: short description
   */
  getKimiSkillsDescription(): string;
}

export class SkillNotFoundError extends Error {
  readonly skillName: string;
  constructor(skillName: string) {
    super(`Skill "${skillName}" is not registered`);
    this.name = 'SkillNotFoundError';
    this.skillName = skillName;
  }
}

/**
 * Normalise a skill name for lookup. Matches Python `casefold()`
 * — JS has no casefold, so we use `toLowerCase()` which is the
 * practical equivalent for ASCII skill names.
 */
export function normalizeSkillName(name: string): string {
  return name.toLowerCase();
}
