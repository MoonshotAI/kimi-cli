/**
 * ExitPlanMode — options + /revise — Phase 18 Section D.3 + D.4 tests.
 *
 * Extends the Slice 3.6 ExitPlanMode with:
 *   - `options`: optional `{label, description}[]` (max 3) that the
 *     user selects via ApprovalRuntime multi-option approval
 *   - `Revise` feedback loop: selecting "Revise" (or returning
 *     `{kind: 'revise', feedback}`) keeps plan mode active
 *
 * Pins:
 *   - Input schema accepts/rejects `options` per v2 rules
 *   - options absent -> existing approve/reject path (unchanged)
 *   - options present -> ApprovalRuntime.request is invoked with
 *     `display.kind === 'plan_options'` and option payload
 *   - user chose Revise -> plan mode is NOT exited, tool returns a
 *     "revise" discriminator
 *   - user chose a non-revise option -> plan mode IS exited, tool
 *     returns `{chosen: label}`
 *
 * RED until the Phase 18 D.3 implementation lands.
 */

import { describe, expect, it, vi } from 'vitest';

import { ExitPlanModeTool } from '../../src/tools/exit-plan-mode.js';

type OptionsArray = ReadonlyArray<{ label: string; description: string }>;

interface ExitPlanModeArgs {
  plan: string;
  options?: OptionsArray;
}

interface ApprovalResult {
  approved: boolean;
  chosenLabel?: string;
  feedback?: string;
}

function makeTool(opts: {
  isActive?: boolean;
  setPlanMode?: (enabled: boolean) => Promise<void>;
  requestApproval?: (
    args: ExitPlanModeArgs,
  ) => Promise<ApprovalResult>;
}): {
  tool: ExitPlanModeTool;
  setPlanMode: ReturnType<typeof vi.fn>;
  requestApproval: ReturnType<typeof vi.fn>;
} {
  const isActive = vi.fn<() => boolean>(() => opts.isActive ?? true);
  const setPlanMode = vi.fn<(enabled: boolean) => Promise<void>>(
    opts.setPlanMode ?? (async () => {}),
  );
  const requestApproval = vi.fn<(args: ExitPlanModeArgs) => Promise<ApprovalResult>>(
    opts.requestApproval ?? (async () => ({ approved: true })),
  );
  // Phase 18 D.3 — ExitPlanModeDeps gains a `requestApproval` member so
  // options / revise flow can be driven by ApprovalRuntime. The cast
  // pins the contract; RED if the member is not yet added.
  const tool = new ExitPlanModeTool({
    isPlanModeActive: () => isActive(),
    setPlanMode: (enabled: boolean) => setPlanMode(enabled),
    requestApproval: (args: ExitPlanModeArgs) => requestApproval(args),
  } as unknown as ConstructorParameters<typeof ExitPlanModeTool>[0]);
  return { tool, setPlanMode, requestApproval };
}

// ── Input schema ─────────────────────────────────────────────────────

