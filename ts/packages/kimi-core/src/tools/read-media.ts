/**
 * ReadMediaFileTool — read image/video files as multi-modal content
 * (Phase 14 §3.3).
 *
 * Ports Python `kimi_cli/tools/file/read_media.py:50-217`. The TS version
 * widens the original Slice-3 single-image output to a 3-part wrap
 * `[TextPart('<image|video path="…">'), ImageContent|VideoContent, TextPart('</image|video>')]`
 * and introduces capability gating (`image_in` / `video_in`).
 *
 * Path safety: goes through the same `assertPathAllowed` guard used by
 * Read/Write/Edit (Phase 1 Slice 4 audit fix).
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { ToolResult, ToolResultContent, ToolUpdate } from '../soul/types.js';
import { MEDIA_SNIFF_BYTES, detectFileType } from './file-type.js';
import { PathSecurityError, assertPathAllowed } from './path-guard.js';
import { SkipThisTool } from './skip-this-tool.js';
import type { BuiltinTool } from './types.js';
import type { WorkspaceConfig } from './workspace.js';

// ── Constants ────────────────────────────────────────────────────────

const MAX_MEDIA_MEGABYTES = 100;
const MAX_MEDIA_BYTES = MAX_MEDIA_MEGABYTES * 1024 * 1024;

// Free-form string; the canonical members are 'image_in' / 'video_in' /
// 'thinking' but callers may carry model-specific extensions.
export type Capability = string;

export type ImageSizeExtractor = (
  data: Buffer,
) => { width: number; height: number } | null;

// ── Input schema ─────────────────────────────────────────────────────

export interface ReadMediaFileInput {
  path: string;
}

const _rawReadMediaFileInputSchema = z.object({
  path: z
    .string()
    .describe(
      'The path to the file to read. Absolute paths are required when reading files outside the working directory.',
    ),
});

export const ReadMediaFileInputSchema: z.ZodType<ReadMediaFileInput> = _rawReadMediaFileInputSchema;

// ── Tool description (capability-driven) ─────────────────────────────

function buildDescription(capabilities: ReadonlySet<Capability>): string {
  const lines: string[] = [
    'Read media content from a file.',
    '',
    '**Tips:**',
    '- Make sure you follow the description of each tool parameter.',
    '- A `<system>` tag will be given before the read file content.',
    '- The system will notify you when there is anything wrong when reading the file.',
    '- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.',
    '- This tool can only read image or video files. To read other types of files, use the ReadFile tool. To list directories, use the Glob tool or `ls` command via the Shell tool.',
    '- If the file doesn\'t exist or path is invalid, an error will be returned.',
    `- The maximum size that can be read is ${String(MAX_MEDIA_MEGABYTES)}MB. An error will be returned if the file is larger than this limit.`,
    '- The media content will be returned in a form that you can directly view and understand.',
    '',
    '**Capabilities**',
  ];
  const hasImage = capabilities.has('image_in');
  const hasVideo = capabilities.has('video_in');
  if (hasImage && hasVideo) {
    lines.push('- This tool supports image and video files for the current model.');
  } else if (hasImage) {
    lines.push(
      '- This tool supports image files for the current model.',
      '- Video files are not supported by the current model.',
    );
  } else if (hasVideo) {
    lines.push(
      '- This tool supports video files for the current model.',
      '- Image files are not supported by the current model.',
    );
  } else {
    lines.push('- The current model does not support image or video input.');
  }
  return lines.join('\n');
}

// ── Implementation ───────────────────────────────────────────────────

export class ReadMediaFileTool implements BuiltinTool<ReadMediaFileInput, void> {
  readonly name = 'ReadMediaFile' as const;
  readonly description: string;
  readonly inputSchema: z.ZodType<ReadMediaFileInput> = ReadMediaFileInputSchema;

  private readonly capabilities: ReadonlySet<Capability>;

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    capabilities: ReadonlySet<Capability>,
    private readonly imageSizeExtractor?: ImageSizeExtractor | undefined,
  ) {
    if (!capabilities.has('image_in') && !capabilities.has('video_in')) {
      throw new SkipThisTool(
        'ReadMediaFile requires image_in or video_in capability',
      );
    }
    this.capabilities = capabilities;
    this.description = buildDescription(capabilities);
  }

  async execute(
    _toolCallId: string,
    args: ReadMediaFileInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<void>> {
    if (!args.path) {
      return { isError: true, content: 'File path cannot be empty.' };
    }

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
      // Phase 14 §3.3 — sniff header first (Python parity: read the
      // first 512 bytes before deciding anything about MIME).
      const header = await this.kaos.readBytes(safePath, MEDIA_SNIFF_BYTES);
      const fileType = detectFileType(safePath, header);

      if (fileType.kind === 'text') {
        return {
          isError: true,
          content: `"${args.path}" is a text file. Use ReadFile to read text files.`,
        };
      }
      if (fileType.kind === 'unknown') {
        return {
          isError: true,
          content:
            `"${args.path}" seems not readable as an image or video file. ` +
            'You may need to read it with proper shell commands, Python tools ' +
            'or MCP tools if available.',
        };
      }

      if (fileType.kind === 'image' && !this.capabilities.has('image_in')) {
        return {
          isError: true,
          content:
            'The current model does not support image input. ' +
            'Tell the user to use a model with image input capability.',
        };
      }
      if (fileType.kind === 'video' && !this.capabilities.has('video_in')) {
        return {
          isError: true,
          content:
            'The current model does not support video input. ' +
            'Tell the user to use a model with video input capability.',
        };
      }

      const stat = await this.kaos.stat(safePath);
      if (stat.stSize === 0) {
        return { isError: true, content: `"${args.path}" is empty.` };
      }
      if (stat.stSize > MAX_MEDIA_BYTES) {
        return {
          isError: true,
          content:
            `"${args.path}" is ${String(stat.stSize)} bytes, which exceeds the ` +
            `maximum ${String(MAX_MEDIA_MEGABYTES)}MB for media files.`,
        };
      }

      const data = await this.kaos.readBytes(safePath);
      const base64 = data.toString('base64');
      const mediaPart: ToolResultContent =
        fileType.kind === 'image'
          ? {
              type: 'image',
              source: { type: 'base64', data: base64, media_type: fileType.mimeType },
            }
          : {
              type: 'video',
              source: { type: 'base64', data: base64, media_type: fileType.mimeType },
            };

      const tag = fileType.kind === 'image' ? 'image' : 'video';
      const openText = `<${tag} path="${safePath}">`;
      const closeText = `</${tag}>`;

      let sizeHint = '';
      if (fileType.kind === 'image' && this.imageSizeExtractor) {
        const dims = this.imageSizeExtractor(data);
        if (dims) {
          sizeHint = `, original size ${String(dims.width)}x${String(dims.height)}px`;
        }
      }

      const summary =
        `Loaded ${fileType.kind} file "${safePath}" ` +
        `(${fileType.mimeType}, ${String(stat.stSize)} bytes${sizeHint}).`;

      const content: ToolResultContent[] = [
        { type: 'text', text: openText },
        mediaPart,
        { type: 'text', text: closeText },
      ];
      // Phase 14 §3.4: the "original size WxHpx" hint must land somewhere
      // observable. We tack a trailing text part carrying the summary so
      // the 3-part wrap keeps its canonical open/media/close triplet
      // while downstream consumers still see the hint.
      if (sizeHint !== '') {
        content.push({ type: 'text', text: summary });
      }

      return {
        content,
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
