/**
 * ReadMediaFileTool — read images/media files as base64 (Slice 3.5).
 *
 * Ports Python `kimi_cli/tools/file/read_media.py`. Reads binary media
 * files (images) and returns them as base64-encoded content blocks for
 * multi-modal LLM consumption.
 *
 * Path safety: goes through the same `assertPathAllowed` guard used by
 * Read/Write/Edit (Phase 1 Slice 4 audit fix).
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { ToolResult, ToolResultContent, ToolUpdate } from '../soul/types.js';
import { PathSecurityError, assertPathAllowed } from './path-guard.js';
import type { BuiltinTool } from './types.js';
import type { WorkspaceConfig } from './workspace.js';

// ── Constants ────────────────────────────────────────────────────────

const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MiB

/** Known image MIME types by extension. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

function detectMime(path: string): string | undefined {
  const dotIdx = path.lastIndexOf('.');
  if (dotIdx === -1) return undefined;
  const ext = path.slice(dotIdx).toLowerCase();
  return MIME_BY_EXT[ext];
}

// ── Input schema ─────────────────────────────────────────────────────

export interface ReadMediaFileInput {
  path: string;
}

const _rawReadMediaFileInputSchema = z.object({
  path: z.string().describe('The path to the media file to read.'),
});

export const ReadMediaFileInputSchema: z.ZodType<ReadMediaFileInput> = _rawReadMediaFileInputSchema;

// ── Tool description ─────────────────────────────────────────────────

const DESCRIPTION =
  'Read an image file and return its contents. Supported formats: PNG, JPEG, GIF, WebP, BMP, SVG, TIFF. ' +
  `Maximum file size: ${String(MAX_MEDIA_BYTES / (1024 * 1024))}MB.`;

// ── Implementation ───────────────────────────────────────────────────

export class ReadMediaFileTool implements BuiltinTool<ReadMediaFileInput, void> {
  readonly name = 'ReadMediaFile' as const;
  readonly description = DESCRIPTION;
  readonly inputSchema: z.ZodType<ReadMediaFileInput> = ReadMediaFileInputSchema;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {}

  async execute(
    _toolCallId: string,
    args: ReadMediaFileInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<void>> {
    if (!args.path) {
      return { isError: true, content: 'File path cannot be empty.' };
    }

    // Path safety check.
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

    // Detect MIME type.
    const mime = detectMime(safePath);
    if (!mime) {
      return {
        isError: true,
        content:
          `Unsupported or unrecognized media file type: "${args.path}". ` +
          'Use ReadFile to read text files.',
      };
    }

    try {
      // Check file size via stat.
      const stat = await this.kaos.stat(safePath);
      if (stat.stSize === 0) {
        return { isError: true, content: `"${args.path}" is empty.` };
      }
      if (stat.stSize > MAX_MEDIA_BYTES) {
        return {
          isError: true,
          content:
            `"${args.path}" is ${String(stat.stSize)} bytes, which exceeds the ` +
            `maximum ${String(MAX_MEDIA_BYTES / (1024 * 1024))}MB for media files.`,
        };
      }

      const buffer = await this.kaos.readBytes(safePath);
      const base64 = buffer.toString('base64');
      const imageContent: ToolResultContent = {
        type: 'image',
        source: { type: 'base64', data: base64, media_type: mime },
      };

      return {
        content: [imageContent],
        isError: false,
      };
    } catch (error) {
      return {
        isError: true,
        content: `Failed to read ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  getActivityDescription(args: ReadMediaFileInput): string {
    return `Reading media: ${args.path}`;
  }
}
