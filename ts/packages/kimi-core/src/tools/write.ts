/**
 * WriteTool — overwrite-write a file (§9-F / Appendix E.2).
 *
 * Creates the file if it does not exist; parent directory must already exist.
 * Path safety is enforced before any Kaos I/O (§14.3 D11).
 */

import type { Kaos } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type { ToolResult, ToolUpdate, ToolMetadata } from '../soul/types.js';
import { PathSecurityError, assertPathAllowed } from './path-guard.js';
import { WriteInputSchema } from './types.js';
import type { BuiltinTool, WriteInput, WriteOutput } from './types.js';
import type { WorkspaceConfig } from './workspace.js';

export class WriteTool implements BuiltinTool<WriteInput, WriteOutput> {
  readonly name = 'Write' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description = 'Write content to a file, creating it if it does not exist.';
  readonly inputSchema: z.ZodType<WriteInput> = WriteInputSchema;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {}

  async execute(
    _toolCallId: string,
    args: WriteInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<WriteOutput>> {
    let safePath: string;
    try {
      safePath = assertPathAllowed(args.path, this.workspace.workspaceDir, this.workspace, {
        mode: 'write',
      });
    } catch (error) {
      if (error instanceof PathSecurityError) {
        return { isError: true, content: error.message };
      }
      throw error;
    }

    try {
      const bytesWritten = await this.kaos.writeText(safePath, args.content);
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
