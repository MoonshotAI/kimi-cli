/**
 * Phase 17 C.1 — Tool.metadata backfill for all built-in tools.
 *
 * Every built-in tool must carry `metadata.source === 'builtin'`. This
 * test pins the regression: if a new built-in ships without
 * `metadata`, or if someone drops the field from an existing one, it
 * fails here.
 *
 * ReadMediaFileTool is split out of the `it.each` batch because its
 * constructor requires a populated `Capability` set (throws
 * `SkipThisTool` otherwise — see src/tools/read-media.ts:106). The
 * dedicated `it` hands it a minimal `{ 'image_in' }` set.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { describe, expect, it } from 'vitest';

import {
  BashTool,
  EditTool,
  ExitPlanModeTool,
  FetchURLTool,
  GlobTool,
  GrepTool,
  InMemoryTodoStore,
  ReadMediaFileTool,
  ReadTool,
  SetTodoListTool,
  ThinkTool,
  WebSearchTool,
  WriteTool,
} from '../../src/tools/index.js';
// EnterPlanModeTool is not re-exported through the barrel (see
// `src/tools/index.ts` — Slice 5 decision to keep plan-mode
// entry-point direct). Import it from the module file instead.
import { EnterPlanModeTool } from '../../src/tools/enter-plan-mode.js';
import type { Tool } from '../../src/soul/types.js';
import type { WorkspaceConfig } from '../../src/tools/workspace.js';

describe('Phase 17 C.1 — builtin Tool.metadata.source === "builtin"', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builtins: Array<[string, Tool<any, any>]> = [
    ['Bash', new BashTool({} as never, {} as never) as Tool],
    ['Read', new ReadTool({} as never, {} as never) as Tool],
    ['Write', new WriteTool({} as never, {} as never) as Tool],
    ['Edit', new EditTool({} as never, {} as never) as Tool],
    ['Grep', new GrepTool({} as never, {} as never) as Tool],
    ['Glob', new GlobTool({} as never, {} as never) as Tool],
    ['WebSearch', new WebSearchTool({ search: async () => [] } as never) as Tool],
    ['FetchURL', new FetchURLTool({ fetch: async () => ({ ok: true, text: '' }) } as never) as Tool],
    ['SetTodoList', new SetTodoListTool(new InMemoryTodoStore() as never) as Tool],
    ['EnterPlanMode', new EnterPlanModeTool({} as never) as Tool],
    ['ExitPlanMode', new ExitPlanModeTool({} as never) as Tool],
    ['Think', (new ThinkTool() as unknown) as Tool],
  ];

  it.each(builtins)('%s tool has metadata.source === "builtin"', (_name, tool) => {
    expect(tool.metadata).toBeDefined();
    expect(tool.metadata?.source).toBe('builtin');
  });

  it('ReadMediaFile tool has metadata.source === "builtin" (constructed with image_in capability)', () => {
    // ReadMediaFileTool's constructor throws SkipThisTool when the
    // capability set lacks both 'image_in' and 'video_in'. Hand it a
    // minimal `image_in` set to exercise the metadata assertion
    // without booting a real Kaos / workspace pair.
    const fakeKaos = {} as Kaos;
    const fakeWorkspace = { root: '/tmp' } as unknown as WorkspaceConfig;
    const capabilities = new Set<string>(['image_in']);
    const tool: Tool = new ReadMediaFileTool(
      fakeKaos,
      fakeWorkspace,
      capabilities,
    ) as Tool;
    expect(tool.metadata).toBeDefined();
    expect(tool.metadata?.source).toBe('builtin');
  });

  // Agent / AskUserQuestion / SkillTool constructors depend on Soul /
  // subagent / orchestrator wiring — they share the metadata contract
  // but cannot be instantiated with plain-object deps here. Phase 17
  // leaves them to an integration-level regression (see
  // `test/soul-plus/soul-plus-dispatch.test.ts` etc.). If any of them
  // loses `metadata.source === 'builtin'` in the future, a new
  // dedicated assertion should land alongside whatever integration
  // fixture instantiates them.
});
