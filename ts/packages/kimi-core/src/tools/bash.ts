/**
 * BashTool — execute shell commands (§9-F / Appendix E.4).
 *
 * Dependencies injected via constructor (§9-F.3):
 *   - `Kaos` — shell execution abstraction (exec / execWithEnv)
 *   - `cwd`  — default working directory for commands
 *
 * Execution goes through Kaos, never directly via node:child_process.
 */

import { text } from 'node:stream/consumers';

import type { Kaos } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type { ToolResult, ToolUpdate } from '../soul/types.js';
import { BashInputSchema } from './types.js';
import type { BashInput, BashOutput, BuiltinTool } from './types.js';

export class BashTool implements BuiltinTool<BashInput, BashOutput> {
  readonly name = 'Bash' as const;
  readonly description = 'Execute shell commands in the workspace.';
  readonly inputSchema: z.ZodType<BashInput> = BashInputSchema;

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
  ) {}

  async execute(
    _toolCallId: string,
    args: BashInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<BashOutput>> {
    try {
      const effectiveCwd = args.cwd ?? this.cwd;
      const proc = await this.kaos.exec(
        'bash',
        '-c',
        `cd ${shellQuote(effectiveCwd)} && ${args.command}`,
      );

      const [stdout, stderr, exitCode] = await Promise.all([
        text(proc.stdout),
        text(proc.stderr),
        proc.wait(),
      ]);

      const output: BashOutput = { exitCode, stdout, stderr };
      const isError = exitCode !== 0;

      return {
        isError: isError || undefined,
        content: isError ? stderr || `Process exited with code ${String(exitCode)}` : stdout,
        output,
      };
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getActivityDescription(args: BashInput): string {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    return `Running: ${preview}`;
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
