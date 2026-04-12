import { PassThrough } from 'node:stream';
import { setImmediate as defer, setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { BufferedReadable, globPatternToRegex } from '../src/internal.js';

async function collectBytes(readable: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    (async () => {
      await delay(timeoutMs);
      throw new Error(`timed out after ${timeoutMs}ms`);
    })(),
  ]);
}

describe('BufferedReadable', () => {
  it('preserves source backpressure until the consumer starts reading', () => {
    const source = new PassThrough({ highWaterMark: 64 * 1024 });
    const buffered = new BufferedReadable(source);
    const chunk = Buffer.alloc(32 * 1024, 0x61);

    let writes = 0;
    let writeOk = true;
    while (writes < 20 && writeOk) {
      writeOk = source.write(chunk);
      writes++;
    }

    buffered.destroy();
    source.destroy();

    expect(writeOk).toBe(false);
    expect(writes).toBeLessThan(10);
  });

  it('stops pushing when its readable buffer reaches highWaterMark', async () => {
    const source = new PassThrough();
    const chunk = Buffer.alloc(32 * 1024, 0x62);

    for (let index = 0; index < 10; index++) {
      source.write(chunk);
    }
    source.end();

    const buffered = new BufferedReadable(source);
    buffered.read(0);
    await defer();

    expect(buffered.readableLength).toBeLessThanOrEqual(buffered.readableHighWaterMark);

    const output = await collectBytes(buffered);
    expect(output).toHaveLength(chunk.length * 10);
  });

  it('ends async iteration when the source closes without emitting end', async () => {
    const source = new PassThrough();
    const buffered = new BufferedReadable(source);
    const outputPromise = collectBytes(buffered).then((output) => output.toString('utf8'));

    await defer();
    source.write('hello');
    await defer();
    source.destroy();

    await expect(withTimeout(outputPromise, 250)).resolves.toBe('hello');
  });
});

describe('globPatternToRegex', () => {
  it('treats [!...] as a negated character class', () => {
    const regex = globPatternToRegex('[!a].txt', true);

    expect(regex.test('a.txt')).toBe(false);
    expect(regex.test('b.txt')).toBe(true);
  });

  it('treats ^ as a literal character inside glob character classes', () => {
    const regex = globPatternToRegex('[^a].txt', true);

    expect(regex.test('^.txt')).toBe(true);
    expect(regex.test('a.txt')).toBe(true);
    expect(regex.test('b.txt')).toBe(false);
  });

  describe('glob semantic compatibility (Python parity)', () => {
    it('treats brace expansion syntax as literal characters', () => {
      const regex = globPatternToRegex('*.{js,ts}', true);

      expect(regex.test('file.js')).toBe(false);
      expect(regex.test('file.ts')).toBe(false);
      expect(regex.test('file.{js,ts}')).toBe(true);
    });

    it('treats leading ^ as a literal character inside character classes', () => {
      const regex = globPatternToRegex('[^a].txt', true);

      expect(regex.test('^.txt')).toBe(true);
      expect(regex.test('a.txt')).toBe(true);
      expect(regex.test('b.txt')).toBe(false);
    });

    it('uses ! for character class negation', () => {
      const regex = globPatternToRegex('[!a].txt', true);

      expect(regex.test('b.txt')).toBe(true);
      expect(regex.test('a.txt')).toBe(false);
    });

    it('matches hidden files with dot-prefixed patterns', () => {
      const regex = globPatternToRegex('.*', true);

      expect(regex.test('.hidden')).toBe(true);
      expect(regex.test('.config')).toBe(true);
    });

    it.skip('Python treats **/foo.txt as recursive; current helper is segment-based and does not implement zero-or-more directories', () => {
      const regex = globPatternToRegex('**/foo.txt', true);

      expect(regex.test('foo.txt')).toBe(true);
      expect(regex.test('a/foo.txt')).toBe(true);
      expect(regex.test('a/b/foo.txt')).toBe(true);
    });

    it('keeps single-star matching to a single path segment', () => {
      const regex = globPatternToRegex('*/foo.txt', true);

      expect(regex.test('a/foo.txt')).toBe(true);
      expect(regex.test('foo.txt')).toBe(false);
      expect(regex.test('a/b/foo.txt')).toBe(false);
    });
  });
});
