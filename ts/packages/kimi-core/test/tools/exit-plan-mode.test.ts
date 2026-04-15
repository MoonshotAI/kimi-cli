/**
 * Covers: ExitPlanModeTool (Slice 3.6).
 *
 * Pins:
 *   - name / schema shape (plan string required)
 *   - refuses to exit when plan mode is not active
 *   - calls setPlanMode(false) and returns the plan content on success
 *   - surfaces errors from setPlanMode as a tool error
 */

import { describe, expect, it, vi } from 'vitest';

import { ExitPlanModeTool } from '../../src/tools/exit-plan-mode.js';

describe('ExitPlanModeTool', () => {
  const makeTool = (
    overrides: {
      isActive?: boolean;
      setPlanMode?: (enabled: boolean) => Promise<void>;
    } = {},
  ): {
    tool: ExitPlanModeTool;
    setPlanMode: ReturnType<typeof vi.fn>;
    isActive: ReturnType<typeof vi.fn>;
  } => {
    const isActive = vi.fn<() => boolean>(() => overrides.isActive ?? true);
    const setPlanMode = vi.fn<(enabled: boolean) => Promise<void>>(
      overrides.setPlanMode ??
        (async () => {
          /* noop */
        }),
    );
    const tool = new ExitPlanModeTool({
      isPlanModeActive: () => isActive(),
      setPlanMode: (enabled) => setPlanMode(enabled),
    });
    return { tool, setPlanMode, isActive };
  };

  it('has name "ExitPlanMode" and a non-empty description', () => {
    const { tool } = makeTool();
    expect(tool.name).toBe('ExitPlanMode');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('schema requires a non-empty plan string', () => {
    const { tool } = makeTool();
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ plan: '' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ plan: 'a plan' }).success).toBe(true);
  });

  it('refuses to exit when plan mode is inactive', async () => {
    const { tool, setPlanMode } = makeTool({ isActive: false });
    const result = await tool.execute('call_1', { plan: 'my plan' }, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('plan mode');
    expect(setPlanMode).not.toHaveBeenCalled();
  });

  it('calls setPlanMode(false) and returns the plan content on success', async () => {
    const { tool, setPlanMode } = makeTool({ isActive: true });
    const result = await tool.execute(
      'call_1',
      { plan: 'Step 1: read files\nStep 2: fix bug' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(setPlanMode).toHaveBeenCalledTimes(1);
    expect(setPlanMode).toHaveBeenCalledWith(false);
    expect(result.content).toContain('Exited plan mode');
    expect(result.content).toContain('Step 1: read files');
    expect(result.output).toEqual({ plan: 'Step 1: read files\nStep 2: fix bug' });
  });

  it('surfaces errors from setPlanMode as a tool error', async () => {
    const { tool } = makeTool({
      isActive: true,
      setPlanMode: async () => {
        throw new Error('journal write failed');
      },
    });
    const result = await tool.execute(
      'call_1',
      { plan: 'plan text' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('journal write failed');
  });
});
