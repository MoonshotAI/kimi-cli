import type { QuestionRequest } from '@moonshot-ai/core';
import { describe, expect, it } from 'vitest';

import { TUIQuestionRuntime } from '../../src/wire/tui-question-runtime.js';

function makeDeps() {
  const emitted: unknown[] = [];
  let reqIdCounter = 0;
  return {
    deps: {
      sessionId: 'ses_test',
      emit: (msg: unknown) => emitted.push(msg),
      allocateRequestId: () => `quest_${(reqIdCounter += 1)}`,
    },
    emitted,
  };
}

function makeRequest(
  questions: Array<{ question: string; options: Array<{ label: string; description?: string }> }>,
): QuestionRequest {
  return {
    toolCallId: 'tc_1',
    questions: questions.map((q) => ({
      ...q,
      header: undefined,
      multiSelect: false,
      options: q.options.map((o) => ({ label: o.label, description: o.description })),
    })),
    signal: new AbortController().signal,
  };
}

describe('TUIQuestionRuntime', () => {
  it('returns question→answer mapping (not raw array)', async () => {
    const { deps } = makeDeps();
    const runtime = new TUIQuestionRuntime(deps);

    const promise = runtime.askQuestion(
      makeRequest([
        { question: 'Pick a color', options: [{ label: 'Red' }, { label: 'Blue' }] },
        { question: 'Pick a size', options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }] },
      ]),
    );

    runtime.resolveFromClient('quest_1', { answers: ['Blue', 'M'] });
    const result = await promise;

    const parsed = JSON.parse(result.answer);
    expect(parsed.answers).toEqual({
      'Pick a color': 'Blue',
      'Pick a size': 'M',
    });
  });

  it('handles single free-form answer', async () => {
    const { deps } = makeDeps();
    const runtime = new TUIQuestionRuntime(deps);

    const promise = runtime.askQuestion(
      makeRequest([{ question: 'Enter name', options: [{ label: 'custom' }] }]),
    );

    runtime.resolveFromClient('quest_1', { answer: 'Alice' });
    const result = await promise;
    expect(result.answer).toBe('Alice');
  });

  it('returns empty answer on dismissal', async () => {
    const { deps } = makeDeps();
    const runtime = new TUIQuestionRuntime(deps);

    const promise = runtime.askQuestion(
      makeRequest([{ question: 'Q?', options: [{ label: 'A' }] }]),
    );

    runtime.resolveFromClient('quest_1', {});
    const result = await promise;
    expect(result.answer).toBe('');
  });

  it('returns empty answer on abort', async () => {
    const { deps } = makeDeps();
    const runtime = new TUIQuestionRuntime(deps);
    const ac = new AbortController();

    const promise = runtime.askQuestion({
      toolCallId: 'tc_2',
      questions: [
        {
          question: 'Q?',
          header: undefined,
          multiSelect: false,
          options: [{ label: 'A', description: undefined }],
        },
      ],
      signal: ac.signal,
    });

    ac.abort();
    const result = await promise;
    expect(result.answer).toBe('');
    expect(runtime.pendingCount).toBe(0);
  });
});
