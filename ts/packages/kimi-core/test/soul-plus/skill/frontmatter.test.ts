/**
 * Frontmatter parser — Slice 2.5 unit tests.
 */

import { describe, expect, it } from 'vitest';

import { FrontmatterError, parseFrontmatter } from '../../../src/soul-plus/skill/frontmatter.js';

describe('parseFrontmatter', () => {
  it('returns null data when there is no frontmatter fence', () => {
    const result = parseFrontmatter('# hello\nworld');
    expect(result.data).toBeNull();
    expect(result.body).toBe('# hello\nworld');
  });

  it('parses simple scalar keys', () => {
    const result = parseFrontmatter(
      ['---', 'name: my-skill', 'description: do things', '---', 'body text'].join('\n'),
    );
    expect(result.data).toEqual({ name: 'my-skill', description: 'do things' });
    expect(result.body).toBe('body text');
  });

  it('supports double-quoted and single-quoted strings', () => {
    const result = parseFrontmatter(
      ['---', 'name: "quoted name"', "description: 'single quoted'", '---', ''].join('\n'),
    );
    expect(result.data).toEqual({ name: 'quoted name', description: 'single quoted' });
  });

  it('parses inline flow arrays', () => {
    const result = parseFrontmatter(
      ['---', 'allowed-tools: [Bash, Read, "Grep"]', '---'].join('\n'),
    );
    expect(result.data).toEqual({ 'allowed-tools': ['Bash', 'Read', 'Grep'] });
  });

  it('parses block list arrays', () => {
    const result = parseFrontmatter(
      ['---', 'allowed-tools:', '  - Bash', '  - Read', '  - Grep', '---'].join('\n'),
    );
    expect(result.data).toEqual({ 'allowed-tools': ['Bash', 'Read', 'Grep'] });
  });

  it('recognises booleans / numbers / nulls', () => {
    const result = parseFrontmatter(
      ['---', 'enabled: true', 'count: 42', 'ratio: 1.5', 'nothing: null', '---'].join('\n'),
    );
    expect(result.data).toEqual({
      enabled: true,
      count: 42,
      ratio: 1.5,
      nothing: null,
    });
  });

  it('strips line comments outside quotes', () => {
    const result = parseFrontmatter(
      ['---', 'name: my-skill  # trailing comment', '# full line comment', '---'].join('\n'),
    );
    expect(result.data).toEqual({ name: 'my-skill' });
  });

  it('treats `#` inside a quoted value as part of the value', () => {
    const result = parseFrontmatter(['---', 'name: "foo#bar"', '---'].join('\n'));
    expect(result.data).toEqual({ name: 'foo#bar' });
  });

  it('returns data={} when the fence is empty', () => {
    const result = parseFrontmatter(['---', '---', 'body'].join('\n'));
    expect(result.data).toEqual({});
    expect(result.body).toBe('body');
  });

  it('returns data=null when the closing fence is missing', () => {
    const result = parseFrontmatter(['---', 'name: x', 'no close'].join('\n'));
    expect(result.data).toBeNull();
  });

  it('throws FrontmatterError on unterminated quoted strings', () => {
    expect(() => parseFrontmatter(['---', 'name: "unterminated', '---'].join('\n'))).toThrow(
      FrontmatterError,
    );
  });

  it('throws FrontmatterError on indented top-level keys (nested maps unsupported)', () => {
    expect(() => parseFrontmatter(['---', 'nested:', '  child: value', '---'].join('\n'))).toThrow(
      FrontmatterError,
    );
  });
});
