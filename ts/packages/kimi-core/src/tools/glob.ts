/**
 * GlobTool — file pattern matching (§9-F / Appendix E.6).
 *
 * Finds files matching a glob pattern, returned sorted by modification
 * time (most recent first). Uses `kaos.glob`.
 *
 * Output convention (ports Python `glob.py:149`): `content` shown to the
 * LLM is relativized to the search base to save tokens; `output.paths`
 * keeps absolute paths so downstream Read/Edit can consume them directly.
 *
 * Safety rails:
 *   - Pure-wildcard patterns (nothing but `*` / `?` / `/`) are rejected
 *     because they would enumerate every file under the search root and
 *     invite symlink loops. Examples: `**`, `** / *`, `** / **`, `* / *`.
 *     Constrained patterns (with any literal anchor such as an extension
 *     or subdirectory) are allowed — the literal bounds the result set,
 *     and the search base is already clamped to the workspace by
 *     `assertPathAllowed`, so `**` cannot escape the workspace.
 *   - Patterns using brace expansion (`{a,b,c}`) are rejected up-front
 *     because the underlying `_globWalk` treats `{` / `}` as literals,
 *     so such patterns would silently match zero files.
 *   - `path` is validated against the workspace (cannot search `/`, `/etc`,
 *     or any directory outside the configured workspace)
 *   - match count is capped at `MAX_MATCHES`; a separate `YIELD_SAFETY_CAP`
 *     (MAX_MATCHES × 2) on the raw yield stream keeps symlink loops in
 *     the kaos `_globWalk` from spinning forever even when the unique
 *     cap would never trip.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type { ToolResult, ToolUpdate, ToolMetadata } from '../soul/types.js';
import { listDirectory } from './list-directory.js';
import { PathSecurityError, assertPathAllowed } from './path-guard.js';
import { GlobInputSchema } from './types.js';
import type { BuiltinTool, GlobInput, GlobOutput } from './types.js';
import type { WorkspaceConfig } from './workspace.js';

export const MAX_MATCHES = 1000;

export class GlobTool implements BuiltinTool<GlobInput, GlobOutput> {
  readonly name = 'Glob' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description = 'Find files by glob pattern, sorted by modification time.';
  readonly inputSchema: z.ZodType<GlobInput> = GlobInputSchema;
  // Phase 15 L14 — read-only; safe to prefetch under streaming.
  readonly isConcurrencySafe = (_input: unknown): boolean => true;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {}

  async execute(
    _toolCallId: string,
    args: GlobInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<GlobOutput>> {
    if (isPureWildcard(args.pattern)) {
      const dirs = [this.workspace.workspaceDir, ...this.workspace.additionalDirs];
      const dirList = dirs.map((d) => `  - ${d}`).join('\n');
      let tree: string;
      try {
        tree = await listDirectory(this.kaos, this.workspace.workspaceDir);
      } catch {
        tree = '(listing unavailable)';
      }
      return {
        isError: true,
        content:
          `Pattern "${args.pattern}" is a pure wildcard (only \`*\`, \`?\`, \`**\`, \`/\`) ` +
          `and would enumerate every file under the search root, which can trigger ` +
          `symlink loops and exhaust memory. Add a literal anchor — e.g. an extension ` +
          `("${args.pattern === '**' || args.pattern === '**/*' ? '**/*.ts' : '**/*.md'}") ` +
          `or a subdirectory ("src/**/*.ts") — to bound the result set.\n\n` +
          `Searchable roots:\n${dirList}\n\n` +
          `Top of ${this.workspace.workspaceDir}:\n${tree}`,
      };
    }

    if (containsBraceExpansion(args.pattern)) {
      return {
        isError: true,
        content:
          `Pattern "${args.pattern}" uses brace expansion (\`{a,b,...}\`), which ` +
          `is not supported by this Glob tool. Split it into separate calls, ` +
          `one pattern per alternative. For example, instead of "*.{ts,tsx}" ` +
          `issue two calls: "*.ts" and "*.tsx".`,
      };
    }

    // Determine the search roots.
    //   - If `args.path` is given: exactly that path (after workspace check).
    //   - If not: every allowed root (primary + additionalDirs) so monorepo
    //     users don't have to list each sibling package manually.
    let searchRoots: string[];
    if (args.path !== undefined) {
      try {
        const safe = assertPathAllowed(
          args.path,
          this.workspace.workspaceDir,
          this.workspace,
          { mode: 'search', checkSensitive: false },
        );
        searchRoots = [safe];
      } catch (error) {
        if (error instanceof PathSecurityError) {
          return { isError: true, content: error.message };
        }
        throw error;
      }
    } else {
      searchRoots = [this.workspace.workspaceDir, ...this.workspace.additionalDirs];
    }

    try {
      // Two counters, two jobs:
      //   - `entries.length` caps the *unique* paths we return, so a
      //     truncation warning only fires after MAX_MATCHES real hits
      //     (overlapping roots that surface the same file don't inflate
      //     the count and prematurely trip the cap).
      //   - `yielded` counts every path the kaos stream emits, including
      //     duplicates. It's a safety belt against symlink-driven loops
      //     in `_globWalk`: a cycle keeps re-yielding the same file, so
      //     the unique cap would never fire, but `yielded` would.
      const seen = new Set<string>();
      const entries: Array<{ path: string; mtime: number }> = [];
      const YIELD_SAFETY_CAP = MAX_MATCHES * 2;
      let yielded = 0;
      let truncated = false;

      outer: for (const root of searchRoots) {
        for await (const filePath of this.kaos.glob(root, args.pattern)) {
          yielded++;
          if (yielded >= YIELD_SAFETY_CAP) {
            truncated = true;
            break outer;
          }
          if (seen.has(filePath)) continue;
          if (entries.length >= MAX_MATCHES) {
            truncated = true;
            break outer;
          }
          seen.add(filePath);
          let mtime = 0;
          try {
            const st = await this.kaos.stat(filePath);
            mtime = st.stMtime ?? 0;
          } catch {
            // stat failure — use 0 mtime so the file still appears in results
          }
          entries.push({ path: filePath, mtime });
        }
      }

      entries.sort((a, b) => b.mtime - a.mtime);

      const paths = entries.map((e) => e.path);
      // Content shown to the LLM uses paths relative to the search base
      // to save tokens; `output.paths` keeps the absolute form so callers
      // can feed them into Read/Edit without further resolution. When
      // multiple roots are searched the match set can span roots, so we
      // skip relativization in that case.
      const relBase = searchRoots.length === 1 ? searchRoots[0] : undefined;
      const displayLines = paths.map((p) =>
        relBase !== undefined ? relativizeIfUnder(p, relBase) : p,
      );

      const header = truncated
        ? `[Truncated at ${String(MAX_MATCHES)} matches — use a more specific pattern]\n`
        : '';
      return {
        content: header + displayLines.join('\n'),
        output: { paths },
      };
    } catch (error) {
      return { isError: true, content: error instanceof Error ? error.message : String(error) };
    }
  }

  getActivityDescription(args: GlobInput): string {
    return `Searching ${args.pattern}`;
  }
}

