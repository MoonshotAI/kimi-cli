/**
 * EditTool — exact string replacement in a file (§9-F / Appendix E.3).
 *
 * Replaces the first occurrence of `old_string` with `new_string` by default.
 * When `replace_all` is true, replaces all occurrences.
 * Errors when `old_string` is not found or not unique (when replace_all=false).
 */

import type { Kaos } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type { ToolResult, ToolUpdate } from '../soul/types.js';
import { EditInputSchema } from './types.js';
import type { BuiltinTool, EditInput, EditOutput } from './types.js';

export class EditTool implements BuiltinTool<EditInput, EditOutput> {
  readonly name = 'Edit' as const;
  readonly description = 'Perform exact string replacements in a file.';
  readonly inputSchema: z.ZodType<EditInput> = EditInputSchema;

  constructor(private readonly kaos: Kaos) {}

  async execute(
    _toolCallId: string,
    args: EditInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<EditOutput>> {
    try {
      const content = await this.kaos.readText(args.path);
      const replaceAll = args.replace_all ?? false;

      if (!replaceAll) {
        let count = 0;
        let pos = 0;
        while (pos < content.length) {
          const idx = content.indexOf(args.old_string, pos);
          if (idx === -1) break;
          count++;
          pos = idx + args.old_string.length;
        }

        if (count === 0) {
          return { isError: true, content: `old_string not found in ${args.path}` };
        }
        if (count > 1) {
          return {
            isError: true,
            content: `old_string is not unique in ${args.path} (found ${String(count)} occurrences)`,
          };
        }

        const newContent = content.replace(args.old_string, args.new_string);
        await this.kaos.writeText(args.path, newContent);
        return {
          content: `Replaced 1 occurrence in ${args.path}`,
          output: { replacementCount: 1 },
        };
      }

      const parts = content.split(args.old_string);
      const replacementCount = parts.length - 1;
      if (replacementCount === 0) {
        return { isError: true, content: `old_string not found in ${args.path}` };
      }

      const newContent = parts.join(args.new_string);
      await this.kaos.writeText(args.path, newContent);
      return {
        content: `Replaced ${String(replacementCount)} occurrences in ${args.path}`,
        output: { replacementCount },
      };
    } catch (error) {
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getActivityDescription(args: EditInput): string {
    return `Editing ${args.path}`;
  }
}
