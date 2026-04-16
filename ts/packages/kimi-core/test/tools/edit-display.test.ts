/**
 * Slice 5 / 决策 #98: EditTool display-hook demonstration path.
 *
 * Phase 5 team-lead arbitration (2026-04-17 reply):
 *   - getInputDisplay MUST return `{kind: 'file_io', operation: 'edit', path}`
 *     — NOT `diff`. orchestrator-side diff enrichment (v2 §10.7.6) is
 *     Phase 6+ work (requires fs + apply semantics). Phase 5 only ships
 *     the self-reported placeholder.
 *   - getResultDisplay MAY return `{kind: 'diff', path, before: old_string,
 *     after: new_string, hunks?}` because the tool already knows before /
 *     after from its own arguments. Fallback to `text` / `generic` is also
 *     acceptable.
 *
 * Expected to FAIL before Phase 5: current EditTool has no `display` field.
 */

import { describe, expect, it } from 'vitest';

import { EditTool } from '../../src/tools/index.js';
import type { EditInput, EditOutput } from '../../src/tools/index.js';
import type { ToolInputDisplay, ToolResult, ToolResultDisplay } from '../../src/soul/types.js';
import { PERMISSIVE_WORKSPACE, createFakeKaos } from './fixtures/fake-kaos.js';

function makeEditTool(): EditTool {
  const kaos = createFakeKaos();
  return new EditTool(kaos, PERMISSIVE_WORKSPACE);
}

describe('EditTool.display (决策 #98 demo path — Phase 5 simplified)', () => {
  it('display is present and exposes getInputDisplay + getResultDisplay', () => {
    const tool = makeEditTool();
    expect(tool.display).toBeDefined();
    expect(tool.display?.getInputDisplay).toBeTypeOf('function');
    expect(tool.display?.getResultDisplay).toBeTypeOf('function');
  });

  it('getInputDisplay returns file_io{operation:"edit", path} — NO diff self-report', () => {
    const tool = makeEditTool();
    const args: EditInput = {
      path: '/repo/x.ts',
      old_string: 'const a = 1',
      new_string: 'const a = 2',
    };
    const hint = tool.display!.getInputDisplay!(args) as ToolInputDisplay;
    expect(hint.kind).toBe('file_io');
    if (hint.kind === 'file_io') {
      expect(hint.operation).toBe('edit');
      expect(hint.path).toBe('/repo/x.ts');
    }
  });

  it('getResultDisplay either returns diff{path, before, after} or a text/generic fallback', () => {
    const tool = makeEditTool();
    const args: EditInput = {
      path: '/repo/x.ts',
      old_string: 'aaa',
      new_string: 'bbb',
    };
    const result: ToolResult<EditOutput> = {
      content: 'Replaced 1 occurrence in /repo/x.ts',
      output: { replacementCount: 1 },
    };
    const hint = tool.display!.getResultDisplay!(args, result) as ToolResultDisplay;
    expect(['diff', 'text', 'generic']).toContain(hint.kind);
    if (hint.kind === 'diff') {
      expect(hint.path).toBe('/repo/x.ts');
      // Tool knows before/after from its own arguments (v2 §10.7 diff
      // kind). Preferred Phase 5 shape — test does not require it.
      expect(hint.before).toBe('aaa');
      expect(hint.after).toBe('bbb');
    }
  });
});
