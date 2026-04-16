/**
 * Slice 5 / 决策 #98 / Tool UI 渲染契约.
 *
 * Pins:
 *   - Tool.display field is optional (pre-existing Tool still compiles).
 *   - 6 default fallback functions exist and return sane shapes:
 *       defaultGetUserFacingName / defaultGetActivityDescription /
 *       defaultGetInputDisplay / defaultGetResultDisplay /
 *       defaultGetProgressDescription / defaultGetCollapsedSummary
 *   - ToolInputDisplay union has the 11 kinds documented in v2 §10.7.3 +
 *     `generic` fallback (field names STRICTLY snake_case per §10.7.3).
 *   - ToolResultDisplay union has the 12 kinds documented in v2 §10.7.3 +
 *     `generic` fallback.
 *   - ToolUpdate.kind extended from 4 to 5 (adds `'custom'`) and carries
 *     `custom_kind?` / `custom_data?` fields.
 *   - ApprovalDisplay is a TYPE alias for ToolInputDisplay (same runtime
 *     values accepted on both sides). NOTE: the current v1 `ApprovalDisplay`
 *     (in `src/storage/wire-record.ts`) is a 5-kind union with INCOMPATIBLE
 *     field shapes (`diff: string` vs `before/after`; `generic{title,body}` vs
 *     `generic{summary,detail}`; `file_write` vs `file_io(write)`). Phase 5
 *     Implementer must migrate both the type alias and the wire-record zod
 *     schema, updating consumers in `permission/action-label.ts`,
 *     `permission/before-tool-call.ts`, `approval-runtime.ts`,
 *     `migrate/python/mapper.ts`. See migration-report.md §8 for the full
 *     migration checklist.
 *
 * Where they live (expected by Phase 5 Implementer):
 *   - `src/soul/types.ts` — Tool.display, ToolInputDisplay / ResultDisplay /
 *     ToolDisplayHooks / ToolUpdate.kind extension.
 *   - `src/tools/display-defaults.ts` (new) or `src/tools/index.ts` —
 *     6 `defaultGetXxx` exports. The module location is implementer-owned;
 *     this test imports from `../../src/tools/index.js` and will fail loudly
 *     if it is not re-exported there.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type {
  Tool,
  ToolInputDisplay,
  ToolResult,
  ToolResultDisplay,
  ToolUpdate,
} from '../../src/soul/types.js';
import type { ApprovalDisplay } from '../../src/soul-plus/index.js';

import {
  defaultGetUserFacingName,
  defaultGetActivityDescription,
  defaultGetInputDisplay,
  defaultGetResultDisplay,
  defaultGetProgressDescription,
  defaultGetCollapsedSummary,
} from '../../src/tools/index.js';

function makeTool(name = 'FakeTool'): Tool {
  return {
    name,
    description: 'fake',
    inputSchema: z.object({ foo: z.string() }),
    async execute() {
      return { content: 'ok' };
    },
  };
}

describe('Tool.display — optional hook contract (决策 #98)', () => {
  it('Tool without display still conforms to the interface', () => {
    const t = makeTool();
    // Must compile cleanly: Tool.display is optional.
    expect(t).toBeDefined();
    expect((t as Tool & { display?: unknown }).display).toBeUndefined();
  });
});

describe('default fallback functions (v2 §10.7.4)', () => {
  it('defaultGetUserFacingName returns the tool.name verbatim', () => {
    const t = makeTool('Bash');
    expect(defaultGetUserFacingName(t, undefined)).toBe('Bash');
  });

  it('defaultGetActivityDescription returns a single descriptive string', () => {
    const t = makeTool('Bash');
    const desc = defaultGetActivityDescription(t, { command: 'ls' });
    expect(typeof desc).toBe('string');
    expect(desc).toContain('Bash');
  });

  it('defaultGetInputDisplay returns a `generic` kind with tool name as summary', () => {
    const t = makeTool('Bash');
    const hint = defaultGetInputDisplay(t, { command: 'ls' }) as ToolInputDisplay;
    expect(hint.kind).toBe('generic');
    if (hint.kind === 'generic') {
      expect(hint.summary).toBe('Bash');
      expect(hint.detail).toEqual({ command: 'ls' });
    }
  });

  it('defaultGetResultDisplay returns `text` kind for success results', () => {
    const t = makeTool('Bash');
    const result: ToolResult = { content: 'ok output' };
    const hint = defaultGetResultDisplay(t, result) as ToolResultDisplay;
    expect(hint.kind).toBe('text');
    if (hint.kind === 'text') {
      expect(hint.text).toContain('ok output');
    }
  });

  it('defaultGetResultDisplay returns `error` kind when result.isError is true', () => {
    const t = makeTool('Bash');
    const result: ToolResult = { content: 'exit 1: permission denied', isError: true };
    const hint = defaultGetResultDisplay(t, result) as ToolResultDisplay;
    expect(hint.kind).toBe('error');
    if (hint.kind === 'error') {
      expect(hint.message).toContain('permission denied');
    }
  });

  it('defaultGetProgressDescription returns a string or undefined (tool-decided)', () => {
    const t = makeTool('Bash');
    const update: ToolUpdate = { kind: 'stdout', text: 'line' };
    const desc = defaultGetProgressDescription(t, { command: 'ls' }, update);
    // Default is permissive: may return a generic description or skip.
    expect(desc === undefined || typeof desc === 'string').toBe(true);
  });

  it('defaultGetCollapsedSummary returns a non-empty string', () => {
    const t = makeTool('Bash');
    const result: ToolResult = { content: 'ok' };
    const summary = defaultGetCollapsedSummary(t, { command: 'ls' }, result);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });
});

describe('ToolInputDisplay — 11 named kinds + generic (v2 §10.7.3, snake_case)', () => {
  it('each named kind is assignable to ToolInputDisplay with v2 §10.7.3 fields', () => {
    const samples: ToolInputDisplay[] = [
      { kind: 'command', command: 'ls' },
      { kind: 'file_io', operation: 'read', path: '/a.txt' },
      { kind: 'diff', path: '/a.txt', before: 'x', after: 'y' },
      { kind: 'search', query: 'foo' },
      { kind: 'url_fetch', url: 'https://x.y' },
      {
        kind: 'agent_call',
        agent_name: 'code-explorer',
        prompt: 'look',
      },
      { kind: 'skill_call', skill_name: 'review' },
      {
        kind: 'todo_list',
        items: [{ title: 'make tea', status: 'pending' }],
      },
      // NOTE: v2 §10.7.3 lists an internal `kind: string` field for
      // `background_task` that collides with the discriminator. Phase 5
      // Implementer must rename the inner field (recommend `task_kind`).
      // The test only pins the outer 4 fields; the inner-kind rename
      // decision is deferred to implementation.
      {
        kind: 'background_task',
        task_id: 'bg_1',
        status: 'running',
        description: 'run thing',
      } as unknown as ToolInputDisplay,
      { kind: 'task_stop', task_id: 'bg_1', task_description: 'user cancelled' },
      { kind: 'generic', summary: 'whatever' },
    ];
    const kinds = new Set(samples.map((s) => s.kind));
    expect(kinds.size).toBe(11);
    expect(kinds.has('generic')).toBe(true);
  });
});

describe('ToolResultDisplay — 12 named kinds + generic (v2 §10.7.3, snake_case)', () => {
  it('each named kind is assignable to ToolResultDisplay with v2 §10.7.3 fields', () => {
    const samples: ToolResultDisplay[] = [
      { kind: 'command_output', stdout: 'ok', exit_code: 0 },
      { kind: 'file_content', path: '/a.txt', content: 'x' },
      { kind: 'diff', path: '/a.txt', before: 'x', after: 'y' },
      {
        kind: 'search_results',
        query: 'foo',
        matches: [{ file: '/a.txt', line: 1, text: 'foo' }],
      },
      {
        kind: 'url_content',
        url: 'https://x.y',
        status: 200,
        preview: 'hello',
      },
      {
        kind: 'agent_summary',
        agent_name: 'code-explorer',
        steps: 3,
      },
      {
        kind: 'background_task',
        task_id: 'bg_1',
        status: 'running',
        description: 'n',
      },
      {
        kind: 'todo_list',
        items: [{ title: 'make tea', status: 'done' }],
      },
      { kind: 'structured', data: { any: 'payload' } },
      { kind: 'text', text: 'ok' },
      { kind: 'error', message: 'boom' },
      { kind: 'generic', summary: 'whatever' },
    ];
    const kinds = new Set(samples.map((s) => s.kind));
    expect(kinds.size).toBe(12);
    expect(kinds.has('generic')).toBe(true);
    expect(kinds.has('error')).toBe(true);
  });
});

describe('ToolUpdate.kind extended to include `custom` (决策 #98 / D10)', () => {
  it('accepts all 5 kinds: stdout / stderr / progress / status / custom', () => {
    const updates: ToolUpdate[] = [
      { kind: 'stdout', text: 'hi' },
      { kind: 'stderr', text: 'uh' },
      { kind: 'progress', percent: 40 },
      { kind: 'status', text: 'running' },
      { kind: 'custom', custom_kind: 'myApp.todo_checked', custom_data: { id: 7 } },
    ];
    const kinds = new Set(updates.map((u) => u.kind));
    expect(kinds.size).toBe(5);
    expect(kinds.has('custom')).toBe(true);
  });
});

describe('ApprovalDisplay = ToolInputDisplay alias (v2 §10.7.7)', () => {
  it('ApprovalDisplay is structurally identical to ToolInputDisplay', () => {
    // Pre-Phase-5: current ApprovalDisplay (5-kind, `diff:string` /
    // `file_write` / `generic{title,body}`) is INCOMPATIBLE with the
    // §10.7.3 union. The assertion SHOULD FAIL until Phase 5 Implementer
    // collapses the two.
    expectTypeOf<ApprovalDisplay>().toEqualTypeOf<ToolInputDisplay>();
  });
});
