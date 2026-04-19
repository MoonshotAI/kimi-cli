/**
 * Renders an assistant message using pi-tui Markdown.
 *
 * Displays a white bullet "● " prefix with markdown content indented
 * to align after the bullet.
 */

import type { Component, MarkdownTheme } from '@mariozechner/pi-tui';
import { Container, Markdown } from '@mariozechner/pi-tui';
import chalk from 'chalk';

const BULLET = '● ';
const INDENT = '  ';

export class AssistantMessageComponent implements Component {
  private contentContainer: Container;
  private markdownTheme: MarkdownTheme;
  private lastText = '';
  private showBullet: boolean;

  constructor(markdownTheme: MarkdownTheme, showBullet: boolean = true) {
    this.markdownTheme = markdownTheme;
    this.showBullet = showBullet;
    this.contentContainer = new Container();
  }

  setShowBullet(show: boolean): void {
    this.showBullet = show;
  }

  updateContent(text: string): void {
    if (text === this.lastText) return;
    this.lastText = text;
    this.contentContainer.clear();
    if (text.trim().length > 0) {
      this.contentContainer.addChild(new Markdown(text.trim(), 0, 0, this.markdownTheme));
    }
  }

  invalidate(): void {
    this.contentContainer.invalidate?.();
  }

  render(width: number): string[] {
    if (this.lastText.trim().length === 0) return [];

    const prefix = this.showBullet ? BULLET : INDENT;
    const contentWidth = Math.max(1, width - prefix.length);
    const contentLines = this.contentContainer.render(contentWidth);

    const lines: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p = i === 0 && this.showBullet ? chalk.white(BULLET) : INDENT;
      lines.push(p + contentLines[i]);
    }
    return lines;
  }
}