/**
 * If `candidate` is under `base`, return the portion after `base/`.
 * Otherwise return `candidate` unchanged (absolute). Both arguments
 * should be canonical absolute paths.
 */
function relativizeIfUnder(candidate: string, base: string): string {
  const sep = '/';
  if (candidate === base) return '.';
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (candidate.startsWith(prefix)) {
    return candidate.slice(prefix.length);
  }
  return candidate;
}

/**
 * Return true if `pattern` is pure wildcards — only `*`, `?`, `**`, `/`.
 * Such patterns have no literal anchor and would enumerate every file
 * under the search root. Backslash-escaped characters (`\X`) count as
 * literals so `\*` or `\?` still means "pattern has an anchor".
 */
function isPureWildcard(pattern: string): boolean {
  if (pattern === '') return false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      // escaped literal — pattern has an anchor
      return false;
    }
    if (ch !== '*' && ch !== '?' && ch !== '/') {
      return false;
    }
  }
  return true;
}

/** Return true iff `pattern` looks like it uses `{a,b,c}` brace expansion. */
function containsBraceExpansion(pattern: string): boolean {
  let inBrace = false;
  let sawCommaInsideBrace = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      i++;
      continue;
    }
    if (ch === '{') {
      inBrace = true;
      sawCommaInsideBrace = false;
      continue;
    }
    if (ch === '}') {
      if (inBrace && sawCommaInsideBrace) return true;
      inBrace = false;
      continue;
    }
    if (ch === ',' && inBrace) sawCommaInsideBrace = true;
  }
  return false;
}
