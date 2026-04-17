/**
 * Renders thinking content in the transcript.
 */

import type { Component } from '@mariozechner/pi-tui';
import { Container, Text } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { ColorPalette } from '../theme/colors.js';

const BULLET = '● ';
const INDENT = '  ';

export class ThinkingComponent implements Component {
  private text: string;
  private color: string;
  private showMarker: boolean;

  constructor(text: string, colors: ColorPalette, showMarker: boolean = true) {
    this.text = text;
    this.color = colors.thinking;
    this.showMarker = showMarker;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - INDENT.length);
    const textComponent = new Text(
      chalk.hex(this.color).italic(this.text),
      0, 0,
    );
    const contentLines = this.text.length > 0 ? textComponent.render(contentWidth) : [''];

    const lines: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p = i === 0 && this.showMarker
        ? chalk.hex(this.color)(BULLET)
        : INDENT;
      lines.push(p + contentLines[i]);
    }
    return lines;
  }
}
