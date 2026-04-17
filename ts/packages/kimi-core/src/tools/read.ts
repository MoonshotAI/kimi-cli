/**
 * ReadTool — read text file content with optional line range (§9-F / Appendix E.1).
 *
 * Dependencies injected via constructor (§9-F.3):
 *   - `Kaos`             — file system abstraction (readText / stat)
 *   - `WorkspaceConfig`  — path safety boundary (§14.3 D11)
 */

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
import { ReadInputSchema } from './types.js';
import type { BuiltinTool, ReadInput, ReadOutput } from './types.js';
import type { WorkspaceConfig } from './workspace.js';

// Parity with `kimi_cli/tools/file/read.py` (Phase 15 A.2).
export const MAX_LINES: number = 1000;
export const MAX_LINE_LENGTH: number = 2000;
export const MAX_BYTES: number = 100 * 1024;

function truncateLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) return line;
  const marker = '...';
  const target = Math.max(maxLength, marker.length);
  return line.slice(0, target - marker.length) + marker;
}

export class ReadTool implements BuiltinTool<ReadInput, ReadOutput> {
  readonly name = 'Read' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description = 'Read the contents of a file from the local filesystem.';
  readonly inputSchema: z.ZodType<ReadInput> = ReadInputSchema;
  // Read self-limits via offset/limit; opt out of orchestrator persistence.
  readonly maxResultSizeChars: number = Number.POSITIVE_INFINITY;
  // Phase 15 L14 — pure-read tool; safe to prefetch under streaming.
  readonly isConcurrencySafe = (_input: unknown): boolean => true;
  readonly display: ToolDisplayHooks<ReadInput, ReadOutput> = {
    getUserFacingName: () => 'Read',
    getInputDisplay: (input) => ({
      kind: 'file_io',
      operation: 'read',
      path: input.path,
    }),
    getResultDisplay: (input, result): ToolResultDisplay => ({
      kind: 'file_content',
      path: input.path,
      content: result.output?.content ?? '',
    }),
  };

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {}

  async execute(
    _toolCallId: string,
    args: ReadInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<ReadOutput>> {
    let safePath: string;
    try {
      safePath = assertPathAllowed(args.path, this.workspace.workspaceDir, this.workspace, {
        mode: 'read',
      });
    } catch (error) {
      if (error instanceof PathSecurityError) {
        return { isError: true, content: error.message };
      }
      throw error;
    }

    try {
      const raw = await this.kaos.readText(safePath);
      if (raw === '') {
        return {
          content: '',
          output: { content: '', lineCount: 0 },
        };
      }

      const allLines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n');

      const offset = args.offset ?? 0;
      const requestedLimit = args.limit ?? MAX_LINES;
      const effectiveLimit = Math.min(requestedLimit, MAX_LINES);

      const sliced: string[] = [];
      const truncatedLineNumbers: number[] = [];
      let bytes = 0;
      let maxBytesReached = false;
      let maxLinesReached = false;

      for (let i = offset; i < allLines.length; i++) {
        const original = allLines[i]!;
        const truncated = truncateLine(original, MAX_LINE_LENGTH);
        if (truncated !== original) {
          truncatedLineNumbers.push(i + 1);
        }
        sliced.push(truncated);
        bytes += Buffer.byteLength(truncated, 'utf8');
        if (sliced.length >= effectiveLimit) {
          // effectiveLimit is always clamped to MAX_LINES, so we reach this
          // branch on BOTH "user-requested limit hit" and "MAX_LINES cap
          // hit". Flag as `maxLinesReached` only when the cap actually bit
          // (we clamped below the user's ask AND more input exists).
          if (effectiveLimit >= MAX_LINES && i + 1 < allLines.length) {
            maxLinesReached = true;
          }
          break;
        }
        if (bytes >= MAX_BYTES) {
          maxBytesReached = true;
          break;
        }
      }

      const formatted = sliced.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');

      const notes: string[] = [];
      if (maxLinesReached) {
        notes.push(`Output truncated: max ${String(MAX_LINES)} lines reached.`);
      }
      if (maxBytesReached) {
        notes.push(`Output truncated: max ${String(MAX_BYTES)} bytes reached.`);
      }
      if (truncatedLineNumbers.length > 0) {
        notes.push(`Lines [${truncatedLineNumbers.join(', ')}] were truncated.`);
      }

      const content =
        notes.length > 0 ? `${formatted}\n${notes.join(' ')}` : formatted;

      return {
        content,
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
