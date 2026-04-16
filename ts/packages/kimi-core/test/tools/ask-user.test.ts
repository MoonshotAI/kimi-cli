/**
 * AskUserQuestionTool tests (Slice 3.2).
 *
 * Verifies:
 *   - Normal flow: question dispatched → answer returned
 *   - yolo (bypassPermissions) mode: auto-dismissed without calling runtime
 *   - User dismisses question (empty answer)
 *   - Runtime error → isError result
 *   - AbortSignal propagation
 *   - Multiple questions with options
 */

import { describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '../../src/soul-plus/permission/types.js';
import { AskUserQuestionTool, AskUserQuestionInputSchema } from '../../src/tools/ask-user.js';
import type { AskUserQuestionInput } from '../../src/tools/ask-user.js';
import { AlwaysSkipQuestionRuntime } from '../../src/tools/question-runtime.js';
import type {
  QuestionRequest,
  QuestionResult,
  QuestionRuntime,
} from '../../src/tools/question-runtime.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeInput(overrides?: Partial<AskUserQuestionInput>): AskUserQuestionInput {
  return {
    questions: [
      {
        question: 'Which database?',
        header: 'DB',
        options: [
          { label: 'PostgreSQL', description: 'Relational' },
          { label: 'MongoDB', description: 'Document store' },
        ],
        multi_select: false,
      },
    ],
    ...overrides,
  };
}

class MockQuestionRuntime implements QuestionRuntime {
  lastRequest: QuestionRequest | undefined;
  private answer: string;

  constructor(answer: string = '{"answers": {"Which database?": "PostgreSQL"}}') {
    this.answer = answer;
  }

  async askQuestion(req: QuestionRequest): Promise<QuestionResult> {
    this.lastRequest = req;
    return { answer: this.answer };
  }
}

class ThrowingQuestionRuntime implements QuestionRuntime {
  async askQuestion(_req: QuestionRequest): Promise<QuestionResult> {
    throw new Error('Connection lost');
  }
}

function makeTool(
  runtime: QuestionRuntime = new MockQuestionRuntime(),
  mode: PermissionMode = 'default',
): AskUserQuestionTool {
  return new AskUserQuestionTool(runtime, () => mode);
}

const _abortedSignal = AbortSignal.abort();
const liveSignal = new AbortController().signal;

// ── Tests ────────────────────────────────────────────────────────────

describe('AskUserQuestionTool', () => {
  it('has correct name and description', () => {
    const tool = makeTool();
    expect(tool.name).toBe('AskUserQuestion');
    expect(tool.description).toContain('structured options');
  });

  it('returns activity description', () => {
    const tool = makeTool();
    expect(tool.getActivityDescription(makeInput())).toBe('Asking user a question');
  });
});

describe('AskUserQuestionTool — normal flow', () => {
  it('dispatches question to runtime and returns answer', async () => {
    const runtime = new MockQuestionRuntime('{"answers": {"Which database?": "PostgreSQL"}}');
    const tool = makeTool(runtime);
    const result = await tool.execute('tc_1', makeInput(), liveSignal);

    expect(result.isError).toBe(false);
    expect(result.content).toBe('{"answers": {"Which database?": "PostgreSQL"}}');
    expect(runtime.lastRequest).toBeDefined();
    expect(runtime.lastRequest!.toolCallId).toBe('tc_1');
    expect(runtime.lastRequest!.questions).toHaveLength(1);
    expect(runtime.lastRequest!.questions[0]!.question).toBe('Which database?');
  });

  it('maps options correctly to runtime request', async () => {
    const runtime = new MockQuestionRuntime('{"answers": {}}');
    const tool = makeTool(runtime);

    const input = makeInput({
      questions: [
        {
          question: 'Pick a framework?',
          header: 'FE',
          options: [
            { label: 'React', description: 'Popular' },
            { label: 'Vue', description: 'Progressive' },
            { label: 'Svelte', description: 'Compiled' },
          ],
          multi_select: true,
        },
      ],
    });

    await tool.execute('tc_2', input, liveSignal);

    const q = runtime.lastRequest!.questions[0]!;
    expect(q.options).toHaveLength(3);
    expect(q.options[0]!.label).toBe('React');
    expect(q.multiSelect).toBe(true);
  });

  it('supports multiple questions', async () => {
    const runtime = new MockQuestionRuntime('{"answers": {"Q1?": "A", "Q2?": "B"}}');
    const tool = makeTool(runtime);

    const input = makeInput({
      questions: [
        {
          question: 'Q1?',
          header: '',
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
          multi_select: false,
        },
        {
          question: 'Q2?',
          header: '',
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
          multi_select: false,
        },
      ],
    });

    const result = await tool.execute('tc_3', input, liveSignal);
    expect(result.isError).toBe(false);
    expect(runtime.lastRequest!.questions).toHaveLength(2);
  });
});

