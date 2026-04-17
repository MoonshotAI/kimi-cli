/**
 * file-type — magic-byte + extension detection (Phase 14 §3.2).
 *
 * Ports `src/kimi_cli/tools/file/utils.py:1-258` 1:1 — no npm dependency.
 */

export const MEDIA_SNIFF_BYTES = 512;

export interface FileType {
  readonly kind: 'text' | 'image' | 'video' | 'unknown';
  readonly mimeType: string;
}

export const IMAGE_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.svgz': 'image/svg+xml',
});

export const VIDEO_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
});

const TEXT_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.svg': 'image/svg+xml',
});

export const NON_TEXT_SUFFIXES: ReadonlySet<string> = new Set<string>([
  '.icns',
  '.psd',
  '.ai',
  '.eps',
  '.pdf',
  '.doc',
  '.docx',
  '.dot',
  '.dotx',
  '.rtf',
  '.odt',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlt',
  '.xltx',
  '.xltm',
  '.ods',
  '.ppt',
  '.pptx',
  '.pptm',
  '.pps',
  '.ppsx',
  '.odp',
  '.pages',
  '.numbers',
  '.key',
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.zst',
  '.lz',
  '.lz4',
  '.br',
  '.cab',
  '.ar',
  '.deb',
  '.rpm',
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.aac',
  '.m4a',
  '.wma',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.apk',
  '.ipa',
  '.jar',
  '.class',
  '.pyc',
  '.pyo',
  '.wasm',
  '.dmg',
  '.iso',
  '.img',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.db3',
]);

const ASF_HEADER = Buffer.from([
  0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
]);

const FTYP_IMAGE_BRANDS: Readonly<Record<string, string>> = Object.freeze({
  avif: 'image/avif',
  avis: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  heix: 'image/heif',
  hevc: 'image/heic',
  mif1: 'image/heif',
  msf1: 'image/heif',
});

const FTYP_VIDEO_BRANDS: Readonly<Record<string, string>> = Object.freeze({
  isom: 'video/mp4',
  iso2: 'video/mp4',
  iso5: 'video/mp4',
  mp41: 'video/mp4',
  mp42: 'video/mp4',
  avc1: 'video/mp4',
  mp4v: 'video/mp4',
  m4v: 'video/x-m4v',
  qt: 'video/quicktime',
  '3gp4': 'video/3gpp',
  '3gp5': 'video/3gpp',
  '3gp6': 'video/3gpp',
  '3gp7': 'video/3gpp',
  '3g2': 'video/3gpp2',
});

function toBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function startsWith(buf: Buffer, prefix: Buffer | readonly number[]): boolean {
  const needle = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix);
  if (buf.length < needle.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (buf[i] !== needle[i]) return false;
  }
  return true;
}

function sniffFtypBrand(header: Buffer): string | null {
  if (header.length < 12) return null;
  if (header.subarray(4, 8).toString('latin1') !== 'ftyp') return null;
  const raw = header.subarray(8, 12).toString('latin1').toLowerCase();
  // Python `.strip()` removes ASCII whitespace including trailing NULs via
  // the `decode(..., errors="ignore")` semantics. We approximate: trim
  // spaces and trailing NULs so brands like `qt  ` → `qt`.
  // oxlint-disable-next-line no-control-regex
  return raw.replace(/[\s\u0000]+$/g, '').trim();
}

