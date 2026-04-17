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

  // ── Phase 15 A.4 — Python edge cases (ports tests/tools/test_grep.py) ──
  describe('edge cases (Phase 15 A.4 — Python parity)', () => {
    it('invalid regex pattern surfaces an error (Python test_grep_invalid_pattern)', async () => {
      // rg exits with code 2 when the pattern is malformed.
      const tool = makeGrepTool('', 2);
      const result = await tool.execute(
        'call_invalid_re',
        { pattern: '[invalid' },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      // Current TS emits "ripgrep error"; pin either that or a
      // Python-parity "Failed to grep" so one-word renames don't silently
      // drop the error signal.
      expect(toolContentString(result).toLowerCase()).toMatch(/ripgrep|failed|error/);
    });

    it('multiline mode forwards -U --multiline-dotall to rg', async () => {
      // Python test_grep_multiline_mode (test_grep.py:266). Pin the rg
      // arg shape so a future rewrite keeps cross-line matching.
      const proc = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: Readable.from(['']),
        stderr: Readable.from(['']),
        pid: 1,
        exitCode: 0,
        wait: vi.fn().mockResolvedValue(0),
        kill: vi.fn().mockResolvedValue(undefined),
      };
      const execFn = vi.fn().mockResolvedValue(proc);
      const kaos = createFakeKaos({ exec: execFn });
      const tool = new GrepTool(kaos, PERMISSIVE_WORKSPACE);
      await tool.execute(
        'call_multiline',
        { pattern: 'foo.*bar', multiline: true },
        new AbortController().signal,
      );
      const args = execFn.mock.calls[0];
      expect(args).toBeDefined();
      expect(args).toContain('-U');
      expect(args).toContain('--multiline-dotall');
    });

    it('filters sensitive context lines (hyphen delimiter) from content output', async () => {
      // Python test_grep_filters_sensitive_content (test_grep.py:862+).
      // rg context lines use `-` as the delimiter: "file:N:match" for
      // match lines, "file-N-context" for context lines. The sensitive
      // filter must drop BOTH formats when the file is sensitive.
      const stdout = [
        'src/main.ts:10:matched',
        '.env-3-secret context line',
        '.env:4:SECRET=abc',
        'src/util.ts:7:also matched',
      ].join('\n');
      const tool = makeGrepTool(stdout);
      const result = await tool.execute(
        'call_sens_ctx',
        { pattern: 'x', output_mode: 'content', '-A': 1 },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      const content = toolContentString(result);
      // Red bar: context line from .env must NOT appear in output.
      expect(content).not.toContain('secret context line');
      expect(content).not.toContain('SECRET=abc');
      expect(content).toContain('src/main.ts:10');
      expect(content).toContain('src/util.ts:7');
    });

    it('filters sensitive files whose basename contains hyphens (e.g. id_rsa-backup)', async () => {
      // Pins that the sensitive filter keys on the pathname, not a
      // delimiter-based split, so a hyphenated basename like
      // `id_rsa-backup` is still caught. Red bar if src loses this
      // behaviour under a refactor.
      const stdout = [
        'src/main.ts:1:hit',
        'secrets/id_rsa-backup:2:BEGIN PRIVATE KEY',
        'src/util.ts:3:hit',
      ].join('\n');
      const tool = makeGrepTool(stdout);
      const result = await tool.execute(
        'call_sens_hyphen',
        { pattern: 'x', output_mode: 'content' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      const content = toolContentString(result);
      expect(content).not.toContain('BEGIN PRIVATE KEY');
      expect(content).not.toContain('id_rsa-backup:2');
      expect(content).toContain('src/main.ts:1');
    });

    it('large output with head_limit=0 still stops at MAX_OUTPUT_BYTES (Python parity)', async () => {
      // Python test_grep_output_truncation (test_grep.py:240). 2000 lines
      // + head_limit=0 means "unlimited"; the 10 MB buffer cap is the
      // backstop.
      const big = Array.from({ length: 20_000 }, (_, i) => `f_${String(i)}.ts:1:hit`).join('\n');
      const huge = big + '\n' + 'z'.repeat(11 * 1024 * 1024);
      const tool = makeGrepTool(huge);
      const result = await tool.execute(
        'call_output_trunc',
        { pattern: 'x', output_mode: 'content', head_limit: 0 },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(toolContentString(result)).toContain('truncated');
    });

    it('binary-file output (contains NUL byte) does not crash the tool', async () => {
      // rg's default behavior is to skip binary files, but if one slips
      // through with a NUL in the content the tool must still produce a
      // valid ToolResult. Pin non-crashing behaviour.
      const stdout = 'src/ok.ts:1:hello\nsrc/bin.dat:1:\u0000binary\nsrc/ok.ts:2:world\n';
      const tool = makeGrepTool(stdout);
      const result = await tool.execute(
        'call_binary',
        { pattern: 'x', output_mode: 'content' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      // Must not throw; at minimum the non-binary lines are surfaced.
      const content = toolContentString(result);
      expect(content).toContain('src/ok.ts:1');
    });

    it('include_ignored=true forwards --no-ignore to rg so gitignored files appear in results', async () => {
      // Python test_grep_include_ignored_allows_gitignore_hits
      // (test_grep.py:808 / :844). The schema now exposes
      // `include_ignored?: boolean` and buildRgArgs forwards `--no-ignore`.
      const proc = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: Readable.from(['']),
        stderr: Readable.from(['']),
        pid: 1,
        exitCode: 1, // "no matches" is fine
        wait: vi.fn().mockResolvedValue(1),
        kill: vi.fn().mockResolvedValue(undefined),
      };
      const execFn = vi.fn().mockResolvedValue(proc);
      const kaos = createFakeKaos({ exec: execFn });
      const tool = new GrepTool(kaos, PERMISSIVE_WORKSPACE);
      await tool.execute(
        'call_include_ignored',
        { pattern: 'x', include_ignored: true },
        new AbortController().signal,
      );
      const args = execFn.mock.calls[0];
      expect(args).toBeDefined();
      expect(args).toContain('--no-ignore');
    });
  });
});
