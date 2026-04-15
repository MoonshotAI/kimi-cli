/**
 * GrepTool — content search via ripgrep (§9-F / Appendix E.5).
 *
 * Shells out to `rg` through Kaos. Supports glob/type filtering, context
 * lines, output modes, head_limit, multiline, and case-insensitive search.
 */

import { text } from 'node:stream/consumers';

import type { Kaos } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type { ToolResult, ToolUpdate } from '../soul/types.js';
import { GrepInputSchema } from './types.js';
import type { BuiltinTool, GrepInput, GrepOutput } from './types.js';

export class GrepTool implements BuiltinTool<GrepInput, GrepOutput> {
  readonly name = 'Grep' as const;
  readonly description = 'Search file contents using regular expressions (powered by ripgrep).';
  readonly inputSchema: z.ZodType<GrepInput> = GrepInputSchema;

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
  ) {}

  async execute(
    _toolCallId: string,
    args: GrepInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<GrepOutput>> {
    try {
      const rgArgs = buildRgArgs(args, this.cwd);
      const proc = await this.kaos.exec(...rgArgs);
      const [stdout, , exitCode] = await Promise.all([
        text(proc.stdout),
        text(proc.stderr),
        proc.wait(),
      ]);

      // rg exit codes: 0=matches found, 1=no matches, 2=error
      if (exitCode === 2) {
        return { isError: true, content: 'ripgrep error' };
      }

      const mode = args.output_mode ?? 'files_with_matches';
      const trimmed = stdout.trim();
      const lines = trimmed === '' ? [] : trimmed.split('\n');

      if (mode === 'files_with_matches') {
        return {
          content: trimmed,
          output: { mode, numFiles: lines.length, filenames: lines },
        };
      }
      if (mode === 'count') {
        const total = lines.reduce((sum, l) => {
          const parts = l.split(':');
          const n = Number.parseInt(parts.at(-1) ?? '0', 10);
          return sum + (Number.isNaN(n) ? 0 : n);
        }, 0);
        const fileSet = new Set(lines.map((l) => l.split(':')[0] ?? ''));
        return {
          content: trimmed,
          output: { mode, numFiles: fileSet.size, filenames: [...fileSet], numMatches: total },
        };
      }

      // content mode
      const fileSet = new Set<string>();
      for (const line of lines) {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) fileSet.add(line.slice(0, colonIdx));
      }
      return {
        content: trimmed,
        output: {
          mode: 'content',
          numFiles: fileSet.size,
          filenames: [...fileSet],
          content: trimmed,
          numLines: lines.length,
          ...(args.head_limit !== undefined
            ? { appliedLimit: Math.min(args.head_limit, lines.length) }
            : {}),
        },
      };
    } catch (error) {
      return { isError: true, content: error instanceof Error ? error.message : String(error) };
    }
  }

  getActivityDescription(args: GrepInput): string {
    const searchPath = args.path ?? '.';
    return `Searching for '${args.pattern}' in ${searchPath}`;
  }
}

function buildRgArgs(args: GrepInput, cwd: string): string[] {
  const cmd: string[] = ['rg'];

  const mode = args.output_mode ?? 'files_with_matches';
  if (mode === 'files_with_matches') cmd.push('-l');
  else if (mode === 'count') cmd.push('-c');

  if (args['-i']) cmd.push('-i');
  if (args['-n'] !== false && mode === 'content') cmd.push('-n');
  if (args['-A'] !== undefined) cmd.push('-A', String(args['-A']));
  if (args['-B'] !== undefined) cmd.push('-B', String(args['-B']));
  if (args['-C'] !== undefined) cmd.push('-C', String(args['-C']));
  if (args.glob !== undefined) cmd.push('--glob', args.glob);
  if (args.type !== undefined) cmd.push('--type', args.type);
  if (args.multiline) cmd.push('-U', '--multiline-dotall');
  if (args.head_limit !== undefined) cmd.push('--max-count', String(args.head_limit));

  cmd.push('--', args.pattern, args.path ?? cwd);
  return cmd;
}
