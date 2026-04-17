/**
 * Slice 5 / 决策 #98: ReadTool display-hook demonstration path.
 *
 * Pins:
 *   - `ReadTool.display.getInputDisplay(args)` returns `{ kind: 'file_io',
 *     operation: 'read', path }` — §10.7.3 union.
 *   - `ReadTool.display.getResultDisplay(args, result)` returns
 *     `{ kind: 'file_content', path, content, lineCount?, truncated? }`.
 *
 * Notes:
 *   - ReadTool declares `maxResultSizeChars = Infinity` under Phase 5
 *     because it self-limits via `maxLines` / `maxBytes` (§10.6.2). That
 *     invariant is tested in tool-result-budget.test.ts, not here.
 *
 * Expected to FAIL before Phase 5: current ReadTool (src/tools/read.ts)
 * has no `display` field and only exposes `getActivityDescription`.
 */

import { describe, expect, it } from 'vitest';

import { ReadTool } from '../../src/tools/index.js';
import type { ReadInput, ReadOutput } from '../../src/tools/index.js';
import type { ToolInputDisplay, ToolResult, ToolResultDisplay } from '../../src/soul/types.js';
import { PERMISSIVE_WORKSPACE, createFakeKaos } from './fixtures/fake-kaos.js';

function makeReadTool(): ReadTool {
  const kaos = createFakeKaos();
  return new ReadTool(kaos, PERMISSIVE_WORKSPACE);
}

describe('ReadTool.display (决策 #98 demo path)', () => {
  it('getInputDisplay returns file_io with operation="read" and the target path', () => {
    const tool = makeReadTool();
    expect(tool.display).toBeDefined();
    expect(tool.display?.getInputDisplay).toBeTypeOf('function');

    const args: ReadInput = { path: '/repo/file.ts' };
    const hint = tool.display!.getInputDisplay!(args) as ToolInputDisplay;
    expect(hint.kind).toBe('file_io');
    if (hint.kind === 'file_io') {
      expect(hint.operation).toBe('read');
      expect(hint.path).toBe('/repo/file.ts');
    }
  });

  it('getResultDisplay returns file_content shaped from result.output (v2 §10.7.3)', () => {
    const tool = makeReadTool();
    const args: ReadInput = { path: '/repo/file.ts' };
    const result: ToolResult<ReadOutput> = {
      content: '1\tline one\n2\tline two',
      output: { content: '1\tline one\n2\tline two', lineCount: 2 },
    };
    const hint = tool.display!.getResultDisplay!(args, result) as ToolResultDisplay;
    expect(hint.kind).toBe('file_content');
    if (hint.kind === 'file_content') {
      expect(hint.path).toBe('/repo/file.ts');
      expect(hint.content).toContain('line one');
      // v2 §10.7.3 file_content fields: {path, content, range?, truncated?}
      // lineCount is NOT in the union — ReadOutput stores it, but the
      // display hint does not surface it. Phase 5 Implementer decides
      // whether to thread `range` from offset+limit; not pinned here.
    }
  });

  it('getResultDisplay surfaces empty content cleanly for zero-byte files', () => {
    const tool = makeReadTool();
    const args: ReadInput = { path: '/repo/empty.ts' };
    const result: ToolResult<ReadOutput> = {
      content: '',
      output: { content: '', lineCount: 0 },
    };
    const hint = tool.display!.getResultDisplay!(args, result) as ToolResultDisplay;
    if (hint.kind !== 'file_content') throw new Error('expected file_content');
    expect(hint.content).toBe('');
  });
});
