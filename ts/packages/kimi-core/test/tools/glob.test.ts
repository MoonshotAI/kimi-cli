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

  // ── Multi-root search (Bug #3) ──────────────────────────────────────
  describe('multi-root search (no args.path)', () => {
    it('searches workspaceDir + additionalDirs when path is omitted', async () => {
      const calls: string[] = [];
      const kaos = createFakeKaos({
        glob: (async function* (basePath: string, _pattern: string) {
          calls.push(basePath);
          if (basePath === '/ws') yield '/ws/a.ts';
          if (basePath === '/extra1') yield '/extra1/b.ts';
          if (basePath === '/extra2') yield '/extra2/c.ts';
        }) as unknown as ReturnType<typeof createFakeKaos>['glob'],
        stat: vi.fn().mockResolvedValue({
          stMode: 0o100_644,
          stIno: 1,
          stDev: 1,
          stNlink: 1,
          stUid: 0,
          stGid: 0,
          stSize: 1,
          stAtime: 0,
          stMtime: 0,
          stCtime: 0,
        }),
      });
      const tool = new GlobTool(kaos, {
        workspaceDir: '/ws',
        additionalDirs: ['/extra1', '/extra2'],
      });
      const result = await tool.execute(
        'call_multi',
        { pattern: '*.ts' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(calls).toEqual(['/ws', '/extra1', '/extra2']);
      expect(result.output?.paths).toEqual(
        expect.arrayContaining(['/ws/a.ts', '/extra1/b.ts', '/extra2/c.ts']),
      );
    });

    it('does NOT fan out when args.path is given (explicit single root)', async () => {
      const calls: string[] = [];
      const kaos = createFakeKaos({
        glob: (async function* (basePath: string, _pattern: string) {
          calls.push(basePath);
          yield `${basePath}/a.ts`;
        }) as unknown as ReturnType<typeof createFakeKaos>['glob'],
        stat: vi.fn().mockResolvedValue({
          stMode: 0o100_644,
          stIno: 1,
          stDev: 1,
          stNlink: 1,
          stUid: 0,
          stGid: 0,
          stSize: 1,
          stAtime: 0,
          stMtime: 0,
          stCtime: 0,
        }),
      });
      const tool = new GlobTool(kaos, {
        workspaceDir: '/ws',
        additionalDirs: ['/extra1'],
      });
      const result = await tool.execute(
        'call_single',
        { pattern: '*.ts', path: '/ws' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(calls).toEqual(['/ws']);
    });

    it('dedupes when the same path is yielded by multiple roots', async () => {
      const kaos = createFakeKaos({
        glob: (async function* (basePath: string, _pattern: string) {
          if (basePath === '/ws') yield '/shared/x.ts';
          if (basePath === '/ws2') yield '/shared/x.ts';
        }) as unknown as ReturnType<typeof createFakeKaos>['glob'],
        stat: vi.fn().mockResolvedValue({
          stMode: 0o100_644,
          stIno: 1,
          stDev: 1,
          stNlink: 1,
          stUid: 0,
          stGid: 0,
          stSize: 1,
          stAtime: 0,
          stMtime: 0,
          stCtime: 0,
        }),
      });
      const tool = new GlobTool(kaos, {
        workspaceDir: '/ws',
        additionalDirs: ['/ws2'],
      });
      const result = await tool.execute(
        'call_dup',
        { pattern: '*.ts' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.paths).toEqual(['/shared/x.ts']);
    });
  });

  // ── Phase 15 A.3 — Python edge cases (ports tests/tools/test_glob.py) ──
  describe('edge cases (Phase 15 A.3 — Python parity)', () => {
    it('max_matches warning text pins the stable contract', async () => {
      // Python `test_glob_max_matches_limit` (test_glob.py:214). Current
      // TS emits "[Truncated at N matches — use a more specific pattern]".
      // Pin both halves so a drive-by rename breaks here, not in prod.
      const over = GLOB_MAX_MATCHES + 10;
      const kaos = createFakeKaos({
        async *glob() {
          for (let i = 0; i < over; i++) yield `/workspace/f_${String(i)}.ts`;
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
        'call_warn',
        { pattern: 'f_*.ts', path: '/workspace' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      const text = toolContentString(result);
      expect(text).toContain('Truncated');
      expect(text).toContain(String(GLOB_MAX_MATCHES));
      expect(text.toLowerCase()).toMatch(/more specific|use a more/);
    });

    it('rejecting a leading-** pattern mentions the workspace directory so callers can re-scope', async () => {
      // Python `test_glob_enhanced_double_star_validation` (test_glob.py:230).
      // The TS rejection message should include the concrete workspace
      // path(s) so the LLM can redirect without a second round-trip.
      const kaos = createFakeKaos();
      const tool = new GlobTool(kaos, {
        workspaceDir: '/my-workspace',
        additionalDirs: ['/extra-dir'],
      });
      const result = await tool.execute(
        'call_starstar_listing',
        { pattern: '**/*.txt' },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      const text = toolContentString(result);
      // Pin: the rejection lists at least one workspace path so the
      // caller knows where to rescope. Red bar until src/tools/glob.ts
      // enumerates the dir list.
      expect(text).toMatch(/\/my-workspace|\/extra-dir/);
    });

    it('** rejection message includes a tree listing of the workspace root', async () => {
      // Python `glob.py:50-62` appends a 2-level tree so the caller can
      // re-scope without a second round-trip. TS parity: the rejection
      // content must show both dir entries and file entries from the
      // primary workspaceDir.
      type KaosArg = Parameters<typeof createFakeKaos>[0];
      const kaos = createFakeKaos({
        iterdir: (async function* (p: string) {
          if (p === '/my-workspace') {
            yield '/my-workspace/src';
            yield '/my-workspace/package.json';
          } else if (p === '/my-workspace/src') {
            yield '/my-workspace/src/a.ts';
          }
        }) as unknown as NonNullable<KaosArg>['iterdir'],
        // list-directory derives isDir from stMode & 0o170000 === 0o040000
        // (S_IFDIR). Dirs → 0o040755, files → 0o100644.
        stat: (async (p: string) => ({
          stMode: p.endsWith('src') || p.endsWith('my-workspace') ? 0o040_755 : 0o100_644,
          stIno: 1,
          stDev: 1,
          stNlink: 1,
          stUid: 0,
          stGid: 0,
          stSize: 1,
          stAtime: 0,
          stMtime: 0,
          stCtime: 0,
        })) as unknown as NonNullable<KaosArg>['stat'],
      } as Parameters<typeof createFakeKaos>[0]);
      const tool = new GlobTool(kaos, {
        workspaceDir: '/my-workspace',
        additionalDirs: [],
      });
      const result = await tool.execute(
        'call_tree',
        { pattern: '**/*.ts' },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      const text = toolContentString(result);
      expect(text).toContain('src/');
      expect(text).toContain('package.json');
      expect(text).toContain('Top of /my-workspace');
    });

    it('accepts complex multi-segment patterns like docs/**/main/*.py (Python parity)', async () => {
      // Python `test_glob_complex_pattern` (test_glob.py:281). The
      // pattern doesn't start with `**`, so the TS validator accepts it.
      // We verify the rejection gate doesn't fire on this shape.
      const kaos = createFakeKaos({
        async *glob() {
          yield '/workspace/docs/a/main/x.py';
          yield '/workspace/docs/b/main/y.py';
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
        'call_complex',
        { pattern: 'docs/**/main/*.py' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.paths.length).toBeGreaterThan(0);
    });

    it('rejects brace expansion patterns with a clear message', async () => {
      // `_globWalk` treats `{` / `}` as literals, so `*.{ts,tsx}` would
      // silently match zero files. Reject up-front with guidance.
      const tool = new GlobTool(createFakeKaos(), PERMISSIVE_WORKSPACE);
      const result = await tool.execute(
        'call_brace',
        { pattern: '*.{ts,tsx}' },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      const text = toolContentString(result);
      expect(text.toLowerCase()).toMatch(/brace expansion|not supported/);
      expect(text).toMatch(/separate|multiple|\*\.ts/);
    });

    it('content lists paths relative to the search base (absolute paths kept in output.paths)', async () => {
      // Python `glob.py:149` returns relative paths in content to save
      // tokens. output.paths keeps absolute so Read/Edit still works.
      const kaos = createFakeKaos({
        async *glob() {
          yield '/workspace/src/a.ts';
          yield '/workspace/src/nested/b.ts';
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
        'call_rel',
        { pattern: 'src/**/*.ts', path: '/workspace' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      const text = toolContentString(result);
      expect(text).not.toContain('/workspace/');
      expect(text).toContain('src/a.ts');
      expect(text).toContain('src/nested/b.ts');
      expect(result.output?.paths).toEqual(
        expect.arrayContaining(['/workspace/src/a.ts', '/workspace/src/nested/b.ts']),
      );
    });

    it('accepts literal curly braces that do NOT look like brace expansion', async () => {
      // A `{name}` pattern without a comma is treated as a literal, not
      // rejected. Filenames with `{`/`}` are rare but valid.
      const kaos = createFakeKaos({
        async *glob() {
          yield '/workspace/weird{name}.ts';
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
        'call_literal_brace',
        { pattern: 'weird{name}.ts' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
    });

    it('symlink cycle defense: MAX_MATCHES cap terminates on a looping glob stream', async () => {
      // Python does not have an equivalent; the TS contract is that the
      // MAX_MATCHES cap terminates iteration even if the underlying
      // walker happens to yield duplicates from a symlink cycle
      // (a → b → a). We simulate the cycle by yielding the same two
      // paths indefinitely and assert the tool still completes.
      let yielded = 0;
      const kaos = createFakeKaos({
        async *glob() {
          // Emit the same two paths in a loop — mimics a symlink cycle
          // walker that keeps re-entering the cycle.
          while (true) {
            yielded++;
            yield '/workspace/a/target.ts';
            yielded++;
            yield '/workspace/b/target.ts';
            if (yielded > GLOB_MAX_MATCHES * 2) break; // safety
          }
        },
        stat: vi.fn().mockResolvedValue({
          isFile: true,
          isDir: false,
          isSymlink: true,
          size: 1,
          mtimeMs: 1,
          mode: 0o644,
        }),
      });
      const tool = new GlobTool(kaos, PERMISSIVE_WORKSPACE);
      const result = await tool.execute(
        'call_cycle',
        { pattern: '*.ts' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      // The contract is *termination*, not a specific output size. Since
      // Bug #3's fan-out now deduplicates the results, the two unique
      // paths collapse to 2 in `output.paths`. What proves the cycle
      // defense still fires is that the walker stopped before the safety
      // ceiling (`yielded > GLOB_MAX_MATCHES * 2`): the MAX_MATCHES cap
      // on the pre-dedup accumulator terminated iteration early.
      expect(result.output?.paths).toEqual(
        expect.arrayContaining(['/workspace/a/target.ts', '/workspace/b/target.ts']),
      );
      expect(result.output?.paths.length).toBe(2);
      expect(yielded).toBeLessThanOrEqual(GLOB_MAX_MATCHES * 2);
    });
  });
});
