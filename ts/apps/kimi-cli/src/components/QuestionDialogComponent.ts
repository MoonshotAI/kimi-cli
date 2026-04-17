/**
 * QuestionDialog — pi-tui version of the structured question prompt.
 */

import { Container, Text, Spacer, matchesKey, Key, type Focusable } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { PendingQuestion } from '../app/state.js';
import type { ColorPalette } from '../theme/colors.js';

export class QuestionDialogComponent extends Container implements Focusable {
  private request: PendingQuestion;
  private colors: ColorPalette;
  private onAnswer: (answers: string[]) => void;
  private maxVisibleOptions: number;

  focused = false;
  private index = 0;
  private cursor = 0;
  private collected: string[] = [];

  constructor(
    request: PendingQuestion,
    onAnswer: (answers: string[]) => void,
    colors: ColorPalette,
    maxVisibleOptions: number = 4,
  ) {
    super();
    this.request = request;
    this.onAnswer = onAnswer;
    this.colors = colors;
    this.maxVisibleOptions = maxVisibleOptions;
  }

  handleInput(data: string): void {
    const current = this.request.data.questions[this.index];
    if (current === undefined) return;
    const options = current.options ?? [];

    if (matchesKey(data, Key.up)) {
      this.cursor = this.cursor <= 0 ? options.length - 1 : this.cursor - 1;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.cursor = this.cursor >= options.length - 1 ? 0 : this.cursor + 1;
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.onAnswer([]);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const label = options[this.cursor]?.label ?? '';
      const next = [...this.collected, label];
      if (this.index + 1 >= this.request.data.questions.length) {
        this.onAnswer(next);
      } else {
        this.collected = next;
        this.index += 1;
        this.cursor = 0;
      }
    }
  }

  override render(width: number): string[] {
    const colors = this.colors;
    const current = this.request.data.questions[this.index];
    if (current === undefined) return [];

    const total = this.request.data.questions.length;
    const options = current.options ?? [];
    const multiSelectRequested = current.multi_select === true;

    const lines: string[] = [];
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));

    const headerText = current.header !== undefined && current.header.length > 0
      ? ` — ${current.header}`
      : '';
    lines.push(chalk.hex(colors.textDim)(`Question ${String(this.index + 1)}/${String(total)}${headerText}`));

    if (multiSelectRequested) {
      lines.push(chalk.hex(colors.error)('⚠️ Multi-select not yet supported — only the first selection will be submitted.'));
    }

    lines.push('');
    lines.push(chalk.hex(colors.text)(current.question));
    lines.push('');

    const visibleStart = Math.max(
      0,
      Math.min(
        this.cursor - Math.floor(this.maxVisibleOptions / 2),
        Math.max(0, options.length - this.maxVisibleOptions),
      ),
    );
    const visibleOptions = options.slice(visibleStart, visibleStart + this.maxVisibleOptions);

    for (let vi = 0; vi < visibleOptions.length; vi++) {
      const opt = visibleOptions[vi]!;
      const optionIndex = visibleStart + vi;
      const selected = optionIndex === this.cursor;
      const prefix = selected ? '› ' : '  ';
      const color = selected ? colors.primary : colors.text;
      const desc = opt.description !== undefined && opt.description.length > 0
        ? chalk.hex(colors.textDim)(` — ${opt.description}`)
        : '';
      lines.push(chalk.hex(color)(prefix + opt.label) + desc);
    }

    if (options.length > visibleOptions.length) {
      lines.push(chalk.hex(colors.textDim)(
        `Showing ${String(visibleStart + 1)}-${String(visibleStart + visibleOptions.length)} of ${String(options.length)} options`,
      ));
    }

    lines.push('');
    lines.push(chalk.hex(colors.textDim)('↑/↓ select · Enter confirm · Esc dismiss'));
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));

    return lines;
  }
}
