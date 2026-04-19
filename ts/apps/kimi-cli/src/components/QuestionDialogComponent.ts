/**
 * QuestionDialog — pi-tui version of the structured question prompt.
 *
 * Mirrors the Python `QuestionRequestPanel` interaction model
 * (src/kimi_cli/ui/shell/visualize/_question_panel.py) but with the
 * smaller surface area of the TS wire protocol (no `body`, no
 * `other_label`/`other_description` — just question + options).
 *
 * Per-question state (cursor + multi-selection set + collected answer)
 * is preserved when the user navigates between questions via ←/→/Tab,
 * matching the Python behaviour. Answers are emitted in question order
 * so `TUIQuestionRuntime.resolveFromClient` maps them back to the
 * `entry.questionTexts[i]` slot correctly.
 */

import { Container, matchesKey, Key, type Focusable, truncateToWidth } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { PendingQuestion } from '../app/state.js';
import type { ColorPalette } from '../theme/colors.js';

const BORDER_WIDTH = 60;
const NUMBER_KEYS = ['1', '2', '3', '4', '5', '6'];

export class QuestionDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly request: PendingQuestion;
  private readonly colors: ColorPalette;
  private readonly onAnswer: (answers: string[]) => void;
  private readonly maxVisibleOptions: number;

  private currentIdx = 0;
  /** Per-question cursor position (single-select highlight or multi-select focus). */
  private readonly cursors: number[];
  /** Per-question multi-select set (only populated for multi_select questions). */
  private readonly multiSelections: Set<number>[];
  /** Per-question submitted answer text (single = label, multi = "l1, l2"). */
  private readonly answers: (string | undefined)[];

  constructor(
    request: PendingQuestion,
    onAnswer: (answers: string[]) => void,
    colors: ColorPalette,
    maxVisibleOptions = 6,
  ) {
    super();
    this.request = request;
    this.onAnswer = onAnswer;
    this.colors = colors;
    this.maxVisibleOptions = maxVisibleOptions;

    const total = request.data.questions.length;
    this.cursors = Array.from({ length: total }, (): number => 0);
    this.multiSelections = Array.from({ length: total }, () => new Set<number>());
    this.answers = Array.from({ length: total }, (): string | undefined => undefined);
  }

  // ── Input ─────────────────────────────────────────────────────────

  handleInput(data: string): void {
    const question = this.currentQuestion();
    if (question === undefined) return;
    const options = question.options;
    if (options.length === 0) return;

    if (matchesKey(data, Key.escape)) {
      this.onAnswer([]);
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.cursors[this.currentIdx] = (this.currentCursor() - 1 + options.length) % options.length;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.cursors[this.currentIdx] = (this.currentCursor() + 1) % options.length;
      return;
    }

    if (matchesKey(data, Key.left)) {
      this.gotoQuestion(this.currentIdx - 1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.gotoQuestion(this.currentIdx + 1);
      return;
    }

    if (data === ' ' || matchesKey(data, Key.space)) {
      if (question.multi_select) {
        this.toggleMulti(this.currentCursor());
      } else {
        this.submitCurrent();
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.submitCurrent();
      return;
    }

    const numIdx = NUMBER_KEYS.indexOf(data);
    if (numIdx >= 0 && numIdx < options.length) {
      this.cursors[this.currentIdx] = numIdx;
      if (question.multi_select) {
        this.toggleMulti(numIdx);
      } else {
        this.submitCurrent();
      }
    }
  }

  // ── Navigation / state mutation ───────────────────────────────────

  private gotoQuestion(target: number): void {
    const total = this.request.data.questions.length;
    if (total <= 1) return;
    const wrapped = ((target % total) + total) % total;
    if (wrapped === this.currentIdx) return;
    this.currentIdx = wrapped;
  }

  private toggleMulti(optionIdx: number): void {
    const set = this.multiSelections[this.currentIdx];
    if (set === undefined) return;
    if (set.has(optionIdx)) set.delete(optionIdx);
    else set.add(optionIdx);
  }

  private submitCurrent(): void {
    const question = this.currentQuestion();
    if (question === undefined) return;
    const options = question.options;

    let answer: string;
    if (question.multi_select) {
      const set = this.multiSelections[this.currentIdx];
      if (set === undefined || set.size === 0) return;
      const labels: string[] = [];
      for (let i = 0; i < options.length; i++) {
        if (set.has(i)) {
          const label = options[i]?.label;
          if (label !== undefined) labels.push(label);
        }
      }
      if (labels.length === 0) return;
      answer = labels.join(', ');
    } else {
      const cursor = this.currentCursor();
      const label = options[cursor]?.label;
      if (label === undefined) return;
      answer = label;
    }

    this.answers[this.currentIdx] = answer;
    if (!this.advanceToNextUnanswered()) {
      this.emitAnswers();
    }
  }

  private advanceToNextUnanswered(): boolean {
    const total = this.request.data.questions.length;
    for (let offset = 1; offset <= total; offset++) {
      const idx = (this.currentIdx + offset) % total;
      if (this.answers[idx] === undefined) {
        this.currentIdx = idx;
        return true;
      }
    }
    return false;
  }

  private emitAnswers(): void {
    const out: string[] = [];
    for (const a of this.answers) {
      out.push(a ?? '');
    }
    this.onAnswer(out);
  }

  // ── Render ────────────────────────────────────────────────────────

  override render(width: number): string[] {
    const colors = this.colors;
    const question = this.currentQuestion();
    if (question === undefined) return [];

    const accent = chalk.hex(colors.primary);
    const dim = chalk.hex(colors.textDim);
    const text = chalk.hex(colors.text);

    const renderWidth = Math.min(width, BORDER_WIDTH);
    const lines: string[] = [];

    lines.push(accent('─'.repeat(renderWidth)));
    lines.push(accent.bold(' question'));
    lines.push('');

    const total = this.request.data.questions.length;
    if (total > 1) {
      const tabs: string[] = [];
      for (let i = 0; i < total; i++) {
        const q = this.request.data.questions[i]!;
        const label = q.header !== undefined && q.header.length > 0 ? q.header : `Q${String(i + 1)}`;
        if (i === this.currentIdx) {
          tabs.push(chalk.hex(colors.primary).bold(`(●) ${label}`));
        } else if (this.answers[i] !== undefined) {
          tabs.push(chalk.green(`(✓) ${label}`));
        } else {
          tabs.push(dim(`(○) ${label}`));
        }
      }
      lines.push(` ${tabs.join('  ')}`);
      lines.push('');
    }

    lines.push(accent(` ? ${question.question}`));
    if (question.multi_select) {
      lines.push(dim('   (SPACE to toggle, ENTER to submit)'));
    }
    lines.push('');

    const cursor = this.currentCursor();
    const options = question.options;
    const visibleStart = this.computeVisibleStart(cursor, options.length);
    const visibleEnd = Math.min(options.length, visibleStart + this.maxVisibleOptions);
    const multiSet = this.multiSelections[this.currentIdx] ?? new Set<number>();

    for (let i = visibleStart; i < visibleEnd; i++) {
      const opt = options[i]!;
      const num = i + 1;
      const isCursor = i === cursor;

      let line: string;
      if (question.multi_select) {
        const checked = multiSet.has(i) ? '✓' : ' ';
        const body = `[${checked}] ${opt.label}`;
        line = isCursor ? chalk.hex(colors.primary)(`  ${body}`) : dim(`  ${body}`);
      } else if (isCursor) {
        line = chalk.hex(colors.primary)(`  → [${String(num)}] ${opt.label}`);
      } else {
        line = dim(`    [${String(num)}] ${opt.label}`);
      }
      lines.push(line);

      if (opt.description !== undefined && opt.description.length > 0) {
        lines.push(dim(`        ${opt.description}`));
      }
    }

    if (visibleEnd < options.length || visibleStart > 0) {
      lines.push(dim(
        `   showing ${String(visibleStart + 1)}-${String(visibleEnd)} of ${String(options.length)}`,
      ));
    }

    lines.push('');
    lines.push(this.buildHint(text, dim, question.multi_select, total > 1));
    lines.push(accent('─'.repeat(renderWidth)));

    return lines.map((line) => truncateToWidth(line, width));
  }

  private computeVisibleStart(cursor: number, total: number): number {
    if (total <= this.maxVisibleOptions) return 0;
    const half = Math.floor(this.maxVisibleOptions / 2);
    const max = Math.max(0, total - this.maxVisibleOptions);
    return Math.max(0, Math.min(cursor - half, max));
  }

  private buildHint(
    _text: (s: string) => string,
    dim: (s: string) => string,
    multi: boolean,
    multiQuestion: boolean,
  ): string {
    const parts: string[] = ['▲/▼ select'];
    if (multi) parts.push('space toggle', '↵ submit');
    else parts.push('1-6 / ↵ choose');
    if (multiQuestion) parts.push('←/→/tab switch');
    parts.push('esc dismiss');
    return dim(`  ${parts.join('  ')}`);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private currentQuestion(): PendingQuestion['data']['questions'][number] | undefined {
    return this.request.data.questions[this.currentIdx];
  }

  private currentCursor(): number {
    return this.cursors[this.currentIdx] ?? 0;
  }
}
