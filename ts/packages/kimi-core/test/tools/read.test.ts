/**
 * Covers: ReadTool (v2 §9-F / Appendix E.1).
 *
 * Pins:
 *   - Read ASCII text file → cat -n style output
 *   - offset / limit line range
 *   - File not found → isError
 *   - Empty file → empty content
 *   - getActivityDescription format
 *   - Tool name and schema shape
 *
 * Audit C1 regression:
 *   - Absolute path outside workspace → isError PATH_OUTSIDE_WORKSPACE
 *   - `..` traversal normalizes outside workspace → isError
 *   - Sensitive file (`.env`) → isError PATH_SENSITIVE
 *   - No `kaos.readText` call when guard rejects (never reaches kaos)
 */

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceConfig } from '../../src/tools/index.js';
import { ReadTool } from '../../src/tools/index.js';
import { PERMISSIVE_WORKSPACE, createFakeKaos, toolContentString } from './fixtures/fake-kaos.js';

function makeReadTool(fileContent?: string): ReadTool {
  const kaos = createFakeKaos({
    readText: vi.fn().mockResolvedValue(fileContent ?? ''),
    stat: vi.fn().mockResolvedValue({
      isFile: true,
      isDir: false,
      isSymlink: false,
      size: (fileContent ?? '').length,
      mtimeMs: Date.now(),
      mode: 0o644,
    }),
  });
  return new ReadTool(kaos, PERMISSIVE_WORKSPACE);
}

const NARROW_WORKSPACE: WorkspaceConfig = {
  workspaceDir: '/workspace',
  additionalDirs: [],
};

