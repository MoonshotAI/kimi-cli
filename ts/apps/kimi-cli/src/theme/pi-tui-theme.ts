/**
 * Pi-tui theme adapters — MarkdownTheme and EditorTheme from our ColorPalette.
 */

import type { MarkdownTheme, EditorTheme } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { highlight } from 'cli-highlight';
import type { ColorPalette } from './colors.js';

export function createMarkdownTheme(colors: ColorPalette): MarkdownTheme {
  return {
    heading: (text) => chalk.bold.white(text),
    link: (text) => chalk.hex(colors.primary)(text),
    linkUrl: (text) => chalk.dim(text),
    code: (text) => chalk.hex(colors.primary)(text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => chalk.dim(text),
    quote: (text) => chalk.gray(text),
    quoteBorder: (text) => chalk.gray(text),
    hr: (text) => chalk.dim(text),
    listBullet: (text) => text,
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
    highlightCode: (code: string, lang?: string) => {
      try {
        const highlighted = highlight(code, { language: lang ?? 'text', ignoreIllegals: true });
        return highlighted.split('\n');
      } catch {
        return code.split('\n');
      }
    },
  };
}

export function createEditorTheme(colors: ColorPalette): EditorTheme {
  return {
    borderColor: (s) => chalk.hex(colors.border)(s),
    selectList: {
      selectedPrefix: (s) => chalk.hex(colors.primary)(s),
      selectedText: (s) => chalk.hex(colors.primary)(s),
      description: (s) => chalk.dim(s),
      scrollInfo: (s) => chalk.dim(s),
      noMatch: (s) => chalk.dim(s),
    },
  };
}