describe('AskUserQuestionTool — yolo mode', () => {
  it('auto-dismisses in bypassPermissions mode without calling runtime', async () => {
    const runtime = new MockQuestionRuntime();
    const spy = vi.spyOn(runtime, 'askQuestion');
    const tool = makeTool(runtime, 'bypassPermissions');

    const result = await tool.execute('tc_yolo', makeInput(), liveSignal);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('non-interactive');
    expect(result.content).toContain('yolo');
    expect(spy).not.toHaveBeenCalled();
  });

  it('dispatches normally in default mode', async () => {
    const runtime = new MockQuestionRuntime();
    const spy = vi.spyOn(runtime, 'askQuestion');
    const tool = makeTool(runtime, 'default');

    await tool.execute('tc_default', makeInput(), liveSignal);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('dispatches normally in acceptEdits mode', async () => {
    const runtime = new MockQuestionRuntime();
    const spy = vi.spyOn(runtime, 'askQuestion');
    const tool = makeTool(runtime, 'acceptEdits');

    await tool.execute('tc_accept', makeInput(), liveSignal);
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('AskUserQuestionTool — dismissed', () => {
  it('returns dismissed message when answer is empty', async () => {
    const runtime = new MockQuestionRuntime('');
    const tool = makeTool(runtime);

    const result = await tool.execute('tc_dismiss', makeInput(), liveSignal);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('dismissed');
  });
});

describe('AskUserQuestionTool — error handling', () => {
  it('returns isError on runtime error', async () => {
    const tool = makeTool(new ThrowingQuestionRuntime());

    const result = await tool.execute('tc_err', makeInput(), liveSignal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Connection lost');
  });

  it('returns generic message for non-Error throws', async () => {
    const runtime: QuestionRuntime = {
      async askQuestion() {
        // Non-Error throw is intentional: the tool must normalise the
        // payload into a generic ToolResult message without assuming
        // the thrown value implements `.message`.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string-error' as unknown as Error;
      },
    };
    const tool = makeTool(runtime);

    const result = await tool.execute('tc_non_err', makeInput(), liveSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Failed to get user response.');
  });
});

describe('AskUserQuestionTool — abort signal', () => {
  it('propagates signal to runtime', async () => {
    const runtime = new MockQuestionRuntime();
    const tool = makeTool(runtime);
    const controller = new AbortController();

    await tool.execute('tc_sig', makeInput(), controller.signal);

    expect(runtime.lastRequest!.signal).toBe(controller.signal);
  });
});

describe('AlwaysSkipQuestionRuntime', () => {
  it('returns empty answer immediately', async () => {
    const runtime = new AlwaysSkipQuestionRuntime();
    const result = await runtime.askQuestion({
      toolCallId: 'tc_skip',
      questions: [],
      signal: liveSignal,
    });
    expect(result.answer).toBe('');
  });
});

describe('AskUserQuestionInputSchema', () => {
  it('validates well-formed input', () => {
    const parsed = AskUserQuestionInputSchema.safeParse(makeInput());
    expect(parsed.success).toBe(true);
  });

  it('rejects input with no questions', () => {
    const parsed = AskUserQuestionInputSchema.safeParse({
      questions: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects question with fewer than 2 options', () => {
    const parsed = AskUserQuestionInputSchema.safeParse({
      questions: [
        {
          question: 'Q?',
          options: [{ label: 'Only one' }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects more than 4 questions', () => {
    const questions = Array.from({ length: 5 }, (_, i) => ({
      question: `Q${i}?`,
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
    }));
    const parsed = AskUserQuestionInputSchema.safeParse({ questions });
    expect(parsed.success).toBe(false);
  });

  it('fills defaults for optional fields', () => {
    const parsed = AskUserQuestionInputSchema.parse({
      questions: [
        {
          question: 'Q?',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    });
    expect(parsed.questions[0]!.header).toBe('');
    expect(parsed.questions[0]!.multi_select).toBe(false);
    expect(parsed.questions[0]!.options[0]!.description).toBe('');
  });
});
