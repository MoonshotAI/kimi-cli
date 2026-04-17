/**
 * Renders thinking content in the transcript.
 */

import { Container, Text, Spacer } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { ColorPalette } from '../theme/colors.js';

export class ThinkingComponent extends Container {
  constructor(text: string, colors: ColorPalette, showMarker: boolean = true) {
    super();
    this.addChild(new Spacer(1));
    const prefix = showMarker ? '● ' : '  ';
    const color = colors.thinking;
    if (text.length === 0) {
      this.addChild(new Text(chalk.hex(color)(prefix), 0, 0));
    } else {
      this.addChild(new Text(chalk.hex(color).italic(prefix + text), 0, 0));
    }
  }
}
