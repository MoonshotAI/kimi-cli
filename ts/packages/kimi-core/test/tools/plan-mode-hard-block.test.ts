/**
 * Plan-mode hard-block for Write / Edit / Bash — Phase 18 Section D.5.
 *
 * v2 §11 / phase-18 todo D.5 flipped the Slice 15 "soft reminder"
 * policy to a hard block: while plan mode is active, Write/Edit to
 * any file other than the current plan file, and Bash commands that
 * mutate the filesystem, MUST return `isError: true` with a message
 * pointing the LLM at ExitPlanMode.
 *
 * The tests depend on a new `PlanModeChecker` dependency wired into
 * each tool's constructor:
 *
 *   interface PlanModeChecker {
 *     isPlanModeActive(): boolean;
 *     getPlanFilePath(): string | null;
 *   }
 *
 * RED until Phase 18 D.5 lands.
 */

import { describe, expect, it, vi } from 'vitest';

import { BashInputSchema } from '../../src/tools/types.js';
import { BashTool, WriteTool, EditTool } from '../../src/tools/index.js';
import { PERMISSIVE_WORKSPACE, createFakeKaos } from './fixtures/fake-kaos.js';

type ToolCtorWithPlan<T> = new (...args: unknown[]) => T;

interface PlanModeChecker {
  isPlanModeActive(): boolean;
  getPlanFilePath(): string | null;
}

function planChecker(opts: {
  active: boolean;
  planPath?: string | null;
}): PlanModeChecker {
  return {
    isPlanModeActive: vi.fn(() => opts.active),
    getPlanFilePath: vi.fn(() => opts.planPath ?? null),
  };
}

// Helper: cast the 3rd / 4th constructor arg to the plan checker slot.
// After Phase 18 D.5, WriteTool / EditTool / ShellTool constructors
// gain a `planModeChecker?: PlanModeChecker` trailing arg. We cast to
// any-shape ctor so the tests compile before the implementation lands.

function newWrite(checker: PlanModeChecker, writeFn?: () => Promise<number>): WriteTool {
  const kaos = createFakeKaos({ writeText: writeFn ?? vi.fn().mockResolvedValue(10) });
  const Ctor = WriteTool as unknown as ToolCtorWithPlan<WriteTool>;
  return new Ctor(kaos, PERMISSIVE_WORKSPACE, { planModeChecker: checker });
}

function newEdit(checker: PlanModeChecker, initialText = 'foo bar'): EditTool {
  const kaos = createFakeKaos({
    readText: vi.fn().mockResolvedValue(initialText),
    writeText: vi.fn().mockResolvedValue(10),
    stat: vi.fn().mockResolvedValue({ isFile: true, isDir: false, size: initialText.length }),
  } as unknown as Parameters<typeof createFakeKaos>[0]);
  const Ctor = EditTool as unknown as ToolCtorWithPlan<EditTool>;
  return new Ctor(kaos, PERMISSIVE_WORKSPACE, { planModeChecker: checker });
}

function newBash(
  checker: PlanModeChecker,
  execFn?: ReturnType<typeof vi.fn>,
): BashTool {
  const ok = { exitCode: 0, stdout: '', stderr: '' };
  const kaos = createFakeKaos({
    exec: execFn ?? vi.fn().mockResolvedValue(ok),
    execWithEnv: execFn ?? vi.fn().mockResolvedValue(ok),
  } as unknown as Parameters<typeof createFakeKaos>[0]);
  const Ctor = BashTool as unknown as ToolCtorWithPlan<BashTool>;
  return new Ctor(kaos, '/workspace', undefined, undefined, { planModeChecker: checker });
}

// ── WriteTool ────────────────────────────────────────────────────────

