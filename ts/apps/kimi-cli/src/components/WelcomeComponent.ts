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
    const primary = (s: string): string => chalk.hex(this.colors.primary)(s);
    const innerWidth = Math.max(10, width - 4);
    const pad = '  ';

    // Logo + side-by-side text, parity with Python `_LOGO` in
    // `kimi_cli/ui/shell/__init__.py:1381`.
    const logo = ['▐█▛█▛█▌', '▐█████▌'];
    const logoWidth = Math.max(...logo.map((row) => visibleWidth(row)));
    const gap = '  ';
    const textWidth = Math.max(4, innerWidth - logoWidth - gap.length);

    const rightRow0 = truncateToWidth(
      chalk.bold.hex(this.colors.primary)('Welcome to Kimi Code CLI!'),
      textWidth,
      '…',
    );
    const rightRow1 = truncateToWidth(
      chalk.dim('Send /help for help information.'),
      textWidth,
      '…',
    );

    const headerLines = [
      primary(logo[0]!.padEnd(logoWidth)) + gap + rightRow0,
      primary(logo[1]!.padEnd(logoWidth)) + gap + rightRow1,
    ];

    const infoLines = [
      chalk.dim.bold('Directory: ') + this.state.workDir,
      chalk.dim.bold('Session:   ') + this.state.sessionId,
      chalk.dim.bold('Model:     ') + this.state.model,
      chalk.dim.bold('Version:   ') + this.state.version,
    ];

    const contentLines: string[] = [...headerLines, '', ...infoLines];

    const lines: string[] = [];
    lines.push('');
    lines.push(primary('╭' + '─'.repeat(width - 2) + '╮'));
    lines.push(primary('│') + ' '.repeat(width - 2) + primary('│'));

    for (const content of contentLines) {
      const truncated = truncateToWidth(content, innerWidth, '…');
      const vis = visibleWidth(truncated);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(primary('│') + pad + truncated + ' '.repeat(rightPad) + primary('│'));
    }

    lines.push(primary('│') + ' '.repeat(width - 2) + primary('│'));
    lines.push(primary('╰' + '─'.repeat(width - 2) + '╯'));
    lines.push('');

    return lines;
  }
}
