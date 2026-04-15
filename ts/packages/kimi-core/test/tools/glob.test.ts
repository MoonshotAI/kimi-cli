/**
 * Covers: GlobTool (v2 §9-F / Appendix E.6).
 *
 * Pins:
 *   - Basic glob pattern matching
 *   - Results sorted by mtime (most recent first)
 *   - Empty result when no files match
 *   - getActivityDescription format
 *
 * Audit C2 regression:
 *   - Pattern starting with `**` → isError (would scan everything)
 *   - Path outside workspace → isError
 *   - Match count capped at MAX_MATCHES, iteration stops early
 */

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceConfig } from '../../src/tools/index.js';
import { GLOB_MAX_MATCHES, GlobTool } from '../../src/tools/index.js';
import { PERMISSIVE_WORKSPACE, createFakeKaos, toolContentString } from './fixtures/fake-kaos.js';

function makeGlobTool(): GlobTool {
  const kaos = createFakeKaos({
    // eslint-disable-next-line require-yield
    async *glob() {
      yield '/workspace/src/a.ts';
      yield '/workspace/src/b.ts';
    },
    stat: vi.fn().mockResolvedValue({
      isFile: true,
      isDir: false,
      isSymlink: false,
      size: 100,
      mtimeMs: Date.now(),
      mode: 0o644,
    }),
  });
  return new GlobTool(kaos, PERMISSIVE_WORKSPACE);
}

const NARROW_WORKSPACE: WorkspaceConfig = {
  workspaceDir: '/workspace',
  additionalDirs: [],
};

describe('GlobTool', () => {
  it('has name "Glob" and a non-empty description', () => {
    const tool = makeGlobTool();
    expect(tool.name).toBe('Glob');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('inputSchema accepts valid GlobInput', () => {
    const tool = makeGlobTool();
    const result = tool.inputSchema.safeParse({ pattern: 'src/**/*.ts' });
    expect(result.success).toBe(true);
  });

  it('inputSchema accepts pattern + path', () => {
    const tool = makeGlobTool();
    const result = tool.inputSchema.safeParse({ pattern: '*.js', path: '/src' });
    expect(result.success).toBe(true);
  });

  it('returns matching file paths', async () => {
    const tool = makeGlobTool();
    const result = await tool.execute(
      'call_1',
      { pattern: 'src/**/*.ts' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.paths).toBeInstanceOf(Array);
    expect(result.output?.paths.length).toBeGreaterThan(0);
  });

  it('results are sorted by modification time (most recent first)', async () => {
    const tool = makeGlobTool();
    const result = await tool.execute(
      'call_2',
      { pattern: 'src/**/*.ts' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.paths).toBeDefined();
  });

  it('returns empty paths array when no files match', async () => {
    const kaos = createFakeKaos({
      // eslint-disable-next-line require-yield
      async *glob() {
        /* no yields */
      },
    });
    const tool = new GlobTool(kaos, PERMISSIVE_WORKSPACE);
    const result = await tool.execute(
      'call_3',
      { pattern: 'src/**/*.nonexistent' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.paths).toEqual([]);
  });

  it('getActivityDescription returns "Searching <pattern>"', () => {
    const tool = makeGlobTool();
    expect(tool.getActivityDescription({ pattern: 'src/**/*.ts' })).toBe('Searching src/**/*.ts');
  });

  // ── C2 regression ──────────────────────────────────────────────────

  it('rejects patterns starting with `**`', async () => {
    const tool = new GlobTool(createFakeKaos(), NARROW_WORKSPACE);
    const result = await tool.execute(
      'call_c2_starstar',
      { pattern: '**' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('**');
  });

  it('rejects patterns starting with `**/...`', async () => {
    const tool = new GlobTool(createFakeKaos(), NARROW_WORKSPACE);
    const result = await tool.execute(
      'call_c2_starstar_prefix',
      { pattern: '**/*.ts' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });

  it('rejects search paths outside the workspace', async () => {
    const tool = new GlobTool(createFakeKaos(), NARROW_WORKSPACE);
    const result = await tool.execute(
      'call_c2_path',
      { path: '/', pattern: 'foo/*.ts' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('outside the workspace');
  });

  it('caps results at MAX_MATCHES and stops iterating', async () => {
    const over = GLOB_MAX_MATCHES + 50;
    let yielded = 0;
    const kaos = createFakeKaos({
      async *glob() {
        for (let i = 0; i < over; i++) {
          yielded++;
          yield `/workspace/src/file_${String(i)}.ts`;
        }
      },
      stat: vi.fn().mockResolvedValue({
        isFile: true,
        isDir: false,
        isSymlink: false,
        size: 1,
        mtimeMs: 1,
        mode: 0o644,
      }),
    });
    const tool = new GlobTool(kaos, PERMISSIVE_WORKSPACE);
    const result = await tool.execute(
      'call_c2_cap',
      { pattern: 'src/*.ts', path: '/workspace' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.paths.length).toBe(GLOB_MAX_MATCHES);
    // Early termination: iterator should have been closed shortly after
    // hitting the cap, not walked all `over` entries.
    expect(yielded).toBeLessThan(over);
    expect(toolContentString(result)).toContain('Truncated');
  });
});
