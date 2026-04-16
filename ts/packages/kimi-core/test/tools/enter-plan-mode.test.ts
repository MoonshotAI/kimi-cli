/**
 * EnterPlanModeTool tests — plan mode entry with Question dialog.
 */

import { describe, expect, it, vi } from 'vitest';

import { EnterPlanModeTool } from '../../src/tools/enter-plan-mode.js';
import type { EnterPlanModeDeps } from '../../src/tools/enter-plan-mode.js';
import type { QuestionRequest } from '../../src/tools/question-runtime.js';

function makeDeps(overrides?: Partial<EnterPlanModeDeps>): EnterPlanModeDeps {
  return {
    isPlanModeActive: () => false,
    // oxlint-disable-next-line unicorn/no-useless-undefined
    setPlanMode: vi.fn().mockResolvedValue(undefined),
    isYoloMode: () => false,
    questionRuntime: {
      askQuestion: vi.fn().mockResolvedValue({ answer: 'Yes' }),
    },
    ...overrides,
  };
}

function makeTool(overrides?: Partial<EnterPlanModeDeps>): EnterPlanModeTool {
  return new EnterPlanModeTool(makeDeps(overrides));
}

const signal = new AbortController().signal;

describe('EnterPlanModeTool', () => {
  it('has correct name and description', () => {
    const tool = makeTool();
    expect(tool.name).toBe('EnterPlanMode');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('returns error when plan mode is already active', async () => {
    const tool = makeTool({ isPlanModeActive: () => true });
    const result = await tool.execute('tc_1', {}, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('already active');
  });

  // ── Yolo mode ─────────────────────────────────────────────────────

  it('auto-approves in yolo mode without Question dialog', async () => {
    const setPlanMode = vi.fn().mockResolvedValue(undefined);
    const askQuestion = vi.fn();
    const tool = makeTool({
      isYoloMode: () => true,
      setPlanMode,
      questionRuntime: { askQuestion },
    });

    const result = await tool.execute('tc_yolo', {}, signal);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Plan mode is now active');
    expect(setPlanMode).toHaveBeenCalledWith(true);
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it('returns error when setPlanMode fails in yolo mode', async () => {
    const tool = makeTool({
      isYoloMode: () => true,
      setPlanMode: vi.fn().mockRejectedValue(new Error('state error')),
    });

    const result = await tool.execute('tc_yolo_err', {}, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Failed to enter plan mode');
  });

  // ── Interactive mode: approved ─────────────────────────────────────

  it('sends Question dialog and enters plan mode when user approves', async () => {
    const setPlanMode = vi.fn().mockResolvedValue(undefined);
    const askQuestion = vi.fn().mockResolvedValue({ answer: 'Yes' });
    const tool = makeTool({
      setPlanMode,
      questionRuntime: { askQuestion },
    });

    const result = await tool.execute('tc_approve', {}, signal);

    expect(askQuestion).toHaveBeenCalledTimes(1);
    const req = askQuestion.mock.calls[0]![0] as QuestionRequest;
    expect(req.toolCallId).toBe('tc_approve');
    expect(req.questions).toHaveLength(1);
    expect(req.questions[0]!.options).toHaveLength(2);

    expect(setPlanMode).toHaveBeenCalledWith(true);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Plan mode is now active');
  });

  it('includes reason in Question dialog when provided', async () => {
    const askQuestion = vi.fn().mockResolvedValue({ answer: 'Yes' });
    const tool = makeTool({ questionRuntime: { askQuestion } });

    await tool.execute('tc_reason', { reason: 'Complex refactor' }, signal);

    const req = askQuestion.mock.calls[0]![0] as QuestionRequest;
    expect(req.questions[0]!.question).toContain('Complex refactor');
  });

  // ── Interactive mode: declined ─────────────────────────────────────

  it('returns decline message when user says No', async () => {
    const setPlanMode = vi.fn();
    const tool = makeTool({
      setPlanMode,
      questionRuntime: { askQuestion: vi.fn().mockResolvedValue({ answer: 'No' }) },
    });

    const result = await tool.execute('tc_decline', {}, signal);

    expect(setPlanMode).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('declined');
  });

  it('returns decline message when user dismisses (empty answer)', async () => {
    const setPlanMode = vi.fn();
    const tool = makeTool({
      setPlanMode,
      questionRuntime: { askQuestion: vi.fn().mockResolvedValue({ answer: '' }) },
    });

    const result = await tool.execute('tc_dismiss', {}, signal);

    expect(setPlanMode).not.toHaveBeenCalled();
    expect(result.content).toContain('declined');
  });

  // ── Error handling ─────────────────────────────────────────────────

  it('returns error when setPlanMode fails in interactive mode', async () => {
    const tool = makeTool({
      setPlanMode: vi.fn().mockRejectedValue(new Error('toggle failed')),
      questionRuntime: { askQuestion: vi.fn().mockResolvedValue({ answer: 'Yes' }) },
    });

    const result = await tool.execute('tc_err', {}, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Failed to enter plan mode');
  });

  // ── JSON wire format (B1 fix) ────────────────────────────────────────

  it('parses JSON wire format answer from TUIQuestionRuntime', async () => {
    const setPlanMode = vi.fn().mockResolvedValue(undefined);
    const jsonAnswer = JSON.stringify({
      answers: { "Enter plan mode? In plan mode I'll investigate...": 'Yes' },
    });
    const tool = makeTool({
      setPlanMode,
      questionRuntime: { askQuestion: vi.fn().mockResolvedValue({ answer: jsonAnswer }) },
    });

    const result = await tool.execute('tc_json', {}, signal);
    expect(setPlanMode).toHaveBeenCalledWith(true);
    expect(result.content).toContain('Plan mode is now active');
  });

  it('handles JSON "No" answer correctly', async () => {
    const setPlanMode = vi.fn();
    const jsonAnswer = JSON.stringify({
      answers: { "Enter plan mode?...": 'No' },
    });
    const tool = makeTool({
      setPlanMode,
      questionRuntime: { askQuestion: vi.fn().mockResolvedValue({ answer: jsonAnswer }) },
    });

    const result = await tool.execute('tc_json_no', {}, signal);
    expect(setPlanMode).not.toHaveBeenCalled();
    expect(result.content).toContain('declined');
  });

  it('does not false-decline when reason contains "no" (B1 regression)', async () => {
    const setPlanMode = vi.fn().mockResolvedValue(undefined);
    const jsonAnswer = JSON.stringify({
      answers: { "Enter plan mode?...no need to plan ahead...Reason: no large refactor": 'Yes' },
    });
    const tool = makeTool({
      setPlanMode,
      questionRuntime: { askQuestion: vi.fn().mockResolvedValue({ answer: jsonAnswer }) },
    });

    const result = await tool.execute('tc_b1', { reason: 'no large refactor' }, signal);
    expect(setPlanMode).toHaveBeenCalledWith(true);
    expect(result.content).toContain('Plan mode is now active');
  });

  // ── Schema ─────────────────────────────────────────────────────────

  it('inputSchema accepts empty object', () => {
    const tool = makeTool();
    const result = tool.inputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('inputSchema accepts optional reason', () => {
    const tool = makeTool();
    const result = tool.inputSchema.safeParse({ reason: 'Complex task' });
    expect(result.success).toBe(true);
  });

  // ── Activity description ──────────────────────────────────────────

  it('getActivityDescription returns a string', () => {
    const tool = makeTool();
    expect(tool.getActivityDescription({})).toContain('plan mode');
  });
});
