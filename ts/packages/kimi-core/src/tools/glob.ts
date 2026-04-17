/**
 * GlobTool — file pattern matching (§9-F / Appendix E.6).
 *
 * Finds files matching a glob pattern, returned sorted by modification
 * time (most recent first). Uses `kaos.glob`.
 *
 * Safety rails (ports Python `glob.py:48-84, 141-149`):
 *   - `pattern` starting with `**` is rejected (would recurse the whole
 *     filesystem / every `node_modules`)
 *   - `path` is validated against the workspace (cannot search `/`, `/etc`,
 *     or any directory outside the configured workspace)
 *   - match count is capped at `MAX_MATCHES`; iteration stops early to
 *     bound memory and to limit damage from symlink loops in the kaos
 *     `_globWalk` (which currently follows symlinks via `stat`)
 */

import type { Kaos } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type { ToolResult, ToolUpdate } from '../soul/types.js';
import { PathSecurityError, assertPathAllowed } from './path-guard.js';
import { GlobInputSchema } from './types.js';
import type { BuiltinTool, GlobInput, GlobOutput } from './types.js';
import type { WorkspaceConfig } from './workspace.js';

export const MAX_MATCHES = 1000;

export class GlobTool implements BuiltinTool<GlobInput, GlobOutput> {
  readonly name = 'Glob' as const;
  readonly description = 'Find files by glob pattern, sorted by modification time.';
  readonly inputSchema: z.ZodType<GlobInput> = GlobInputSchema;
  // Phase 15 L14 — read-only; safe to prefetch under streaming.
  readonly isConcurrencySafe = (): boolean => true;

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
    if (args.pattern.startsWith('**')) {
      const dirs = [this.workspace.workspaceDir, ...this.workspace.additionalDirs];
      const dirList = dirs.map((d) => `  - ${d}`).join('\n');
      return {
        isError: true,
        content:
          `Pattern "${args.pattern}" starts with "**" which is not allowed. ` +
          `A leading "**" would recursively search every directory (including large ` +
          `trees like node_modules) and can trigger symlink loops. Use a more ` +
          `specific pattern such as "src/**/*.ts" instead.\n\nSearchable roots:\n${dirList}`,
      };
    }

    let safePath: string;
    try {
      const rawPath = args.path ?? this.workspace.workspaceDir;
      safePath = assertPathAllowed(rawPath, this.workspace.workspaceDir, this.workspace, {
        mode: 'search',
        checkSensitive: false,
      });
    } catch (error) {
      if (error instanceof PathSecurityError) {
        return { isError: true, content: error.message };
      }
      throw error;
    }

    try {
      const entries: Array<{ path: string; mtime: number }> = [];
      let truncated = false;

      for await (const filePath of this.kaos.glob(safePath, args.pattern)) {
        if (entries.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        let mtime = 0;
        try {
          const st = await this.kaos.stat(filePath);
          mtime = st.stMtime ?? 0;
        } catch {
          // stat failure — use 0 mtime so the file still appears in results
        }
        entries.push({ path: filePath, mtime });
      }

      entries.sort((a, b) => b.mtime - a.mtime);
      const paths = entries.map((e) => e.path);

      const header = truncated
        ? `[Truncated at ${String(MAX_MATCHES)} matches — use a more specific pattern]\n`
        : '';
      return {
        content: header + paths.join('\n'),
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