export function sniffMediaFromMagic(data: Buffer | Uint8Array): FileType | null {
  const buf = toBuffer(data);
  const header = buf.length > MEDIA_SNIFF_BYTES ? buf.subarray(0, MEDIA_SNIFF_BYTES) : buf;

  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mimeType: 'image/png' };
  }
  if (startsWith(header, [0xff, 0xd8, 0xff])) {
    return { kind: 'image', mimeType: 'image/jpeg' };
  }
  if (startsWith(header, Buffer.from('GIF87a')) || startsWith(header, Buffer.from('GIF89a'))) {
    return { kind: 'image', mimeType: 'image/gif' };
  }
  if (startsWith(header, Buffer.from('BM'))) {
    return { kind: 'image', mimeType: 'image/bmp' };
  }
  if (startsWith(header, [0x49, 0x49, 0x2a, 0x00]) || startsWith(header, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { kind: 'image', mimeType: 'image/tiff' };
  }
  if (startsWith(header, [0x00, 0x00, 0x01, 0x00])) {
    return { kind: 'image', mimeType: 'image/x-icon' };
  }
  if (startsWith(header, Buffer.from('RIFF')) && header.length >= 12) {
    const chunk = header.subarray(8, 12).toString('latin1');
    if (chunk === 'WEBP') return { kind: 'image', mimeType: 'image/webp' };
    if (chunk === 'AVI ') return { kind: 'video', mimeType: 'video/x-msvideo' };
  }
  if (startsWith(header, Buffer.from('FLV'))) {
    return { kind: 'video', mimeType: 'video/x-flv' };
  }
  if (startsWith(header, ASF_HEADER)) {
    return { kind: 'video', mimeType: 'video/x-ms-wmv' };
  }
  if (startsWith(header, [0x1a, 0x45, 0xdf, 0xa3])) {
    const lowered = header.toString('latin1').toLowerCase();
    if (lowered.includes('webm')) return { kind: 'video', mimeType: 'video/webm' };
    if (lowered.includes('matroska')) return { kind: 'video', mimeType: 'video/x-matroska' };
  }
  const brand = sniffFtypBrand(header);
  if (brand !== null && brand !== '') {
    if (brand in FTYP_IMAGE_BRANDS) {
      return { kind: 'image', mimeType: FTYP_IMAGE_BRANDS[brand]! };
    }
    if (brand in FTYP_VIDEO_BRANDS) {
      return { kind: 'video', mimeType: FTYP_VIDEO_BRANDS[brand]! };
    }
  }
  return null;
}

function getSuffix(path: string): string {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return '';
  // POSIX `.suffix` treats `foo.tar.gz` → `.gz` and `foo/.bashrc` → '' (leading-dot is "no suffix").
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (idx <= lastSep + 1) return '';
  return path.slice(idx).toLowerCase();
}

export function detectFileType(path: string, header?: Buffer | Uint8Array): FileType {
  const suffix = getSuffix(path);
  let mediaHint: FileType | null = null;
  if (suffix in TEXT_MIME_BY_SUFFIX) {
    mediaHint = { kind: 'text', mimeType: TEXT_MIME_BY_SUFFIX[suffix]! };
  } else if (suffix in IMAGE_MIME_BY_SUFFIX) {
    mediaHint = { kind: 'image', mimeType: IMAGE_MIME_BY_SUFFIX[suffix]! };
  } else if (suffix in VIDEO_MIME_BY_SUFFIX) {
    mediaHint = { kind: 'video', mimeType: VIDEO_MIME_BY_SUFFIX[suffix]! };
  }

  // TS widening vs. Python: when a header is supplied we always
  // cross-validate against the ext hint — a mismatch reports unknown
  // rather than blindly trusting the extension (Phase 14 §3.2 spec).
  // When ext hint + sniff agree on kind, prefer the ext's mimeType so
  // the reported MIME matches what the filename advertised (Python
  // parity — review MAJ-1). A disagreement on `kind` (e.g. `.mp4`
  // with JPEG magic) still collapses to `unknown`.
  if (header !== undefined) {
    const buf = toBuffer(header);
    const sniffed = sniffMediaFromMagic(buf);
    if (sniffed) {
      if (mediaHint) {
        if (sniffed.kind !== mediaHint.kind) {
          return { kind: 'unknown', mimeType: '' };
        }
        return mediaHint;
      }
      return sniffed;
    }
    if (buf.includes(0x00)) {
      return { kind: 'unknown', mimeType: '' };
    }
    // No sniff and no NUL: fall through to hint / text / unknown logic.
  }

  if (mediaHint) return mediaHint;
  if (NON_TEXT_SUFFIXES.has(suffix)) {
    return { kind: 'unknown', mimeType: '' };
  }
  return { kind: 'text', mimeType: 'text/plain' };
}
