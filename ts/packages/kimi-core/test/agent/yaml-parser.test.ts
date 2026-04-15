/**
 * YAML parser tests — Slice 3.1.
 */

import { describe, expect, it } from 'vitest';

import { AgentYamlError } from '../../src/agent/errors.js';
import { parseAgentYaml } from '../../src/agent/yaml-parser.js';

describe('parseAgentYaml', () => {
  // ── Scalar values ───────────────────────────────────────────────────

  it('parses top-level string scalars', () => {
    const result = parseAgentYaml('name: default\ndescription: My agent');
    expect(result).toEqual({ name: 'default', description: 'My agent' });
  });

  it('parses boolean and null scalars', () => {
    const result = parseAgentYaml('enabled: true\ndisabled: false\nempty: null');
    expect(result).toEqual({ enabled: true, disabled: false, empty: null });
  });

  it('parses numeric scalars', () => {
    const result = parseAgentYaml('count: 42\nrate: 3.14\nneg: -7');
    expect(result).toEqual({ count: 42, rate: 3.14, neg: -7 });
  });

  it('parses double-quoted strings with escapes', () => {
    const result = parseAgentYaml('msg: "hello\\nworld"');
    expect(result['msg']).toBe('hello\nworld');
  });

  it('parses single-quoted strings', () => {
    const result = parseAgentYaml("msg: 'it''s a test'");
    expect(result['msg']).toBe("it's a test");
  });

  it('treats tilde as null', () => {
    const result = parseAgentYaml('val: ~');
    expect(result['val']).toBeNull();
  });

  // ── Comments ────────────────────────────────────────────────────────

  it('strips inline comments', () => {
    const result = parseAgentYaml('name: test # this is a comment');
    expect(result['name']).toBe('test');
  });

  it('ignores comment-only lines', () => {
    const result = parseAgentYaml('# top comment\nname: test\n# middle\nfoo: bar');
    expect(result).toEqual({ name: 'test', foo: 'bar' });
  });

  // ── Inline arrays ──────────────────────────────────────────────────

  it('parses inline arrays', () => {
    const result = parseAgentYaml('items: [a, b, c]');
    expect(result['items']).toEqual(['a', 'b', 'c']);
  });

  it('parses empty inline array', () => {
    const result = parseAgentYaml('items: []');
    expect(result['items']).toEqual([]);
  });

  it('parses inline array with quoted strings', () => {
    const result = parseAgentYaml('items: ["hello world", \'foo bar\']');
    expect(result['items']).toEqual(['hello world', 'foo bar']);
  });

  // ── Block arrays ───────────────────────────────────────────────────

  it('parses block arrays', () => {
    const yaml = `tools:
  - shell
  - read_file
  - write_file`;
    const result = parseAgentYaml(yaml);
    expect(result['tools']).toEqual(['shell', 'read_file', 'write_file']);
  });

  it('parses block arrays with blank lines', () => {
    const yaml = `tools:
  - shell

  - read_file`;
    const result = parseAgentYaml(yaml);
    expect(result['tools']).toEqual(['shell', 'read_file']);
  });

  // ── Block scalars ──────────────────────────────────────────────────

  it('parses literal block scalar (|)', () => {
    const yaml = `prompt: |
  line one
  line two
  line three`;
    const result = parseAgentYaml(yaml);
    expect(result['prompt']).toBe('line one\nline two\nline three\n');
  });

  it('parses literal block scalar with blank lines', () => {
    const yaml = `prompt: |
  paragraph one

  paragraph two`;
    const result = parseAgentYaml(yaml);
    expect(result['prompt']).toBe('paragraph one\n\nparagraph two\n');
  });

  it('parses folded block scalar (>)', () => {
    const yaml = `prompt: >
  line one
  line two`;
    const result = parseAgentYaml(yaml);
    expect(result['prompt']).toBe('line one line two\n');
  });

  // M2 regression: consecutive short lines must all fold
  it('folded block scalar folds consecutive single-char lines', () => {
    const yaml = `prompt: >
  a
  b
  c`;
    const result = parseAgentYaml(yaml);
    expect(result['prompt']).toBe('a b c\n');
  });

  it('block scalar ends at next top-level key', () => {
    const yaml = `prompt: |
  hello world
name: test`;
    const result = parseAgentYaml(yaml);
    expect(result['prompt']).toBe('hello world\n');
    expect(result['name']).toBe('test');
  });

  // ── Nested mappings ────────────────────────────────────────────────

  it('parses nested mapping with scalar values', () => {
    const yaml = `tools:
  include: shell
  exclude: danger`;
    const result = parseAgentYaml(yaml);
    expect(result['tools']).toEqual({ include: 'shell', exclude: 'danger' });
  });

  it('parses nested mapping with block arrays', () => {
    const yaml = `tools:
  include:
    - shell
    - read_file
  exclude:
    - rm_rf`;
    const result = parseAgentYaml(yaml);
    expect(result['tools']).toEqual({
      include: ['shell', 'read_file'],
      exclude: ['rm_rf'],
    });
  });

  it('parses nested mapping with inline arrays', () => {
    const yaml = `skills:
  include: [commit, review]
  exclude: [dangerous]`;
    const result = parseAgentYaml(yaml);
    expect(result['skills']).toEqual({
      include: ['commit', 'review'],
      exclude: ['dangerous'],
    });
  });

  // ── Full agent file ────────────────────────────────────────────────

  it('parses a complete agent YAML file', () => {
    const yaml = `name: my-agent
description: A test agent
model: k25
thinking_mode: auto
inherits: default
tools:
  include:
    - shell
    - read_file
skills:
  exclude:
    - dangerous`;
    const result = parseAgentYaml(yaml);
    expect(result['name']).toBe('my-agent');
    expect(result['description']).toBe('A test agent');
    expect(result['model']).toBe('k25');
    expect(result['thinking_mode']).toBe('auto');
    expect(result['inherits']).toBe('default');
    expect(result['tools']).toEqual({ include: ['shell', 'read_file'] });
    expect(result['skills']).toEqual({ exclude: ['dangerous'] });
  });

  // ── Error cases ────────────────────────────────────────────────────

  it('throws on unexpected indentation', () => {
    expect(() => parseAgentYaml('  bad: indent')).toThrow(AgentYamlError);
  });

  it('throws on missing colon', () => {
    expect(() => parseAgentYaml('no colon here')).toThrow(AgentYamlError);
  });

  it('throws on unterminated inline array', () => {
    expect(() => parseAgentYaml('items: [a, b')).toThrow(AgentYamlError);
  });

  it('throws on unterminated quoted string', () => {
    expect(() => parseAgentYaml('msg: "unterminated')).toThrow(AgentYamlError);
  });

  it('handles empty input', () => {
    expect(parseAgentYaml('')).toEqual({});
  });

  it('handles blank-only input', () => {
    expect(parseAgentYaml('   \n\n  ')).toEqual({});
  });

  // ── Null value when key has no value and next line is a new key ────

  it('treats key with no value and no nested content as null', () => {
    const yaml = `empty:
name: test`;
    const result = parseAgentYaml(yaml);
    expect(result['empty']).toBeNull();
    expect(result['name']).toBe('test');
  });
});
