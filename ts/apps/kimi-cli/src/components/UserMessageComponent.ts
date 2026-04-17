/**
 * Renders a user message in the transcript.
 */

import { Container, Text, Spacer } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { ColorPalette } from '../theme/colors.js';

export class UserMessageComponent extends Container {
  constructor(text: string, colors: ColorPalette) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(chalk.hex(colors.user)('✨ ') + chalk.hex(colors.user)(text), 0, 0),
    );
  }
}
