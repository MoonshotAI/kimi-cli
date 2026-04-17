import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { loadInputHistory, appendInputHistory } from '../../src/utils/input-history.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'input-history-'));
  file = join(dir, 'history.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('input-history', () => {
  it('returns empty when file does not exist', async () => {
    expect(await loadInputHistory(file)).toEqual([]);
  });

  it('parses valid jsonl entries in order', async () => {
    writeFileSync(
      file,
      [
        JSON.stringify({ content: 'first' }),
        JSON.stringify({ content: 'second' }),
        '',
        JSON.stringify({ content: 'third' }),
      ].join('\n'),
      'utf-8',
    );
    const entries = await loadInputHistory(file);
    expect(entries).toEqual([
      { content: 'first' },
      { content: 'second' },
      { content: 'third' },
    ]);
  });

  it('skips malformed lines without aborting the load', async () => {
    writeFileSync(
      file,
      [
        JSON.stringify({ content: 'good' }),
        'not json',
        JSON.stringify({ wrong_field: 'x' }),
        JSON.stringify({ content: 'tail' }),
      ].join('\n'),
      'utf-8',
    );
    const entries = await loadInputHistory(file);
    expect(entries).toEqual([{ content: 'good' }, { content: 'tail' }]);
  });

  it('appends a new entry and creates the parent directory', async () => {
    const nested = join(dir, 'nested', 'sub', 'history.jsonl');
    const written = await appendInputHistory(nested, 'hello');
    expect(written).toBe(true);
    const raw = readFileSync(nested, 'utf-8').trim().split('\n');
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0]!)).toEqual({ content: 'hello' });
  });

  it('skips empty / whitespace-only entries', async () => {
    expect(await appendInputHistory(file, '')).toBe(false);
    expect(await appendInputHistory(file, '   ')).toBe(false);
    expect(await loadInputHistory(file)).toEqual([]);
  });

  it('skips when content equals the previous entry (consecutive dedup)', async () => {
    expect(await appendInputHistory(file, 'a')).toBe(true);
    expect(await appendInputHistory(file, 'a', 'a')).toBe(false);
    expect(await appendInputHistory(file, 'b', 'a')).toBe(true);
    const entries = await loadInputHistory(file);
    expect(entries).toEqual([{ content: 'a' }, { content: 'b' }]);
  });

  it('trims whitespace before persisting', async () => {
    expect(await appendInputHistory(file, '  hi  ')).toBe(true);
    const entries = await loadInputHistory(file);
    expect(entries).toEqual([{ content: 'hi' }]);
  });
});
