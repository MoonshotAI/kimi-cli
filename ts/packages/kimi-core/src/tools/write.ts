/**
 * WriteTool — overwrite-write a file (§9-F / Appendix E.2).
 *
 * Creates the file if it does not exist; parent directory must already exist.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type { ToolResult, ToolUpdate } from '../soul/types.js';
import { WriteInputSchema } from './types.js';
import type { BuiltinTool, WriteInput, WriteOutput } from './types.js';

export class WriteTool implements BuiltinTool<WriteInput, WriteOutput> {
  readonly name = 'Write' as const;
  readonly description = 'Write content to a file, creating it if it does not exist.';
  readonly inputSchema: z.ZodType<WriteInput> = WriteInputSchema;

  constructor(private readonly kaos: Kaos) {}

  async execute(
    _toolCallId: string,
    args: WriteInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<WriteOutput>> {
    try {
      const bytesWritten = await this.kaos.writeText(args.path, args.content);
      return {
        content: `Wrote ${String(bytesWritten)} bytes to ${args.path}`,
        output: { bytesWritten },
      };
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getActivityDescription(args: WriteInput): string {
    return `Writing ${args.path}`;
  }
}
