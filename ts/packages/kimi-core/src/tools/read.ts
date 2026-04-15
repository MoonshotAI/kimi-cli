/**
 * ReadTool — read text file content with optional line range (§9-F / Appendix E.1).
 *
 * Dependencies injected via constructor (§9-F.3):
 *   - `Kaos` — file system abstraction (readText / readLines / stat)
 */

import type { Kaos } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type { ToolResult, ToolUpdate } from '../soul/types.js';
import { ReadInputSchema } from './types.js';
import type { BuiltinTool, ReadInput, ReadOutput } from './types.js';

export class ReadTool implements BuiltinTool<ReadInput, ReadOutput> {
  readonly name = 'Read' as const;
  readonly description = 'Read the contents of a file from the local filesystem.';
  readonly inputSchema: z.ZodType<ReadInput> = ReadInputSchema;

  constructor(private readonly kaos: Kaos) {}

  async execute(
    _toolCallId: string,
    args: ReadInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<ReadOutput>> {
    try {
      const raw = await this.kaos.readText(args.path);
      if (raw === '') {
        return {
          content: '',
          output: { content: '', lineCount: 0 },
        };
      }

      const allLines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n');

      const offset = args.offset ?? 0;
      const limit = args.limit ?? allLines.length;
      const sliced = allLines.slice(offset, offset + limit);

      const formatted = sliced.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');

      return {
        content: formatted,
        output: { content: formatted, lineCount: sliced.length },
      };
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getActivityDescription(args: ReadInput): string {
    return `Reading ${args.path}`;
  }
}
