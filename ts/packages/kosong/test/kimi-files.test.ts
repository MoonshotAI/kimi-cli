import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { KimiFiles } from '../src/providers/kimi-files.js';
import { KimiChatProvider } from '../src/providers/kimi.js';

function createProvider(): KimiChatProvider {
  return new KimiChatProvider({
    model: 'kimi-k2-turbo-preview',
    apiKey: 'test-key',
  });
}

describe('KimiFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-files-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('exposure on KimiChatProvider', () => {
    it('exposes files property returning a KimiFiles instance', () => {
      const provider = createProvider();
      expect(provider.files).toBeDefined();
      expect(provider.files).toBeInstanceOf(KimiFiles);
      expect(typeof provider.files.uploadVideo).toBe('function');
    });

    it('memoizes the files property', () => {
      const provider = createProvider();
      const a = provider.files;
      const b = provider.files;
      expect(a).toBe(b);
    });
  });

  describe('uploadVideo from a file path', () => {
    it('uploads the file and returns a VideoURLPart', async () => {
      const provider = createProvider();

      // Write a fake video file
      const videoPath = path.join(tmpDir, 'video.mp4');
      fs.writeFileSync(videoPath, Buffer.from([0, 1, 2, 3, 4]));

      // Capture what is passed to files.create.
      let captured: unknown;
      const mockCreate = vi.fn().mockImplementation((params: unknown) => {
        captured = params;
        return Promise.resolve({
          id: 'file_abc123',
          object: 'file',
          bytes: 5,
          created_at: 1,
          filename: 'video.mp4',
          purpose: 'video',
        });
      });
      provider.files['_client'].files.create = mockCreate as never;

      const part = await provider.files.uploadVideo(videoPath);

      expect(mockCreate).toHaveBeenCalledOnce();
      const call = captured as { file: unknown; purpose: string };
      expect(call.purpose).toBe('video');
      expect(call.file).toBeDefined();

      expect(part.type).toBe('video_url');
      expect(part.videoUrl.url).toBe('ms://file_abc123');
      expect(part.videoUrl.id).toBe('file_abc123');
    });

    it('throws when the file does not exist', async () => {
      const provider = createProvider();
      const missing = path.join(tmpDir, 'does-not-exist.mp4');
      await expect(provider.files.uploadVideo(missing)).rejects.toThrow();
    });

    it('rejects a non-video file path (e.g. .txt)', async () => {
      const provider = createProvider();
      const notVideo = path.join(tmpDir, 'note.txt');
      fs.writeFileSync(notVideo, 'hello');

      // Spy on the SDK to make sure we never reach it for a bad extension.
      const mockCreate = vi.fn();
      provider.files['_client'].files.create = mockCreate as never;

      await expect(provider.files.uploadVideo(notVideo)).rejects.toThrow(/video/i);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects a file with no extension', async () => {
      const provider = createProvider();
      const noExt = path.join(tmpDir, 'mystery');
      fs.writeFileSync(noExt, 'hello');

      const mockCreate = vi.fn();
      provider.files['_client'].files.create = mockCreate as never;

      await expect(provider.files.uploadVideo(noExt)).rejects.toThrow(/video/i);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it.each([
      ['clip.mp4', 'video/mp4'],
      ['clip.webm', 'video/webm'],
      ['clip.mov', 'video/quicktime'],
    ])('accepts %s and infers %s', async (filename, expectedMime) => {
      const provider = createProvider();
      const videoPath = path.join(tmpDir, filename);
      fs.writeFileSync(videoPath, Buffer.from([0, 1, 2, 3]));

      let captured: unknown;
      provider.files['_client'].files.create = vi.fn().mockImplementation((params: unknown) => {
        captured = params;
        return Promise.resolve({
          id: 'file_ext_ok',
          object: 'file',
          bytes: 4,
          created_at: 1,
          filename,
          purpose: 'video',
        });
      }) as never;

      const part = await provider.files.uploadVideo(videoPath);
      expect(part.videoUrl.id).toBe('file_ext_ok');
      const call = captured as { file: { type?: string } };
      // The File-like object passed to the SDK should carry the inferred
      // video/* mime type.
      expect(call.file.type).toBe(expectedMime);
    });
  });

  describe('uploadVideo from a Buffer', () => {
    it('uploads raw bytes and returns a VideoURLPart', async () => {
      const provider = createProvider();
      const bytes = Buffer.from([10, 20, 30, 40]);

      let captured: unknown;
      provider.files['_client'].files.create = vi.fn().mockImplementation((params: unknown) => {
        captured = params;
        return Promise.resolve({
          id: 'file_buf_456',
          object: 'file',
          bytes: bytes.length,
          created_at: 1,
          filename: 'upload.mp4',
          purpose: 'video',
        });
      }) as never;

      const part = await provider.files.uploadVideo({
        data: bytes,
        mimeType: 'video/mp4',
      });

      expect(captured).toBeDefined();
      expect((captured as { purpose: string }).purpose).toBe('video');
      expect(part.type).toBe('video_url');
      expect(part.videoUrl.url).toBe('ms://file_buf_456');
      expect(part.videoUrl.id).toBe('file_buf_456');
    });

    it('rejects a non-video mime type', async () => {
      const provider = createProvider();
      await expect(
        provider.files.uploadVideo({
          data: Buffer.from([1, 2, 3]),
          mimeType: 'image/png',
        }),
      ).rejects.toThrow(/video/i);
    });
  });
});
