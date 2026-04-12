import * as fs from 'node:fs';
import * as path from 'node:path';

import type OpenAI from 'openai';

import { ChatProviderError } from '../errors.js';
import type { VideoURLPart } from '../message.js';
import { convertOpenAIError } from './openai-common.js';

/**
 * Input for uploading a video from in-memory bytes.
 *
 * Use this form when the video is already loaded in memory (for example,
 * fetched from a URL or produced by another tool) and a filesystem path is
 * not available.
 */
export interface VideoBytesInput {
  /** Raw video bytes. */
  data: Buffer | Uint8Array;
  /** MIME type of the video (must start with `video/`). */
  mimeType: string;
  /**
   * Optional filename hint for the upload. Defaults to `upload.<ext>` derived
   * from {@link mimeType}.
   */
  filename?: string;
}

/**
 * Kimi-specific file upload client.
 *
 * Wraps the underlying OpenAI-compatible `files.create` API to upload videos
 * to Moonshot's file service and return them as {@link VideoURLPart} values
 * suitable for use in chat messages.
 *
 * A `KimiFiles` instance is typically obtained from
 * {@link KimiChatProvider.files}.
 */
export class KimiFiles {
  private readonly _client: OpenAI;

  constructor(client: OpenAI) {
    this._client = client;
  }

  /**
   * Upload a video file to Kimi/Moonshot for use in chat messages.
   *
   * Accepts either a local filesystem path or an in-memory
   * {@link VideoBytesInput}. Returns a {@link VideoURLPart} referencing the
   * uploaded file by its Moonshot file id.
   *
   * @param input - Local path string or `{ data, mimeType }` object.
   * @returns A `VideoURLPart` with `url = "kimi-file://<file-id>"`.
   * @throws {ChatProviderError} if the input is not a video or the upload
   *         fails.
   */
  async uploadVideo(input: string | VideoBytesInput): Promise<VideoURLPart> {
    let file: unknown;

    if (typeof input === 'string') {
      // Validate the path eagerly so callers get a clear synchronous-ish
      // failure rather than a generic stream error from the upload pipeline.
      if (!fs.existsSync(input)) {
        throw new ChatProviderError(`Video file not found: ${input}`);
      }
      const filename = path.basename(input);
      // Infer mime type from the file extension and reject anything that is
      // not a recognised video type. Without this check, callers passing a
      // non-video file (e.g. `note.txt`) would still hit the upload API and
      // fail with a confusing server error; surfacing the issue here keeps
      // the API contract honest and matches the `VideoBytesInput` branch.
      const mimeType = guessMimeTypeFromExt(filename);
      if (mimeType === undefined || !mimeType.startsWith('video/')) {
        throw new ChatProviderError(
          `KimiFiles.uploadVideo: file extension does not indicate a video type: ${filename}`,
        );
      }
      // Read the file into memory and wrap it in a File/Blob. We avoid
      // `fs.createReadStream` here because a still-open stream would race
      // with callers that delete the source file after `uploadVideo`
      // resolves (also common in tests with tmp directories).
      const data = await fs.promises.readFile(input);
      const blob = new Blob([new Uint8Array(data)], { type: mimeType });
      file = new File([blob], filename, { type: mimeType });
    } else {
      if (!input.mimeType.startsWith('video/')) {
        throw new ChatProviderError(`Expected a video mime type, got ${input.mimeType}`);
      }
      const filename = input.filename ?? guessFilename(input.mimeType);
      // The OpenAI SDK's `Uploadable` accepts a File-like object. We build
      // one via the standard Web `File` constructor (available in Node 20+).
      // `Blob` and `File` are available as globals in Node 20+. The cast via
      // `Uint8Array` satisfies `BlobPart` in both Node and DOM lib contexts.
      const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
      const blob = new Blob([bytes], { type: input.mimeType });
      file = new File([blob], filename, { type: input.mimeType });
    }

    let uploaded: { id: string };
    try {
      uploaded = (await this._client.files.create({
        file: file as never,
        purpose: 'video' as never,
      })) as unknown as { id: string };
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }

    return {
      type: 'video_url',
      videoUrl: {
        url: `ms://${uploaded.id}`,
        id: uploaded.id,
      },
    };
  }
}

/**
 * Guess a filename for an upload from a video MIME type.
 * Falls back to `upload.bin` for unknown types.
 */
function guessFilename(mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType.toLowerCase()] ?? 'bin';
  return `upload.${ext}`;
}

const MIME_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/3gpp': '3gp',
};

const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime]),
);

/**
 * Guess a MIME type from a filename extension. Only recognises the video
 * types listed in {@link MIME_TO_EXT}; returns `undefined` otherwise.
 */
function guessMimeTypeFromExt(filename: string): string | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext];
}
