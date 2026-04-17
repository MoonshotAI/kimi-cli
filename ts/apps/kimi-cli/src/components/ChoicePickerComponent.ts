/**
 * ChoicePicker — modal single-select list for slash commands that ask
 * the user to pick from a small set of preset values.
 *
 * Mirrors SessionPickerComponent's container-replacement pattern: host
 * calls `showChoicePicker(...)` which clears the editor container,
 * addChild(picker), setFocus(picker); the picker invokes `onSelect` or
 * `onCancel`, and the host tears it down.
 */

import { Container, matchesKey, Key, type Focusable } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { ColorPalette } from '../theme/colors.js';

export interface ChoiceOption {
  /** Value passed to onSelect (e.g. the actual editor command string). */
  readonly value: string;
  /** Display text shown in the list. */
  readonly label: string;
}

export interface ChoicePickerOptions {
  readonly title: string;
  readonly hint?: string;
  readonly options: readonly ChoiceOption[];
  readonly currentValue?: string;
  readonly colors: ColorPalette;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

const CURRENT_MARK = '← current';

export class ChoicePickerComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ChoicePickerOptions;
  private selectedIndex: number;

  constructor(opts: ChoicePickerOptions) {
    super();
    this.opts = opts;
    const currentIdx = opts.options.findIndex((o) => o.value === opts.currentValue);
    this.selectedIndex = currentIdx >= 0 ? currentIdx : 0;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.opts.options.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const chosen = this.opts.options[this.selectedIndex];
      if (chosen !== undefined) this.opts.onSelect(chosen.value);
      return;
    }
  }

  override render(width: number): string[] {
    const { colors } = this.opts;
    const lines: string[] = [];

    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    lines.push(chalk.hex(colors.primary).bold(` ${this.opts.title}`));
    const hint = this.opts.hint ?? '↑↓ navigate · Enter select · Esc cancel';
    lines.push(chalk.hex(colors.textMuted)(` ${hint}`));
    lines.push('');

    for (let i = 0; i < this.opts.options.length; i++) {
      const opt = this.opts.options[i]!;
      const isSelected = i === this.selectedIndex;
      const isCurrent = opt.value === this.opts.currentValue;
      const pointer = isSelected ? '❯' : ' ';
      const labelStyle = isSelected
        ? chalk.hex(colors.primary).bold
        : chalk.hex(colors.text);
      let line = chalk.hex(isSelected ? colors.primary : colors.textDim)(`  ${pointer} `);
      line += labelStyle(opt.label);
      if (isCurrent) {
        line += ' ' + chalk.hex(colors.success)(CURRENT_MARK);
      }
      lines.push(line);
    }

    lines.push('');
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines;
  }
}
