import { Readable } from 'node:stream';

/**
 * Decode a Buffer into a string with Python-compatible `errors` handling.
 *
 * - `'strict'` (default): throw on invalid sequences (via TextDecoder `fatal: true`)
 * - `'replace'`: substitute each invalid sequence with U+FFFD (TextDecoder default)
 * - `'ignore'`: drop invalid sequences silently (TextDecoder replaces then we strip U+FFFD)
 *
 * Falls back to `Buffer.toString(encoding)` for encodings TextDecoder does not
 * support (e.g. `hex`, `base64`, `binary`, `latin1`) — those are lossless
 * byte-to-character mappings so `errors` has no effect.
 * @internal
 */
export function decodeTextWithErrors(
  data: Buffer,
  encoding: BufferEncoding,
  errors: 'strict' | 'replace' | 'ignore' = 'strict',
): string {
  // Map Node's BufferEncoding names to Web TextDecoder labels where the two
  // diverge. Only UTF-family encodings participate in the strict/replace/
  // ignore dance; the others are lossless and use Buffer.toString directly.
  let webLabel: string | undefined;
  switch (encoding) {
    case 'utf-8':
    case 'utf8':
      webLabel = 'utf-8';
      break;
    case 'utf16le':
    case 'ucs2':
    case 'ucs-2':
      webLabel = 'utf-16le';
      break;
    default:
      webLabel = undefined;
  }

  if (webLabel === undefined) {
    // Non-UTF encodings (hex/base64/latin1/binary/ascii) are lossless byte↔
    // character mappings; `errors` is meaningless for them. Return raw.
    return data.toString(encoding);
  }

  if (errors === 'strict') {
    return new TextDecoder(webLabel, { fatal: true }).decode(data);
  }

  // 'replace' → substitute each invalid sequence with U+FFFD (default)
  // 'ignore'  → substitute then remove the replacements
  const replaced = new TextDecoder(webLabel, { fatal: false }).decode(data);
  return errors === 'ignore' ? replaced.replaceAll('\uFFFD', '') : replaced;
}

/**
 * Convert a glob pattern segment (e.g. "*.txt", "file?.log") into a RegExp.
 * Mirrors Python pathlib behavior: includes dotfiles, case-sensitive by default.
 * @internal
 */
export function globPatternToRegex(pattern: string, caseSensitive: boolean): RegExp {
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === undefined) break;
    switch (ch) {
      case '*':
        regex += '[^/]*';
        break;
      case '?':
        regex += '[^/]';
        break;
      case '[': {
        const end = pattern.indexOf(']', i + 1);
        if (end === -1) {
          regex += '\\[';
        } else {
          // Glob character classes only use `!` for negation. A literal
          // leading `^` must remain literal even though JS regex char
          // classes treat it as negation in the first position.
          let charClass = pattern.slice(i + 1, end);
          if (charClass.startsWith('!')) {
            charClass = '^' + charClass.slice(1);
          } else if (charClass.startsWith('^')) {
            charClass = '\\' + charClass;
          }
          regex += '[' + charClass + ']';
          i = end;
        }
        break;
      }
      default:
        regex += ch.replaceAll(/[{}()+.\\^$|]/g, '\\$&');
    }
  }
  regex += '$';
  return new RegExp(regex, caseSensitive ? '' : 'i');
}

/**
 * A Readable wrapper that preserves source backpressure while still allowing
 * consumers to read buffered output after the source has ended.
 * @internal
 */
export class BufferedReadable extends Readable {
  private readonly _source: Readable;
  private _ended: boolean = false;

  constructor(source: Readable) {
    // Keep a modest prefetch window so wait()-then-read still works for
    // common small/medium outputs without draining unboundedly.
    super({ highWaterMark: 128 * 1024 });
    this._source = source;
    this._source.on('data', this._onData);
    this._source.on('end', this._onEnd);
    this._source.on('close', this._onClose);
    this._source.on('error', this._onError);
  }

  override _read(): void {
    if (!this._ended && !this.destroyed) {
      this._source.resume();
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this._source.off('data', this._onData);
    this._source.off('end', this._onEnd);
    this._source.off('close', this._onClose);
    this._source.off('error', this._onError);
    callback(error);
  }

  private readonly _onData = (chunk: string | Uint8Array): void => {
    if (!this.push(chunk)) {
      this._source.pause();
    }
  };

  private readonly _onEnd = (): void => {
    this._ended = true;
    this.push(null);
  };

  private readonly _onClose = (): void => {
    if (!this._ended) {
      this._ended = true;
      this.push(null);
    }
  };

  private readonly _onError = (error: Error): void => {
    this.destroy(error);
  };
}