describe('WriteTool plan-mode hard block (D.5)', () => {
  it('allows writing to the plan file while in plan mode', async () => {
    const planPath = '/tmp/plans/iron-man-thor-hulk.md';
    const tool = newWrite(planChecker({ active: true, planPath }));
    const result = await tool.execute(
      'tc_1',
      { path: planPath, content: '# plan' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
  });

  it('blocks writing to a non-plan file while in plan mode', async () => {
    const planPath = '/tmp/plans/iron-man-thor-hulk.md';
    const tool = newWrite(planChecker({ active: true, planPath }));
    const result = await tool.execute(
      'tc_2',
      { path: '/workspace/src/main.ts', content: 'let x=1;' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text.toLowerCase()).toContain('plan file');
    expect(text).toContain('ExitPlanMode');
  });

  it('allows writing anywhere when plan mode is inactive', async () => {
    const tool = newWrite(planChecker({ active: false }));
    const result = await tool.execute(
      'tc_3',
      { path: '/workspace/src/main.ts', content: 'let x=1;' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
  });
});

// ── EditTool ─────────────────────────────────────────────────────────

describe('EditTool plan-mode hard block (D.5)', () => {
  it('allows editing the plan file while in plan mode', async () => {
    const planPath = '/tmp/plans/thor-hulk-vision.md';
    const tool = newEdit(planChecker({ active: true, planPath }));
    const result = await tool.execute(
      'tc_1',
      { path: planPath, old_string: 'foo', new_string: 'bar' },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
  });

  it('blocks editing a non-plan file while in plan mode', async () => {
    const planPath = '/tmp/plans/thor-hulk-vision.md';
    const tool = newEdit(planChecker({ active: true, planPath }));
    const result = await tool.execute(
      'tc_2',
      { path: '/workspace/src/other.ts', old_string: 'a', new_string: 'b' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text.toLowerCase()).toContain('plan file');
  });
});

// ── ShellTool (Bash) ─────────────────────────────────────────────────

describe('ShellTool plan-mode hard block (D.5) — mutation commands', () => {
  // Sanity: ensure BashInputSchema stays parseable for our test invocations
  it('BashInputSchema accepts the test commands', () => {
    expect(BashInputSchema.safeParse({ command: 'ls' }).success).toBe(true);
    expect(BashInputSchema.safeParse({ command: 'rm foo.txt' }).success).toBe(true);
  });

  it('blocks `rm <file>` while in plan mode', async () => {
    const tool = newBash(planChecker({ active: true, planPath: '/tmp/plans/x.md' }));
    const result = await tool.execute(
      'tc_1',
      { command: 'rm foo.txt' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text.toLowerCase()).toMatch(/plan mode|ExitPlanMode/i);
  });

  it('blocks `echo foo > bar.txt` while in plan mode', async () => {
    const tool = newBash(planChecker({ active: true, planPath: '/tmp/plans/x.md' }));
    const result = await tool.execute(
      'tc_2',
      { command: 'echo foo > bar.txt' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    // Must be the plan-mode hard-block path, not an unrelated failure.
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text.toLowerCase()).toMatch(/plan mode|exitplanmode/i);
  });

  it('blocks `>> file.txt` append redirect while in plan mode', async () => {
    const tool = newBash(planChecker({ active: true, planPath: '/tmp/plans/x.md' }));
    const result = await tool.execute(
      'tc_3',
      { command: 'echo foo >> bar.txt' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text.toLowerCase()).toMatch(/plan mode|exitplanmode/i);
  });

  it('blocks `sed -i` in-place edit while in plan mode', async () => {
    const tool = newBash(planChecker({ active: true, planPath: '/tmp/plans/x.md' }));
    const result = await tool.execute(
      'tc_4',
      { command: 'sed -i "s/foo/bar/g" file.txt' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text.toLowerCase()).toMatch(/plan mode|exitplanmode/i);
  });

  it('blocks `git commit` while in plan mode', async () => {
    const tool = newBash(planChecker({ active: true, planPath: '/tmp/plans/x.md' }));
    const result = await tool.execute(
      'tc_5',
      { command: 'git commit -m "wip"' },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text.toLowerCase()).toMatch(/plan mode|exitplanmode/i);
  });

  it('allows `ls` while in plan mode (read-only) — no plan-mode block message', async () => {
    const tool = newBash(planChecker({ active: true, planPath: '/tmp/plans/x.md' }));
    const result = await tool.execute(
      'tc_6',
      { command: 'ls -la' },
      new AbortController().signal,
    );
    // May fail for unrelated reasons (fake kaos exec is not a full process);
    // but the tool MUST NOT emit a plan-mode block message for a read-only
    // command. D.5 implementation must preserve this.
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text.toLowerCase()).not.toMatch(/plan mode|exitplanmode/i);
  });

  it('allows `cat foo.txt` while in plan mode (read-only) — no plan-mode block message', async () => {
    const tool = newBash(planChecker({ active: true, planPath: '/tmp/plans/x.md' }));
    const result = await tool.execute(
      'tc_7',
      { command: 'cat foo.txt' },
      new AbortController().signal,
    );
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text.toLowerCase()).not.toMatch(/plan mode|exitplanmode/i);
  });

  it('does NOT emit a plan-mode block message when plan mode is inactive', async () => {
    const tool = newBash(planChecker({ active: false }));
    const result = await tool.execute(
      'tc_8',
      { command: 'rm foo.txt' },
      new AbortController().signal,
    );
    // With plan mode inactive, even a mutation command must NOT be blocked
    // by the plan-mode gate (it may still fail for unrelated reasons like
    // permissions or the mocked shell — we only pin the absence of the
    // plan-mode message).
    const text = typeof result.content === 'string' ? result.content : '';
    expect(text.toLowerCase()).not.toMatch(/plan mode|exitplanmode/i);
  });
});
