/**
 * EditTool — exact string replacement in a file (§9-F / Appendix E.3).
 *
 * Replaces the first occurrence of `old_string` with `new_string` by default.
 * When `replace_all` is true, replaces all occurrences.
 * Errors when `old_string` is not found or not unique (when replace_all=false).
 * Path safety is enforced before any Kaos I/O (§14.3 D11).
 */

import { resolve as resolvePath } from 'node:path';

import type { Kaos } from '@moonshot-ai/kaos';
import type { z } from 'zod';

import type {
  ToolDisplayHooks,
  ToolResult,
  ToolResultDisplay,
  ToolUpdate,
  ToolMetadata
} from '../soul/types.js';
import { PathSecurityError, assertPathAllowed } from './path-guard.js';
import { planModeWriteBlockMessage } from './plan-mode-checker.js';
import type { PlanModeChecker } from './plan-mode-checker.js';
import { EditInputSchema } from './types.js';
import type { BuiltinTool, EditInput, EditOutput } from './types.js';
import type { WorkspaceConfig } from './workspace.js';

export interface EditToolOptions {
  readonly planModeChecker?: PlanModeChecker | undefined;
}

export class EditTool implements BuiltinTool<EditInput, EditOutput> {
  readonly name = 'Edit' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description = 'Perform exact string replacements in a file.';
  readonly inputSchema: z.ZodType<EditInput> = EditInputSchema;
  readonly display: ToolDisplayHooks<EditInput, EditOutput> = {
    getUserFacingName: () => 'Edit',
    getInputDisplay: (input) => ({
      kind: 'file_io',
      operation: 'edit',
      path: input.path,
    }),
    getResultDisplay: (input, _result): ToolResultDisplay => ({
      kind: 'diff',
      path: input.path,
      before: input.old_string,
      after: input.new_string,
    }),
  };

  private readonly planModeChecker: PlanModeChecker | undefined;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    options?: EditToolOptions,
  ) {
    this.planModeChecker = options?.planModeChecker;
  }

  async execute(
    _toolCallId: string,
    args: EditInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<EditOutput>> {
    // Phase 18 §D.5 — see WriteTool; same policy.
    if (this.planModeChecker?.isPlanModeActive() === true) {
      const planPath = this.planModeChecker.getPlanFilePath();
      if (planPath === null || resolvePath(args.path) !== resolvePath(planPath)) {
        return { isError: true, content: planModeWriteBlockMessage(planPath) };
      }
    }

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
      const content = await this.kaos.readText(safePath);
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
        await this.kaos.writeText(safePath, newContent);
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
      await this.kaos.writeText(safePath, newContent);
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