describe('ReadTool', () => {
  it('has name "Read" and a non-empty description', () => {
    const tool = makeReadTool();
    expect(tool.name).toBe('Read');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('inputSchema accepts valid ReadInput', () => {
    const tool = makeReadTool();
    const result = tool.inputSchema.safeParse({ path: '/tmp/test.txt' });
    expect(result.success).toBe(true);
  });

  it('inputSchema accepts offset and limit', () => {
    const tool = makeReadTool();
    const result = tool.inputSchema.safeParse({
      path: '/tmp/test.txt',
      offset: 10,
      limit: 50,
    });
    expect(result.success).toBe(true);
  });

  it('inputSchema rejects missing path', () => {
    const tool = makeReadTool();
    const result = tool.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('reads a text file and returns content with line count', async () => {
    const content = 'line 1\nline 2\nline 3\n';
    const tool = makeReadTool(content);
    const result = await tool.execute(
      'call_1',
      { path: '/tmp/test.txt' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.lineCount).toBe(3);
    expect(result.output?.content).toContain('line 1');
  });

  it('respects offset and limit for line range reading', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const tool = makeReadTool(lines);
    const result = await tool.execute(
      'call_2',
      { path: '/tmp/big.txt', offset: 5, limit: 3 },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.content).toContain('line 6');
    expect(result.output?.lineCount).toBeLessThanOrEqual(3);
  });

  it('returns isError when file does not exist', async () => {
    const kaos = createFakeKaos({
      readText: vi.fn().mockRejectedValue(new Error('ENOENT: no such file')),
    });
    const tool = new ReadTool(kaos, PERMISSIVE_WORKSPACE);
    const result = await tool.execute(
      'call_3',
      { path: '/missing.txt' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });

  it('handles empty file gracefully', async () => {
    const tool = makeReadTool('');
    const result = await tool.execute(
      'call_4',
      { path: '/tmp/empty.txt' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output?.lineCount).toBe(0);
  });

  it('getActivityDescription returns "Reading <path>"', () => {
    const tool = makeReadTool();
    const desc = tool.getActivityDescription({ path: '/foo/bar.ts' });
    expect(desc).toBe('Reading /foo/bar.ts');
  });

  // ── C1 regression: path safety ─────────────────────────────────────

  it('rejects reads outside the workspace (absolute path)', async () => {
    const readTextFn = vi.fn();
    const kaos = createFakeKaos({ readText: readTextFn });
    const tool = new ReadTool(kaos, NARROW_WORKSPACE);
    const result = await tool.execute(
      'call_guard_abs',
      { path: '/etc/hosts' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('outside the workspace');
    expect(readTextFn).not.toHaveBeenCalled();
  });

  it('rejects path traversal that normalizes outside the workspace', async () => {
    const readTextFn = vi.fn();
    const kaos = createFakeKaos({ readText: readTextFn });
    const tool = new ReadTool(kaos, NARROW_WORKSPACE);
    const result = await tool.execute(
      'call_guard_rel',
      { path: '../../../etc/passwd' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(readTextFn).not.toHaveBeenCalled();
  });

  it('rejects reads of sensitive files (`.env`) even when inside workspace', async () => {
    const readTextFn = vi.fn();
    const kaos = createFakeKaos({ readText: readTextFn });
    const tool = new ReadTool(kaos, NARROW_WORKSPACE);
    const result = await tool.execute(
      'call_guard_env',
      { path: '/workspace/.env' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(toolContentString(result)).toContain('sensitive');
    expect(readTextFn).not.toHaveBeenCalled();
  });

  it('rejects shared-prefix escape (`/workspace-evil`)', async () => {
    const readTextFn = vi.fn();
    const kaos = createFakeKaos({ readText: readTextFn });
    const tool = new ReadTool(kaos, NARROW_WORKSPACE);
    const result = await tool.execute(
      'call_guard_prefix',
      { path: '/workspace-evil/secrets.txt' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(readTextFn).not.toHaveBeenCalled();
  });

  it('allows reads inside workspace and inside additionalDirs', async () => {
    const readTextFn = vi.fn().mockResolvedValue('hello');
    const kaos = createFakeKaos({ readText: readTextFn });
    const tool = new ReadTool(kaos, {
      workspaceDir: '/workspace',
      additionalDirs: ['/extra'],
    });
    const r1 = await tool.execute(
      'call_ok_1',
      { path: '/workspace/README.md' },
      new AbortController().signal,
    );
    const r2 = await tool.execute(
      'call_ok_2',
      { path: '/extra/notes.txt' },
      new AbortController().signal,
    );
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(readTextFn).toHaveBeenCalledTimes(2);
  });

  // ── Phase 15 A.2 — Python edge cases (ports tests/tools/test_read_file.py) ──
  describe('edge cases (Phase 15 A.2 — Python parity)', () => {
    it('offset beyond EOF returns gracefully (empty content, no error)', async () => {
      // Python `test_read_line_offset_beyond_file_length` (test_read_file.py:204)
      const content = Array.from({ length: 5 }, (_, i) => `line ${String(i + 1)}`).join('\n');
      const tool = makeReadTool(content);
      const result = await tool.execute(
        'call_eof',
        { path: '/tmp/small.txt', offset: 10 },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.lineCount).toBe(0);
      expect(result.output?.content).toBe('');
    });

    it('edge case: offset=1 reads from the second line (0-based)', async () => {
      // Python test_read_edge_cases (test_read_file.py:233) — pin first
      // of the three offset edges split into individual it's.
      const content = 'a\nb\nc\nd\ne';
      const tool = makeReadTool(content);
      const result = await tool.execute(
        'call_edge_1',
        { path: '/t.txt', offset: 1, limit: 2 },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.content).toContain('2\tb');
      expect(result.output?.content).toContain('3\tc');
      expect(result.output?.content).not.toContain('1\ta');
    });

    it('edge case: offset at last valid line returns exactly that line', async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `L${String(i + 1)}`).join('\n');
      const tool = makeReadTool(lines);
      const result = await tool.execute(
        'call_edge_last',
        { path: '/t.txt', offset: 9, limit: 5 },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.lineCount).toBe(1);
      expect(result.output?.content).toContain('10\tL10');
    });

    it('edge case: offset + limit partially overlaps EOF — returns only remaining lines', async () => {
      const lines = Array.from({ length: 5 }, (_, i) => `line${String(i + 1)}`).join('\n');
      const tool = makeReadTool(lines);
      const result = await tool.execute(
        'call_edge_partial',
        { path: '/t.txt', offset: 3, limit: 10 },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.lineCount).toBe(2); // lines 4 & 5
    });

    it('schema rejects negative offset (TS 0-based counterpart of Python offset=0 reject)', () => {
      // Python rejects offset=0 because Python offsets are 1-based. TS
      // uses 0-based offsets, so the equivalent boundary check is
      // "negative offset rejected". Schema declares
      // `z.number().int().nonnegative().optional()`.
      const tool = makeReadTool();
      expect(
        tool.inputSchema.safeParse({ path: '/t.txt', offset: -1 }).success,
      ).toBe(false);
    });

    // ── Line-level truncation & double-boundary limits ─────────────────
    //
    // **Red bar** — src does not yet enforce MAX_LINE_LENGTH /
    // MAX_LINES / MAX_BYTES. Implementer hooks these up in Phase 15 per
    // the migration-report A.2 Implementer Dependencies.

    it('lines longer than MAX_LINE_LENGTH are truncated with "..." + a message listing truncated line numbers', async () => {
      // Python `test_line_truncation_and_messaging` (test_read_file.py:268).
      // Contract: (a) `...` appended to the long line body, (b) the tool
      // result mentions which line numbers were truncated (e.g. "[1, 3]").
      const long = 'x'.repeat(10_000); // well above any reasonable MAX_LINE_LENGTH
      const content = [long, 'short', long, 'ok'].join('\n');
      const tool = makeReadTool(content);
      const result = await tool.execute(
        'call_long',
        { path: '/long.txt' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      const text = result.output?.content ?? '';
      // Body contains the ellipsis marker on truncated lines.
      expect(text).toContain('...');
      // Message carries the truncated line numbers. Python says "[1, 3]";
      // the stable contract we pin is that _both_ line numbers appear.
      const content_str = toolContentString(result);
      expect(content_str).toContain('1');
      expect(content_str).toContain('3');
      expect(content_str.toLowerCase()).toMatch(/truncated|long|exceeded/);
    });

    it('reading more than MAX_LINES caps the result and surfaces a boundary message', async () => {
      // Python `test_max_lines_boundary` (test_read_file.py:345).
      // 50_000 lines → Read should cap at MAX_LINES (contract defined by
      // src constant; Implementer exports it in Phase 15).
      const many = Array.from({ length: 50_000 }, (_, i) => `l${String(i)}`).join('\n');
      const tool = makeReadTool(many);
      const result = await tool.execute(
        'call_max_lines',
        { path: '/huge.txt' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      // Upper bound: TS MUST cap at some finite number well below the
      // input size. Pin the spirit of the contract without hard-coding
      // MAX_LINES — "cap materially smaller than input".
      expect(result.output?.lineCount ?? 0).toBeLessThan(50_000);
      expect(result.output?.lineCount ?? 0).toBeGreaterThan(0);
      // BLK-1 regression: the cap must surface an "Output truncated"
      // note — previously the `maxLinesReached` flag was dead code
      // because `effectiveLimit = min(limit, MAX_LINES)` tripped first.
      expect(toolContentString(result)).toMatch(/truncated|lines reached/i);
    });

    it('default read on a 1500-line file surfaces the MAX_LINES cap message', async () => {
      // BLK-1 explicit regression: feed 1500 (> MAX_LINES = 1000) lines
      // with no explicit limit and confirm the cap fires + the message
      // surfaces via tool result content.
      const many = Array.from({ length: 1500 }, (_, i) => `l${String(i)}`).join('\n');
      const tool = makeReadTool(many);
      const result = await tool.execute(
        'call_max_lines_1500',
        { path: '/one-point-five-k.txt' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.output?.lineCount).toBe(1000);
      expect(toolContentString(result)).toMatch(/max 1000 lines reached|output truncated/i);
    });

    it('reading a file larger than MAX_BYTES surfaces a boundary message', async () => {
      // Python `test_max_bytes_boundary` (test_read_file.py:364). Build
      // a file of ~5 MB to exceed any reasonable MAX_BYTES.
      const line = 'x'.repeat(1000);
      const big = Array.from({ length: 5000 }, () => line).join('\n');
      const tool = makeReadTool(big);
      const result = await tool.execute(
        'call_max_bytes',
        { path: '/big.txt' },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      // Contract: we either error-out with a size message, or we cap the
      // output. Either path must surface the boundary — pin on the
      // message presence.
      const combined = toolContentString(result);
      expect(combined.toLowerCase()).toMatch(/too large|truncated|exceeded|size/);
    });

    // ── Tail mode (negative offset) — src does NOT implement ───────────
    //
    // TS ReadTool schema uses `nonnegative()` so negative offsets are
    // rejected outright; there is no tail reader. Python has eight
    // dedicated tests for the tail path. We keep them as `it.todo`
    // placeholders so the coverage gap is visible, but do not add the
    // tail implementation in Phase 15.
    it.todo('tail mode: last N lines with negative offset (Python test_read_tail_last_n)');
    it.todo('tail mode: default lines count when limit omitted');
    it.todo('tail mode: empty file returns empty content');
    it.todo('tail mode: requesting more lines than file has returns full file');
    it.todo('tail mode: negative offset below -(MAX_LINES+1) rejected by schema');
    it.todo('tail mode: negative offset combined with limit');
    it.todo('tail mode: exact line-count boundary (|offset| == len)');
    it.todo('tail mode: negative offset beyond file length returns all available');
  });
});
