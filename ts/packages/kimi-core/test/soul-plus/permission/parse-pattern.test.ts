/**
 * Covers: PermissionRule DSL parser (v2 §9-E.3.1).
 *
 * Pins:
 *   - bare tool name → `{toolName}`
 *   - tool + arg pattern → `{toolName, argPattern}`
 *   - negation prefix retained inside argPattern
 *   - missing closing paren throws
 *   - empty pattern / empty tool name throws
 *   - `Read()` (empty args) degenerates to toolName only
 */

import { describe, expect, it } from 'vitest';

import { parsePattern } from '../../../src/soul-plus/permission/parse-pattern.js';

describe('parsePattern', () => {
  it('parses bare tool name', () => {
    expect(parsePattern('Write')).toEqual({ toolName: 'Write' });
  });

  it('parses tool name with path glob', () => {
    expect(parsePattern('Read(/etc/**)')).toEqual({
      toolName: 'Read',
      argPattern: '/etc/**',
    });
  });

  it('parses bash-style command pattern', () => {
    expect(parsePattern('Bash(git *)')).toEqual({
      toolName: 'Bash',
      argPattern: 'git *',
    });
  });

  it('retains leading "!" negation inside argPattern', () => {
    expect(parsePattern('Edit(!./src/**)')).toEqual({
      toolName: 'Edit',
      argPattern: '!./src/**',
    });
  });

  it('parses tool name containing mcp double underscore prefix', () => {
    expect(parsePattern('mcp__github__*')).toEqual({ toolName: 'mcp__github__*' });
  });

  it('throws on missing closing paren', () => {
    expect(() => parsePattern('Read(/etc/**')).toThrow(/missing closing paren/);
  });

  it('throws on empty string', () => {
    expect(() => parsePattern('')).toThrow(/empty string/);
  });

  it('throws on empty tool name before paren', () => {
    expect(() => parsePattern('(x)')).toThrow(/empty tool name/);
  });

  it('treats empty arg `Read()` as bare tool name', () => {
    expect(parsePattern('Read()')).toEqual({ toolName: 'Read' });
  });

  it('trims leading/trailing whitespace', () => {
    expect(parsePattern('  Read(./foo)  ')).toEqual({
      toolName: 'Read',
      argPattern: './foo',
    });
  });
});
