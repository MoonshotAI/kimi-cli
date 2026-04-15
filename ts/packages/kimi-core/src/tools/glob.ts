/**
 * GlobTool — file pattern matching (§9-F / Appendix E.6).
 *
 * Finds files matching a glob pattern, returned sorted by modification time
 * (most recent first). Uses Kaos.glob or shells out to `find`.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type { ToolResult, ToolUpdate } from '../soul/types.js';
import { GlobInputSchema } from './types.js';
import type { BuiltinTool, GlobInput, GlobOutput } from './types.js';

export class GlobTool implements BuiltinTool<GlobInput, GlobOutput> {
  readonly name = 'Glob' as const;
  readonly description = 'Find files by glob pattern, sorted by modification time.';
  readonly inputSchema: z.ZodType<GlobInput> = GlobInputSchema;

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
  ) {}

  async execute(
    _toolCallId: string,
    args: GlobInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<GlobOutput>> {
    try {
      const basePath = args.path ?? this.cwd;
      const entries: Array<{ path: string; mtime: number }> = [];

      for await (const filePath of this.kaos.glob(basePath, args.pattern)) {
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

      return {
        content: paths.join('\n'),
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