describe('ExitPlanMode.inputSchema — options shape (D.3)', () => {
  const { tool } = makeTool({});

  it('accepts options with 1–3 entries', () => {
    expect(
      tool.inputSchema.safeParse({
        plan: 'p',
        options: [{ label: 'A', description: 'do A' }],
      }).success,
    ).toBe(true);
    expect(
      tool.inputSchema.safeParse({
        plan: 'p',
        options: [
          { label: 'A', description: 'do A' },
          { label: 'B', description: 'do B' },
          { label: 'C', description: 'do C' },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects options with more than 3 entries', () => {
    const res = tool.inputSchema.safeParse({
      plan: 'p',
      options: [
        { label: 'A', description: 'x' },
        { label: 'B', description: 'x' },
        { label: 'C', description: 'x' },
        { label: 'D', description: 'x' },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('rejects label shorter than 1 character', () => {
    expect(
      tool.inputSchema.safeParse({
        plan: 'p',
        options: [{ label: '', description: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('rejects label longer than 80 characters', () => {
    const longLabel = 'a'.repeat(81);
    expect(
      tool.inputSchema.safeParse({
        plan: 'p',
        options: [{ label: longLabel, description: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('accepts a request without options (backward compatible)', () => {
    expect(tool.inputSchema.safeParse({ plan: 'p' }).success).toBe(true);
  });
});

// ── Runtime dispatch ─────────────────────────────────────────────────

describe('ExitPlanMode.execute — no options (backward compat)', () => {
  it('does not invoke requestApproval when options are omitted', async () => {
    const { tool, setPlanMode, requestApproval } = makeTool({ isActive: true });
    const res = await tool.execute(
      'tc_1',
      { plan: 'plain plan' },
      new AbortController().signal,
    );
    expect(res.isError).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(setPlanMode).toHaveBeenCalledWith(false);
  });
});

describe('ExitPlanMode.execute — options present (D.3)', () => {
  it('calls requestApproval with the options payload', async () => {
    const { tool, requestApproval } = makeTool({
      isActive: true,
      requestApproval: async () => ({ approved: true, chosenLabel: 'Approach A' }),
    });

    await tool.execute(
      'tc_1',
      {
        plan: 'multi-approach plan',
        options: [
          { label: 'Approach A', description: 'use library X' },
          { label: 'Approach B', description: 'use library Y' },
        ],
      } as ExitPlanModeArgs,
      new AbortController().signal,
    );

    expect(requestApproval).toHaveBeenCalledTimes(1);
    const arg = requestApproval.mock.calls[0]?.[0];
    expect(arg?.options?.length).toBe(2);
    expect(arg?.options?.[0]?.label).toBe('Approach A');
  });

  it('on option selection, returns {chosen: label} and exits plan mode', async () => {
    const { tool, setPlanMode } = makeTool({
      isActive: true,
      requestApproval: async () => ({ approved: true, chosenLabel: 'Approach B' }),
    });
    const res = await tool.execute(
      'tc_1',
      {
        plan: 'plan',
        options: [
          { label: 'Approach A', description: 'x' },
          { label: 'Approach B', description: 'y' },
        ],
      } as ExitPlanModeArgs,
      new AbortController().signal,
    );
    expect(res.isError).toBe(false);
    expect(setPlanMode).toHaveBeenCalledWith(false);
    // The `output` surfaces the chosen label so the LLM sees it.
    expect(res.output).toMatchObject({ chosen: 'Approach B' });
  });
});

// ── /revise loop (D.4) ───────────────────────────────────────────────

describe('ExitPlanMode.execute — Revise feedback loop (D.4)', () => {
  it('user selects "Revise" -> plan mode stays active', async () => {
    const { tool, setPlanMode } = makeTool({
      isActive: true,
      requestApproval: async () => ({
        approved: false,
        chosenLabel: 'Revise',
        feedback: 'please reconsider the approach',
      }),
    });
    const res = await tool.execute(
      'tc_1',
      {
        plan: 'plan',
        options: [
          { label: 'Approach A', description: 'x' },
          { label: 'Revise', description: 'ask for changes' },
        ],
      } as ExitPlanModeArgs,
      new AbortController().signal,
    );

    expect(res.isError).toBe(false);
    // Plan mode NOT exited
    expect(setPlanMode).not.toHaveBeenCalled();
    // Tool output carries a revise discriminator + feedback
    expect(res.output).toMatchObject({
      kind: 'revise',
      feedback: 'please reconsider the approach',
    });
  });

  it('user rejects outright without Revise -> plan mode exits + feedback returned', async () => {
    const { tool, setPlanMode } = makeTool({
      isActive: true,
      requestApproval: async () => ({
        approved: false,
        feedback: 'not now',
      }),
    });
    const res = await tool.execute(
      'tc_1',
      {
        plan: 'plan',
        options: [
          { label: 'Approach A', description: 'the plan' },
        ],
      } as ExitPlanModeArgs,
      new AbortController().signal,
    );
    expect(res.isError).toBe(false);
    expect(setPlanMode).toHaveBeenCalledWith(false);
    // Output surfaces the feedback so the caller can display it
    expect(res.output).toMatchObject({ feedback: 'not now' });
  });
});
