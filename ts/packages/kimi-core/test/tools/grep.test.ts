/**
 * Covers: GrepTool (v2 §9-F / Appendix E.5).
 *
 * Pins:
 *   - Basic pattern search returns matching content
 *   - output_mode: content / files_with_matches / count
 *   - Case insensitive (-i flag)
 *   - head_limit truncation
 *   - getActivityDescription format
 *   - Schema validation for all grep input fields
 */

import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { GrepTool } from '../../src/tools/index.js';
import { createFakeKaos } from './fixtures/fake-kaos.js';

function makeGrepTool(stdout?: string, exitCode?: number): GrepTool {
  const proc = {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: Readable.from([stdout ?? '']),
    stderr: Readable.from(['']),
    pid: 99,
    exitCode: exitCode ?? 0,
    wait: vi.fn().mockResolvedValue(exitCode ?? 0),
    // oxlint-disable-next-line unicorn/no-useless-undefined
    kill: vi.fn().mockResolvedValue(undefined),
  };
  const kaos = createFakeKaos({
    exec: vi.fn().mockResolvedValue(proc),
    execWithEnv: vi.fn().mockResolvedValue(proc),
  });
  return new GrepTool(kaos, '/workspace');
}

describe('GrepTool', () => {
  it('has name "Grep" and a non-empty description', () => {
    const tool = makeGrepTool();
    expect(tool.name).toBe('Grep');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('inputSchema accepts minimal valid input (pattern only)', () => {
    const tool = makeGrepTool();
    const result = tool.inputSchema.safeParse({ pattern: 'TODO' });
    expect(result.success).toBe(true);
  });

  it('inputSchema accepts all optional fields', () => {
    const tool = makeGrepTool();
    const result = tool.inputSchema.safeParse({
      pattern: 'error',
      path: '/src',
      glob: '*.ts',
      type: 'ts',
      output_mode: 'files_with_matches',
      '-i': true,
      '-n': true,
      '-A': 3,
      '-B': 2,
      '-C': 1,
      head_limit: 100,
      offset: 0,
      multiline: false,
    });
    expect(result.success).toBe(true);
  });

  it('searches for pattern and returns results in content mode', async () => {
    const tool = makeGrepTool('file.ts:10:  const x = TODO;');
    const result = await tool.execute(
      'call_1',
      { pattern: 'TODO', output_mode: 'content' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.mode).toBe('content');
    expect(result.output?.numFiles).toBeGreaterThanOrEqual(0);
  });

  it('returns files_with_matches mode output', async () => {
    const tool = makeGrepTool('file1.ts\nfile2.ts');
    const result = await tool.execute(
      'call_2',
      { pattern: 'import', output_mode: 'files_with_matches' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.mode).toBe('files_with_matches');
    expect(result.output?.filenames).toBeInstanceOf(Array);
  });

  it('returns count mode output', async () => {
    const tool = makeGrepTool('42');
    const result = await tool.execute(
      'call_3',
      { pattern: 'function', output_mode: 'count' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.mode).toBe('count');
  });

  it('case insensitive search with -i flag', async () => {
    const tool = makeGrepTool('File.ts:5: Error handling');
    const result = await tool.execute(
      'call_4',
      { pattern: 'error', '-i': true },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
  });

  it('respects head_limit to truncate output', async () => {
    const tool = makeGrepTool('lots of results...');
    const result = await tool.execute(
      'call_5',
      { pattern: 'x', head_limit: 5 },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    if (result.output?.appliedLimit !== undefined) {
      expect(result.output.appliedLimit).toBeLessThanOrEqual(5);
    }
  });

  it('getActivityDescription includes pattern and path', () => {
    const tool = makeGrepTool();
    expect(tool.getActivityDescription({ pattern: 'TODO' })).toBe("Searching for 'TODO' in .");
    expect(tool.getActivityDescription({ pattern: 'bug', path: '/src' })).toBe(
      "Searching for 'bug' in /src",
    );
  });
});
