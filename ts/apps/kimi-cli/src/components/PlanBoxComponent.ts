/**
 * PlanBoxComponent — renders an ExitPlanMode plan inside a full box
 * border, width-aware. The plan text is parsed as Markdown so headings,
 * lists, bold, inline code etc. render the same way assistant messages do.
 */

import type { Component, MarkdownTheme } from '@mariozechner/pi-tui';
import { Markdown, visibleWidth } from '@mariozechner/pi-tui';
import chalk from 'chalk';

const LEFT_MARGIN = 2;   // two-space indent matching other tool call children
const SIDE_PADDING = 1;  // space between the │ and the content on each side

export class PlanBoxComponent implements Component {
  private readonly markdown: Markdown;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    plan: string,
    markdownTheme: MarkdownTheme,
    private readonly borderHex: string,
  ) {
    // Build the Markdown instance once — pi-tui's Markdown caches its own
    // parse + wrap output keyed on (text, width), so reusing the same
    // instance means repeated render() calls from the parent Container
    // hit the cache instead of re-parsing on every frame.
    this.markdown = new Markdown(plan.trim(), 0, 0, markdownTheme);
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.markdown.invalidate?.();
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    // Box layout: "  ┌──...──┐"
    //             "  │ <content> │"
    //             "  └──...──┘"
    // width = LEFT_MARGIN + 1 + horzLen + 1 ⇒ horzLen = width - 4
    // content width = horzLen - 2 * SIDE_PADDING = width - 6
    const horzLen = Math.max(2, width - LEFT_MARGIN - 2);
    const contentWidth = Math.max(1, horzLen - 2 * SIDE_PADDING);

    const paint = (s: string): string => chalk.hex(this.borderHex)(s);
    const indent = ' '.repeat(LEFT_MARGIN);

    const title = ' plan ';
    const trailingDashLen = Math.max(0, horzLen - title.length);
    const top = indent + paint('┌') + paint(title) + paint('─'.repeat(trailingDashLen)) + paint('┐');
    const bottom = indent + paint('└' + '─'.repeat(horzLen) + '┘');

    const rawLines = this.markdown.render(contentWidth);

    const lines: string[] = [top];
    for (const raw of rawLines) {
      const pad = Math.max(0, contentWidth - visibleWidth(raw));
      lines.push(indent + paint('│') + ' ' + raw + ' '.repeat(pad) + ' ' + paint('│'));
    }
    lines.push(bottom);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}
