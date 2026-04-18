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
  // Phase 17 §B.5 — surface the raw mermaid flowchart body when the
  // skill's markdown contains one. Kept as a raw string so downstream
  // flow dispatch can parse it on demand.
  const mermaid = parseMermaidFlowchart(content);

  return {
    name,
    description,
    path: path.resolve(opts.skillMdPath),
    content,
    metadata,
    source: opts.source,
    ...(mermaid !== undefined ? { mermaid } : {}),
  };
}

/**
 * Phase 17 §B.5 — extract the raw body of the first ` ```mermaid ```
 * fenced block in `markdown`. Returns `undefined` when no such block
 * exists. Fence markers (``` ```mermaid / ``` ```) are stripped.
 */
export function parseMermaidFlowchart(markdown: string): string | undefined {
  const match = /```mermaid\r?\n([\s\S]*?)\r?\n```/.exec(markdown);
  if (match === null) return undefined;
  return match[1];
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

// ── Phase 18 §C.2 — skill parameter expansion ─────────────────────────

/** Context passed to {@link expandSkillParameters}. */
export interface SkillExpandContext {
  /** Canonical directory containing SKILL.md (for `${KIMI_SKILL_DIR}`). */
  readonly skillDir: string;
  /** Session id (for `${KIMI_SESSION_ID}`). */
  readonly sessionId: string;
  /**
   * Declared argument names from the skill's frontmatter (e.g.
   * `arguments: [message]`). When present, positional tokens are bound
   * in declaration order so `$message` resolves to the first token.
   */
  readonly argumentNames?: readonly string[];
}

/**
 * Expand skill template variables according to v2 §15.3:
 *
 *   | Variable              | Replacement                     |
 *   | --------------------- | ------------------------------- |
 *   | `$ARGUMENTS`          | full raw-args string            |
 *   | `$1`, `$2`, …         | space-split tokens (quote-aware)|
 *   | `$<name>`             | positional token by frontmatter |
 *   | `${KIMI_SKILL_DIR}`   | `ctx.skillDir`                  |
 *   | `${KIMI_SESSION_ID}`  | `ctx.sessionId`                 |
 *   | `\$1`                 | literal `$1` (escape)           |
 *
 * Word-boundary guard: `$N` / `$<name>` only match when the preceding
 * char is not `[A-Za-z0-9_]`, so embedded usages like `prefix$1suffix`
 * don't accidentally replace. Undefined placeholders are preserved
 * verbatim (Phase 1 intentionally does not throw).
 *
 * Single- vs multi-parameter binding (matches Python
 * `expand_template_variables` in `kimi_cli/skill/parser.py`):
 *   - When `argumentNames.length === 1`, the single name binds to the
 *     ENTIRE raw-args string (quotes preserved, whitespace preserved).
 *     This lets skills declare `arguments: [message]` and receive the
 *     whole user-typed tail as `$message`.
 *   - When `argumentNames.length > 1`, each name binds to a single
 *     tokenized arg (quote-aware split, quotes stripped). Tokens beyond
 *     `argumentNames.length` are only reachable via `$1`, `$2`, …
 *     positional references.
 */
export function expandSkillParameters(
  body: string,
  rawArgs: string,
  ctx: SkillExpandContext,
): string {
  const tokens = tokenizeArgs(rawArgs);
  const namedBindings = new Map<string, string>();
  if (ctx.argumentNames !== undefined) {
    if (ctx.argumentNames.length === 1 && ctx.argumentNames[0] !== undefined) {
      namedBindings.set(ctx.argumentNames[0], rawArgs);
    } else {
      for (let i = 0; i < ctx.argumentNames.length; i++) {
        const name = ctx.argumentNames[i];
        if (name === undefined) continue;
        namedBindings.set(name, tokens[i] ?? '');
      }
    }
  }

  const ESCAPE_SENTINEL = '\u0000\u0001KIMI_LITERAL_DOLLAR\u0001\u0000';
  let out = body.replaceAll('\\$', ESCAPE_SENTINEL);

  out = out.replaceAll('${KIMI_SKILL_DIR}', ctx.skillDir);
  out = out.replaceAll('${KIMI_SESSION_ID}', ctx.sessionId);

  out = out.replaceAll(
    /(^|[^A-Za-z0-9_])\$(ARGUMENTS|[A-Za-z_][A-Za-z0-9_]*|[0-9]+)/g,
    (match, prefix: string, name: string) => {
      if (name === 'ARGUMENTS') return `${prefix}${rawArgs}`;
      if (/^[0-9]+$/.test(name)) {
        const idx = Number.parseInt(name, 10);
        if (idx >= 1) {
          const token = tokens[idx - 1];
          if (token !== undefined) return `${prefix}${token}`;
          // Out-of-range positional: if the caller explicitly supplied
          // no args at all, collapse to the prefix (test 92 expects
          // `[$1]` -> `[]`). Otherwise preserve the placeholder so a
          // later `$5` referenced when only 2 tokens exist stays
          // literal (test 171).
          if (rawArgs.length === 0) return prefix;
          return match;
        }
        return match;
      }
      const bound = namedBindings.get(name);
      if (bound !== undefined) return `${prefix}${bound}`;
      return match;
    },
  );

  out = out.replaceAll(ESCAPE_SENTINEL, '$');
  return out;
}

/**
 * Shell-ish tokenizer: splits on ASCII whitespace while honouring
 * single- and double-quoted groups. Quotes are stripped from the
 * emitted token. Escape sequences inside quotes are intentionally
 * left verbatim (Phase 1: the skill author rarely needs them and the
 * surprise of `\n` inside `$1` disappearing is worse than the lack of
 * support).
 */
function tokenizeArgs(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuote: '"' | "'" | null = null;
  let hasContent = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === undefined) continue;
    if (inQuote !== null) {
      if (ch === inQuote) {
        inQuote = null;
        continue;
      }
      current += ch;
      hasContent = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      hasContent = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasContent) {
        out.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += ch;
    hasContent = true;
  }
  if (hasContent) out.push(current);
  return out;
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
