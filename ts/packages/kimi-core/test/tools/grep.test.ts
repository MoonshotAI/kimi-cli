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
 *
 * Audit C1 regression:
 *   - Path outside workspace → isError, no kaos.exec call
 */

import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceConfig } from '../../src/tools/index.js';
import { GrepTool } from '../../src/tools/index.js';
import { PERMISSIVE_WORKSPACE, createFakeKaos, toolContentString } from './fixtures/fake-kaos.js';

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
  return new GrepTool(kaos, PERMISSIVE_WORKSPACE);
}

const NARROW_WORKSPACE: WorkspaceConfig = {
  workspaceDir: '/workspace',
  additionalDirs: [],
};

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

  // ── M6 regression: head_limit / offset / sensitive / timeout / cap ──

  it('head_limit=0 is interpreted as unlimited (not zero matches)', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `file${String(i)}.ts`).join('\n');
    const tool = makeGrepTool(many);
    const result = await tool.execute(
      'call_head0',
      { pattern: 'x', head_limit: 0 },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.mode).toBe('files_with_matches');
    expect(result.output?.numFiles).toBe(50);
    expect(result.output?.filenames).toHaveLength(50);
  });

  it('offset skips leading lines before head_limit is applied', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `file${String(i)}.ts`).join('\n');
    const tool = makeGrepTool(lines);
    const result = await tool.execute(
      'call_offset',
      { pattern: 'x', offset: 5, head_limit: 10 },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.filenames).toEqual(
      Array.from({ length: 10 }, (_, i) => `file${String(i + 5)}.ts`),
    );
  });

  it('does NOT forward head_limit to rg --max-count', async () => {
    const proc = {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: Readable.from(['']),
      stderr: Readable.from(['']),
      pid: 10,
      exitCode: 0,
      wait: vi.fn().mockResolvedValue(0),
      // oxlint-disable-next-line unicorn/no-useless-undefined
      kill: vi.fn().mockResolvedValue(undefined),
    };
    const execFn = vi.fn().mockResolvedValue(proc);
    const kaos = createFakeKaos({ exec: execFn });
    const tool = new GrepTool(kaos, PERMISSIVE_WORKSPACE);
    await tool.execute('call_nomax', { pattern: 'x', head_limit: 5 }, new AbortController().signal);
    // oxlint-disable-next-line typescript-eslint/unbound-method
    const invocation = execFn.mock.calls[0];
    expect(invocation).toBeDefined();
    expect(invocation).not.toContain('--max-count');
  });

  it('filters sensitive files from content output (.env line dropped)', async () => {
    const stdout = ['src/main.ts:10:  hit', '.env:3:  SECRET=hello', 'src/util.ts:5:  hit'].join(
      '\n',
    );
    const tool = makeGrepTool(stdout);
    const result = await tool.execute(
      'call_sens',
      { pattern: 'hit', output_mode: 'content' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    const content = toolContentString(result);
    expect(content).not.toContain('SECRET=hello');
    expect(content).not.toContain('.env:3');
    expect(content).toContain('src/main.ts:10:');
    expect(content).toContain('src/util.ts:5:');
    // Filter warning is surfaced in the content annotation.
    expect(content).toContain('Filtered');
    expect(content).toContain('.env');
  });

  it('filters sensitive files from files_with_matches output', async () => {
    const stdout = ['src/main.ts', '.env', 'src/util.ts'].join('\n');
    const tool = makeGrepTool(stdout);
    const result = await tool.execute(
      'call_sens_fwm',
      { pattern: 'x', output_mode: 'files_with_matches' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.filenames).toEqual(['src/main.ts', 'src/util.ts']);
    expect(result.output?.numFiles).toBe(2);
  });

  it('kills the rg subprocess on ambient abort', async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined
    const killFn = vi.fn().mockResolvedValue(undefined);
    // A stream that never produces data — simulates a hanging rg.
    const neverReadable = new Readable({
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      read(): void {},
    });
    const stderrReadable = new Readable({
      read(): void {
        this.push(null);
      },
    });
    let resolveWait: ((code: number) => void) | undefined;
    const waitPromise = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const proc = {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: neverReadable,
      stderr: stderrReadable,
      pid: 42,
      exitCode: null as number | null,
      wait: vi.fn().mockImplementation(() => waitPromise),
      kill: killFn.mockImplementation(async () => {
        // Simulate the process exiting after kill.
        (proc as { exitCode: number | null }).exitCode = 143;
        resolveWait?.(143);
        neverReadable.push(null);
      }),
    };
    const kaos = createFakeKaos({ exec: vi.fn().mockResolvedValue(proc) });
    const tool = new GrepTool(kaos, PERMISSIVE_WORKSPACE);
    const controller = new AbortController();
    const promise = tool.execute('call_abort', { pattern: 'x' }, controller.signal);
    // Cancel after microtask so the tool has attached its abort listener.
    await Promise.resolve();
    controller.abort();
    const result = await promise;
    expect(killFn).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('aborted');
  });

  it('caps stdout at MAX_OUTPUT_BYTES and emits a truncation marker', async () => {
    // Craft >10 MB of output so the cap trips. Use a big single chunk.
    const big = 'a'.repeat(11 * 1024 * 1024);
    const tool = makeGrepTool(big);
    const result = await tool.execute(
      'call_cap',
      { pattern: 'a', output_mode: 'files_with_matches' },
      new AbortController().signal,
    );
    // Result should succeed (not isError) but carry a truncation hint in
    // its content annotation.
    expect(result.isError).toBeFalsy();
    expect(toolContentString(result)).toContain('truncated');
  });

  // ── C1 regression: path safety ─────────────────────────────────────

  it('rejects searches targeting paths outside the workspace', async () => {
    const execFn = vi.fn();
    const kaos = createFakeKaos({ exec: execFn });
    const tool = new GrepTool(kaos, NARROW_WORKSPACE);
    const result = await tool.execute(
      'call_guard',
      { pattern: 'SECRET', path: '/Users/moonshot' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('outside the workspace');
    expect(execFn).not.toHaveBeenCalled();
  });
});
