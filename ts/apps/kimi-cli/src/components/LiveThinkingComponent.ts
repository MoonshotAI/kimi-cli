/**
 * LiveThinkingComponent — streaming thinking pane in the activity area.
 *
 * Wraps the accumulated thinking text to the available width, then keeps
 * only the last `maxLines` lines (default 5) so a long thought doesn't
 * blow up the live area. Once the model leaves the thinking phase, the
 * full draft is flushed to the transcript as a static `ThinkingComponent`
 * by WireHandler — this component is for the live tail only.
 */

import type { Component } from '@mariozechner/pi-tui';
import { Text } from '@mariozechner/pi-tui';
import chalk from 'chalk';

const INDENT = '  ';
const DEFAULT_MAX_LINES = 5;

export class LiveThinkingComponent implements Component {
  private text = '';
  private readonly color: string;
  private readonly maxLines: number;

  constructor(color: string, maxLines: number = DEFAULT_MAX_LINES) {
    this.color = color;
    this.maxLines = maxLines;
  }

  setText(text: string): void {
    this.text = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.text.length === 0) return [];
    const contentWidth = Math.max(1, width - INDENT.length);
    const wrapped = new Text(
      chalk.hex(this.color).italic(this.text),
      0,
      0,
    ).render(contentWidth);
    const visible =
      wrapped.length > this.maxLines
        ? wrapped.slice(wrapped.length - this.maxLines)
        : wrapped;
    return visible.map((line) => INDENT + line);
  }
}
