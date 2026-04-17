/**
 * SKILL.md parser — Slice 2.5.
 *
 * Reads a skill directory, loads `SKILL.md`, extracts frontmatter,
 * maps kebab/snake → camelCase for known fields, and returns a
 * fully-resolved `SkillDefinition`. Unknown frontmatter keys are
 * preserved in `metadata` so future extensions can introspect them
 * without a parser change (V2 spec compatibility).
 *
 * `type: flow` is explicitly unsupported (D3). The parser still
 * accepts a SKILL.md with `type: flow` but marks it "unsupported" via
 * the returned value; the scanner logs a warning and drops the skill
 * instead of trying to execute a DAG.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { FrontmatterError, parseFrontmatter } from './frontmatter.js';
import type { SkillDefinition, SkillMetadata, SkillSource } from './types.js';

export class SkillParseError extends Error {
  readonly reason?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SkillParseError';
    if (cause !== undefined) this.reason = cause;
  }
}

/** Thrown when the skill declares `type: flow` — not supported in Slice 2.5. */
export class UnsupportedSkillTypeError extends Error {
  readonly skillType: string;
  constructor(skillType: string) {
    super(`Skill type "${skillType}" is not supported (Slice 2.5 only ships "prompt")`);
    this.name = 'UnsupportedSkillTypeError';
    this.skillType = skillType;
  }
}

export interface ParseSkillFromFileOptions {
  readonly skillMdPath: string;
  readonly skillDirName: string;
  readonly source: SkillSource;
}

/**
 * Load and parse a SKILL.md at `skillMdPath`. Returns a
 * `SkillDefinition` ready for registration.
 *
 * Throws:
 *   - `SkillParseError` on I/O errors, malformed frontmatter, or
 *     frontmatter whose root is not a mapping.
 *   - `UnsupportedSkillTypeError` when `type: flow` (or any non-prompt
 *     type) is declared. Callers should catch both, log a warning,
 *     and skip the skill.
 */
export async function parseSkillFromFile(
  opts: ParseSkillFromFileOptions,
): Promise<SkillDefinition> {
  let raw: string;
  try {
    raw = await readFile(opts.skillMdPath, 'utf8');
  } catch (error) {
    throw new SkillParseError(`Failed to read ${opts.skillMdPath}`, error);
  }

  let parsed;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw new SkillParseError(
        `Invalid frontmatter in ${opts.skillMdPath}: ${error.message}`,
        error,
      );
    }
    throw error;
  }

  const frontmatter = parsed.data ?? {};
  if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new SkillParseError(
      `Frontmatter in ${opts.skillMdPath} must be a mapping at the top level`,
    );
  }

  const metadata = normaliseMetadata(frontmatter);

  // Slice 2.5 D3: only `prompt` (or undeclared) is supported. `standard`
  // is accepted as an alias because Python SKILL.md files in the wild
  // default to `standard` — treat it as equivalent to `prompt` so
  // existing Python skills load unchanged.
  const skillType = metadata.type;
  if (skillType !== undefined && skillType !== 'prompt' && skillType !== 'standard') {
    throw new UnsupportedSkillTypeError(skillType);
  }

  const name =
    typeof metadata.name === 'string' && metadata.name.trim() !== ''
      ? metadata.name.trim()
      : opts.skillDirName;
  const description =
    typeof metadata.description === 'string' && metadata.description.trim() !== ''
      ? metadata.description.trim()
      : 'No description provided.';
  const content = parsed.body.trim();

  return {
    name,
    description,
    path: path.resolve(opts.skillMdPath),
    content,
    metadata,
    source: opts.source,
  };
}

/**
 * Known frontmatter keys that should be normalised to camelCase. A
 * kebab or snake variant on the input side is rewritten to the
 * canonical camelCase name so both Python-era and v2-era SKILL.md
 * files parse identically.
 */
const KNOWN_ALIASES: Record<string, string> = {
  'allowed-tools': 'allowedTools',
  allowed_tools: 'allowedTools',
  'disallowed-tools': 'disallowedTools',
  disallowed_tools: 'disallowedTools',
  // Slice 7.1 (决策 #99)
  'when-to-use': 'whenToUse',
  when_to_use: 'whenToUse',
  'disable-model-invocation': 'disableModelInvocation',
  disable_model_invocation: 'disableModelInvocation',
};

function normaliseMetadata(raw: Record<string, unknown>): SkillMetadata {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = KNOWN_ALIASES[rawKey] ?? rawKey;
    if (key === 'allowedTools' || key === 'disallowedTools') {
      out[key] = coerceStringList(value);
    } else {
      out[key] = value;
    }
  }
  return out as SkillMetadata;
}

function coerceStringList(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    // Support `allowed-tools: Bash` shorthand (Python SKILL.md rarely
    // does this but permissive parsing is cheaper than churn later).
    return [value];
  }
  return undefined;
}
