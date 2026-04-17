/**
 * file-type — magic byte + extension detection (Phase 14 §3.2).
 *
 * Ports `src/kimi_cli/tools/file/utils.py:1-258`. The TS module
 * `src/tools/file-type.ts` is a hand-written 1:1 (no npm dependency).
 *
 * Tests pin:
 *   - magic-byte recognition for PNG / JPEG / GIF / WebP / AVIF /
 *     MP4 ftyp / MKV / AVI
 *   - extension lookup for each `IMAGE_MIME_BY_SUFFIX` / `VIDEO_MIME_BY_SUFFIX`
 *   - NUL bytes → unknown
 *   - extension hints a different kind than sniff → unknown
 *   - `NON_TEXT_SUFFIXES` lookup returns unknown (so binaries aren't
 *     treated as text on a blind read)
 *   - no header provided → extension-only detection
 *
 * Python has no dedicated file-type test file; TS-core adds this for
 * TDD cleanliness. All tests FAIL until `src/tools/file-type.ts` is
 * implemented (Phase 14 §3.2).
 */

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line import/no-unresolved
import {
  detectFileType,
  sniffMediaFromMagic,
  MEDIA_SNIFF_BYTES,
  IMAGE_MIME_BY_SUFFIX,
  VIDEO_MIME_BY_SUFFIX,
  NON_TEXT_SUFFIXES,
  type FileType,
} from '../../src/tools/file-type.js';

describe('sniffMediaFromMagic (Phase 14 §3.2)', () => {
  it('recognises PNG magic bytes', () => {
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(sniffMediaFromMagic(header)).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/png',
    });
  });

  it('recognises JPEG magic bytes', () => {
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(sniffMediaFromMagic(header)).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/jpeg',
    });
  });

  it('recognises GIF87a and GIF89a magic bytes', () => {
    expect(sniffMediaFromMagic(Buffer.from('GIF87a' + '\0\0', 'binary'))).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/gif',
    });
    expect(sniffMediaFromMagic(Buffer.from('GIF89a' + '\0\0', 'binary'))).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/gif',
    });
  });

  it('recognises WebP magic bytes (RIFF…WEBP)', () => {
    const header = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WEBP'),
    ]);
    expect(sniffMediaFromMagic(header)).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/webp',
    });
  });

  it('recognises AVIF via ftyp brand', () => {
    const header = Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]),
      Buffer.from('ftyp'),
      Buffer.from('avif'),
      Buffer.alloc(16),
    ]);
    expect(sniffMediaFromMagic(header)).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/avif',
    });
  });

  it('recognises MP4 via ftyp mp42/isom brand', () => {
    const header = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftyp'),
      Buffer.from('mp42'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('mp42isom'),
    ]);
    const result = sniffMediaFromMagic(header);
    expect(result?.kind).toBe('video');
    expect(result?.mimeType).toBe('video/mp4');
  });

  it('recognises Matroska / WebM via EBML header', () => {
    const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    const matroskaHeader = Buffer.concat([ebml, Buffer.from('.matroska.', 'binary')]);
    expect(sniffMediaFromMagic(matroskaHeader)).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/x-matroska',
    });
    const webmHeader = Buffer.concat([ebml, Buffer.from('.webm.', 'binary')]);
    expect(sniffMediaFromMagic(webmHeader)).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/webm',
    });
  });

  it('recognises AVI via RIFF…AVI ', () => {
    const header = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('AVI '),
    ]);
    expect(sniffMediaFromMagic(header)).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/x-msvideo',
    });
  });

  it('returns null for unrecognised magic bytes', () => {
    expect(sniffMediaFromMagic(Buffer.from('plain text content'))).toBeNull();
  });

  it('uses MEDIA_SNIFF_BYTES as the header slice size ceiling', () => {
    // Typed constant guard — keeps the test in sync with the
    // Python `MEDIA_SNIFF_BYTES = 512` constant.
    expect(MEDIA_SNIFF_BYTES).toBe(512);
  });
});

describe('detectFileType (Phase 14 §3.2)', () => {
  it('resolves images by extension when no header is given', () => {
    expect(detectFileType('foo.png')).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/png',
    });
    expect(detectFileType('foo.JPG')).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/jpeg',
    });
    expect(detectFileType('foo.heic')).toEqual<FileType>({
      kind: 'image',
      mimeType: 'image/heic',
    });
  });

  it('resolves videos by extension when no header is given', () => {
    expect(detectFileType('foo.mp4')).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/mp4',
    });
    expect(detectFileType('foo.mkv')).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/x-matroska',
    });
    expect(detectFileType('foo.mov')).toEqual<FileType>({
      kind: 'video',
      mimeType: 'video/quicktime',
    });
  });

  it('treats .svg (text) as text, not image, even though the MIME is image/*', () => {
    // Python `_TEXT_MIME_BY_SUFFIX` carves out SVG — it's XML text even
    // though its MIME says `image/svg+xml`.
    const result = detectFileType('pic.svg');
    expect(result.kind).toBe('text');
    expect(result.mimeType).toBe('image/svg+xml');
  });

  it('NUL byte in header → unknown (binary signal)', () => {
    const header = Buffer.concat([Buffer.from('partial'), Buffer.from([0x00, 0x00])]);
    const result = detectFileType('mystery.bin', header);
    expect(result.kind).toBe('unknown');
  });

  it('extension + sniff disagree → unknown', () => {
    // `.png` extension but JPEG magic bytes — Python `detect_file_type`
    // returns `unknown` (the mime-types disagree so we refuse to guess).
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const result = detectFileType('mismatch.mp4', jpegHeader);
    expect(result.kind).toBe('unknown');
  });

  it('extension in NON_TEXT_SUFFIXES → unknown', () => {
    // A `.zip` file with no header and no image/video hint must not
    // be treated as text.
    const result = detectFileType('archive.zip');
    expect(result.kind).toBe('unknown');
  });

  it('falls back to plain text for unknown suffix with no magic bytes', () => {
    const result = detectFileType('README');
    expect(result.kind).toBe('text');
    expect(result.mimeType).toBe('text/plain');
  });

  it('exposes the suffix maps as readonly records', () => {
    expect(IMAGE_MIME_BY_SUFFIX['.png']).toBe('image/png');
    expect(VIDEO_MIME_BY_SUFFIX['.mkv']).toBe('video/x-matroska');
    expect(NON_TEXT_SUFFIXES.has('.pdf')).toBe(true);
    expect(NON_TEXT_SUFFIXES.has('.zip')).toBe(true);
    expect(NON_TEXT_SUFFIXES.has('.dll')).toBe(true);
  });
});
