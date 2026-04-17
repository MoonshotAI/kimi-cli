/**
 * Self-test — tool factories + createFullToolset (Phase 9 §2).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createBashTool,
  createFullToolset,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createSetTodoListTool,
  createTaskListTool,
  createThinkTool,
  createWriteTool,
  makeAbortSignal,
  makeAbortableSignal,
  makeToolCallStub,
} from '../helpers/index.js';
import { createFakeKaos } from '../tools/fixtures/fake-kaos.js';
import { BackgroundProcessManager } from '../../src/tools/index.js';

describe('tool factories', () => {
  it('createReadTool wires a fake kaos and permissive workspace by default', async () => {
    const kaos = createFakeKaos({
      readText: vi.fn().mockResolvedValue('alpha\nbeta\n'),
    });
    const tool = createReadTool({ kaos });
    const result = await tool.execute('tc_0', { path: '/some/file.txt' }, makeAbortSignal());
    expect(result.isError).toBeFalsy();
    expect(result.output?.lineCount).toBe(2);
  });

  it('createWriteTool lets us assert via kaos writeText spy', async () => {
    const writeText = vi.fn().mockResolvedValue(5);
    const kaos = createFakeKaos({ writeText });
    const tool = createWriteTool({ kaos });
    await tool.execute('tc_1', { path: '/a', content: 'hello' }, makeAbortSignal());
    expect(writeText).toHaveBeenCalledWith('/a', 'hello');
  });

  it('createThinkTool is a no-op', async () => {
    const tool = createThinkTool();
    const r = await tool.execute('tc_2', { thought: 'hm' }, makeAbortSignal());
    expect(r.isError).toBeFalsy();
  });

  it('createFullToolset returns 17 builtin tools by default', () => {
    const tools = createFullToolset();
    expect(tools.length).toBe(17);
    const names = tools.map((t) => t.name);
    for (const expected of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Think']) {
      expect(names).toContain(expected);
    }
  });

  it('createFullToolset honours exclude', () => {
    const tools = createFullToolset({ exclude: ['Bash', 'WebSearch'] });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('Bash');
    expect(names).not.toContain('WebSearch');
  });

  it('createFullToolset honours include', () => {
    const tools = createFullToolset({ include: ['Read', 'Write'] });
    expect(tools.map((t) => t.name).toSorted()).toEqual(['Read', 'Write']);
  });

  it('M6-补: createFullToolset points Bash + Task* at the same BackgroundProcessManager', () => {
    // Use the opts-supplied manager so the identity assertion checks
    // the exact instance, not just the "same fresh manager" that the
    // factory would otherwise mint internally.
    const sharedBg = new BackgroundProcessManager();
    const tools = createFullToolset({ backgroundManager: sharedBg });

    // Structural duck-type read — `BashTool.backgroundManager` and
    // `TaskListTool/.../.manager` are TS `private` but the runtime
    // slot is present. Walking through `'x' in tool` + a direct
    // `as BackgroundProcessManager` cast avoids both `any` and the
    // banned `as unknown as` chain.
    function readBashManager(tool: unknown): BackgroundProcessManager | undefined {
      if (typeof tool === 'object' && tool !== null && 'backgroundManager' in tool) {
        return (tool as { backgroundManager: BackgroundProcessManager | undefined })
          .backgroundManager;
      }
      return undefined;
    }
    function readTaskManager(tool: unknown): BackgroundProcessManager | undefined {
      if (typeof tool === 'object' && tool !== null && 'manager' in tool) {
        return (tool as { manager: BackgroundProcessManager }).manager;
      }
      return undefined;
    }

    const byName = new Map(tools.map((t) => [t.name, t]));
    const bash = byName.get('Bash');
    const taskList = byName.get('TaskList');
    const taskOutput = byName.get('TaskOutput');
    const taskStop = byName.get('TaskStop');
    expect(bash).toBeDefined();
    expect(taskList).toBeDefined();
    expect(taskOutput).toBeDefined();
    expect(taskStop).toBeDefined();

    expect(readBashManager(bash)).toBe(sharedBg);
    expect(readTaskManager(taskList)).toBe(sharedBg);
    expect(readTaskManager(taskOutput)).toBe(sharedBg);
    expect(readTaskManager(taskStop)).toBe(sharedBg);
  });

  it.each([
    ['createBashTool', (): unknown => createBashTool()],
    ['createGlobTool', (): unknown => createGlobTool()],
    ['createGrepTool', (): unknown => createGrepTool()],
    ['createSetTodoListTool', (): unknown => createSetTodoListTool()],
    ['createTaskListTool', (): unknown => createTaskListTool()],
  ])('%s constructs without throwing', (_n, fn) => {
    expect(fn()).toBeTruthy();
  });
});

describe('tool-call-context stubs', () => {
  it('makeToolCallStub produces a deterministic shape', () => {
    const stub = makeToolCallStub('Read', { path: '/x' }, 'tc_custom');
    expect(stub.id).toBe('tc_custom');
    expect(stub.name).toBe('Read');
    expect(stub.args).toEqual({ path: '/x' });
    expect(JSON.parse(stub.arguments)).toEqual({ path: '/x' });
  });

  it('makeAbortSignal is a live AbortSignal', () => {
    const s = makeAbortSignal();
    expect(s.aborted).toBe(false);
  });

  it('makeAbortableSignal: controller can abort the paired signal', () => {
    const { signal, controller } = makeAbortableSignal();
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});
