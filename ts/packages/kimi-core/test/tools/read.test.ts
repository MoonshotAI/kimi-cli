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
});
