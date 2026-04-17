/**
 * Welcome panel shown at the top of the TUI.
 * Renders a round-bordered box matching the old Ink version.
 */

import type { Component } from '@mariozechner/pi-tui';
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { AppState } from '../app/state.js';
import type { ColorPalette } from '../theme/colors.js';

export class WelcomeComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;

  constructor(state: AppState, colors: ColorPalette) {
    this.state = state;
    this.colors = colors;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const c = (s: string) => chalk.hex(this.colors.primary)(s);
    const innerWidth = Math.max(10, width - 4);
    const pad = '  ';

    const contentLines = [
      chalk.bold.hex(this.colors.primary)('Welcome to Kimi Code CLI!'),
      chalk.dim('Send /help for help information.'),
      '',
      chalk.dim.bold('Directory: ') + this.state.workDir,
      chalk.dim.bold('Session:   ') + this.state.sessionId,
      chalk.dim.bold('Model:     ') + this.state.model,
      chalk.dim.bold('Version:   ') + this.state.version,
    ];

    const lines: string[] = [];
    lines.push('');
    lines.push(c('╭' + '─'.repeat(width - 2) + '╮'));
    lines.push(c('│') + ' '.repeat(width - 2) + c('│'));

    for (const content of contentLines) {
      const truncated = truncateToWidth(content, innerWidth, '…');
      const vis = visibleWidth(truncated);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(c('│') + pad + truncated + ' '.repeat(rightPad) + c('│'));
    }

    lines.push(c('│') + ' '.repeat(width - 2) + c('│'));
    lines.push(c('╰' + '─'.repeat(width - 2) + '╯'));
    lines.push('');

    return lines;
  }
}
