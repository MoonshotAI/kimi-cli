/**
 * Skill subsystem barrel — Slice 2.5 (v2 §9A).
 *
 * Re-exported from `src/soul-plus/index.ts` so external callers see
 * a flat `SkillManager` / `SkillDefinition` API without reaching
 * into the subdirectory.
 */

export type {
  SkillActivationContext,
  SkillDefinition,
  SkillManager,
  SkillMetadata,
  SkillRoot,
  SkillSource,
} from './types.js';
export { SkillNotFoundError, normalizeSkillName } from './types.js';

export { FrontmatterError, parseFrontmatter } from './frontmatter.js';
export type { ParsedFrontmatter } from './frontmatter.js';

export { SkillParseError, UnsupportedSkillTypeError, parseSkillFromFile } from './parser.js';
export type { ParseSkillFromFileOptions } from './parser.js';

export { discoverSkills, resolveSkillRoots } from './scanner.js';
export type {
  DiscoverSkillsOptions,
  ResolveSkillRootsOptions,
  SkippedByPolicy,
} from './scanner.js';

export { DefaultSkillManager, buildInlinePrompt } from './manager.js';
export type { SkillManagerOptions } from './manager.js';

export { extendWorkspaceWithSkillRoots } from './workspace-extend.js';
