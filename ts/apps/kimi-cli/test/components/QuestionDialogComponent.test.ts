import { describe, it, expect } from 'vitest';

import { QuestionDialogComponent } from '../../src/components/QuestionDialogComponent.js';
import type { PendingQuestion } from '../../src/app/state.js';
import { darkColors } from '../../src/theme/colors.js';

function makePending(
  questions: PendingQuestion['data']['questions'],
  requestId = 'q_1',
): PendingQuestion {
  return {
    requestId,
    data: {
      id: requestId,
      tool_call_id: 'tc_1',
      questions,
    },
  };
}

function makeDialog(
  pending: PendingQuestion,
): { dialog: QuestionDialogComponent; collected: string[][] } {
  const collected: string[][] = [];
  const dialog = new QuestionDialogComponent(
    pending,
    (answers) => collected.push(answers),
    darkColors,
  );
  return { dialog, collected };
}

describe('QuestionDialogComponent', () => {
  it('single-select: enter submits the highlighted option', () => {
    const pending = makePending([
      {
        question: 'Pick one?',
        multi_select: false,
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);
    dialog.handleInput('\x1b[B'); // ↓
    dialog.handleInput('\r'); // enter
    expect(collected).toEqual([['Beta']]);
  });

  it('single-select: number key directly submits', () => {
    const pending = makePending([
      {
        question: 'Pick one?',
        multi_select: false,
        options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);
    dialog.handleInput('3');
    expect(collected).toEqual([['Gamma']]);
  });

  it('multi-select: space toggles, enter submits joined string', () => {
    const pending = makePending([
      {
        question: 'Pick many?',
        multi_select: true,
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);
    dialog.handleInput(' '); // toggle A
    dialog.handleInput('\x1b[B'); // ↓ to B
    dialog.handleInput('\x1b[B'); // ↓ to C
    dialog.handleInput(' '); // toggle C
    dialog.handleInput('\r'); // submit
    expect(collected).toEqual([['A, C']]);
  });

  it('multi-select: enter without selection is a no-op', () => {
    const pending = makePending([
      {
        question: 'Pick many?',
        multi_select: true,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);
    dialog.handleInput('\r');
    expect(collected).toEqual([]);
  });

  it('multi-question: advances after each answer and emits in question order', () => {
    const pending = makePending([
      {
        question: 'Q1?',
        multi_select: false,
        options: [{ label: 'A1' }, { label: 'B1' }],
      },
      {
        question: 'Q2?',
        multi_select: false,
        options: [{ label: 'A2' }, { label: 'B2' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);
    dialog.handleInput('\r'); // submit Q1 → A1
    expect(collected).toEqual([]); // not done yet
    dialog.handleInput('\x1b[B'); // ↓ on Q2
    dialog.handleInput('\r'); // submit Q2 → B2
    expect(collected).toEqual([['A1', 'B2']]);
  });

  it('tab switches between questions without losing per-question state', () => {
    const pending = makePending([
      {
        question: 'Q1?',
        multi_select: false,
        options: [{ label: 'A1' }, { label: 'B1' }],
      },
      {
        question: 'Q2?',
        multi_select: false,
        options: [{ label: 'A2' }, { label: 'B2' }, { label: 'C2' }],
      },
    ]);
    const { dialog } = makeDialog(pending);
    dialog.handleInput('\x1b[B'); // Q1 cursor → 1
    dialog.handleInput('\t'); // → Q2
    const renderQ2 = dialog.render(80).join('\n');
    expect(renderQ2).toMatch(/Q2\?/);
    dialog.handleInput('\x1b[D'); // ← back to Q1
    const renderQ1 = dialog.render(80).join('\n');
    // cursor is preserved at index 1 → highlights B1
    expect(renderQ1).toMatch(/→ \[2\] B1/);
  });

  it('escape dismisses with empty answers array', () => {
    const pending = makePending([
      {
        question: 'Pick one?',
        multi_select: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ]);
    const { dialog, collected } = makeDialog(pending);
    dialog.handleInput('\x1b');
    expect(collected).toEqual([[]]);
  });
});
