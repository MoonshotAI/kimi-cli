/**
 * Covers: globToRegex (v2 §9-E.5).
 *
 * Pins:
 *   - `*` stays within a segment
 *   - `**` crosses segments
 *   - `?` matches a single non-slash character
 *   - `{a,b,c}` alternation works
 *   - regex specials are escaped
 *   - patterns are anchored (no accidental substring matches)
 */

import { describe, expect, it } from 'vitest';

import { globToRegex } from '../../../src/soul-plus/permission/glob.js';

describe('globToRegex', () => {
  it('anchors the regex', () => {
    const re = globToRegex('foo');
    expect(re.test('foo')).toBe(true);
    expect(re.test('foobar')).toBe(false);
    expect(re.test('xfoo')).toBe(false);
  });

  it('* matches within a single segment only', () => {
    const re = globToRegex('src/*.ts');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/a/b.ts')).toBe(false);
  });

  it('** matches across segments', () => {
    const re = globToRegex('src/**/*.ts');
    expect(re.test('src/a/b/c.ts')).toBe(true);
    expect(re.test('src/a.ts')).toBe(true);
  });

  it('? matches a single non-slash character', () => {
    const re = globToRegex('file?.txt');
    expect(re.test('file1.txt')).toBe(true);
    expect(re.test('file.txt')).toBe(false);
    expect(re.test('file12.txt')).toBe(false);
    expect(re.test('fil/1.txt')).toBe(false);
  });

  it('brace alternation', () => {
    const re = globToRegex('*.{ts,tsx}');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('a.tsx')).toBe(true);
    expect(re.test('a.js')).toBe(false);
  });

  it('escapes regex specials', () => {
    const re = globToRegex('foo.bar+baz');
    expect(re.test('foo.bar+baz')).toBe(true);
    expect(re.test('fooxbar+baz')).toBe(false);
  });

  it('command-glob: git *', () => {
    const re = globToRegex('git *');
    expect(re.test('git status')).toBe(true);
    expect(re.test('git log --oneline')).toBe(true);
    expect(re.test('npm test')).toBe(false);
  });

  it('mcp-style prefix match', () => {
    const re = globToRegex('mcp__github__*');
    expect(re.test('mcp__github__list_issues')).toBe(true);
    expect(re.test('mcp__slack__send')).toBe(false);
  });
});
