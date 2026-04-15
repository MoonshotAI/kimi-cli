/**
 * Covers: EditTool (v2 §9-F / Appendix E.3).
 *
 * Pins:
 *   - Exact string replacement (first occurrence)
 *   - replace_all flag → all occurrences
 *   - old_string not found → isError
 *   - old_string not unique (multiple matches, replace_all=false) → isError
 *   - replacementCount in output
 *   - getActivityDescription format
 */

import { describe, expect, it, vi } from 'vitest';

import { EditTool } from '../../src/tools/index.js';
import { createFakeKaos } from './fixtures/fake-kaos.js';

function makeEditTool(fileContent?: string): EditTool {
  const kaos = createFakeKaos({
    readText: vi.fn().mockResolvedValue(fileContent ?? ''),
    writeText: vi.fn().mockResolvedValue(0),
  });
  return new EditTool(kaos);
}

describe('EditTool', () => {
  it('has name "Edit" and a non-empty description', () => {
    const tool = makeEditTool();
    expect(tool.name).toBe('Edit');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('inputSchema accepts valid EditInput', () => {
    const tool = makeEditTool();
    const result = tool.inputSchema.safeParse({
      path: '/tmp/file.ts',
      old_string: 'foo',
      new_string: 'bar',
    });
    expect(result.success).toBe(true);
  });

  it('inputSchema accepts replace_all flag', () => {
    const tool = makeEditTool();
    const result = tool.inputSchema.safeParse({
      path: '/tmp/file.ts',
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
    });
    expect(result.success).toBe(true);
  });

  it('replaces first occurrence of old_string with new_string', async () => {
    const tool = makeEditTool('hello world');
    const result = await tool.execute(
      'call_1',
      { path: '/tmp/file.ts', old_string: 'hello', new_string: 'goodbye' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.replacementCount).toBe(1);
  });

  it('replace_all replaces all occurrences', async () => {
    const tool = makeEditTool('aaa bbb aaa ccc aaa');
    const result = await tool.execute(
      'call_2',
      { path: '/tmp/file.ts', old_string: 'aaa', new_string: 'xxx', replace_all: true },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.replacementCount).toBe(3);
  });

  it('returns isError when old_string is not found', async () => {
    const tool = makeEditTool('hello world');
    const result = await tool.execute(
      'call_3',
      { path: '/tmp/file.ts', old_string: 'missing', new_string: 'replacement' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });

  it('returns isError when old_string is not unique and replace_all is false', async () => {
    const tool = makeEditTool('foo bar foo baz');
    const result = await tool.execute(
      'call_4',
      { path: '/tmp/file.ts', old_string: 'foo', new_string: 'qux' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });

  it('getActivityDescription returns "Editing <path>"', () => {
    const tool = makeEditTool();
    const desc = tool.getActivityDescription({
      path: '/foo/bar.ts',
      old_string: 'a',
      new_string: 'b',
    });
    expect(desc).toBe('Editing /foo/bar.ts');
  });
});
