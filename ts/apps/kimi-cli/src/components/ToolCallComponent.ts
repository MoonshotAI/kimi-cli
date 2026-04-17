/**
 * Renders a tool call entry in the transcript.
 * Supports expand/collapse via Ctrl+O.
 */

import { Container, Text, Spacer } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { ToolCallBlockData, ToolResultBlockData } from '../app/state.js';
import type { ColorPalette } from '../theme/colors.js';

const MAX_ARG_LENGTH = 60;
const PREVIEW_LINES = 6;

function extractKeyArgument(toolName: string, args: Record<string, unknown>): string | null {
  const keyMap: Record<string, string[]> = {
    Shell: ['command'],
    Bash: ['command'],
    ReadFile: ['path', 'file_path'],
    Read: ['path', 'file_path'],
    Write: ['path', 'file_path'],
    WriteFile: ['path', 'file_path'],
    Edit: ['path', 'file_path'],
    EditFile: ['path', 'file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    FetchURL: ['url'],
    WebSearch: ['query'],
  };

  const candidates = keyMap[toolName] ?? Object.keys(args);
  for (const key of candidates) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      const firstLine = val.split('\n')[0] ?? val;
      return firstLine.length <= MAX_ARG_LENGTH
        ? firstLine
        : firstLine.slice(0, MAX_ARG_LENGTH - 3) + '...';
    }
  }
  return null;
}

export class ToolCallComponent extends Container {
  private expanded = false;
  private toolCall: ToolCallBlockData;
  private result: ToolResultBlockData | undefined;
  private colors: ColorPalette;

  constructor(
    toolCall: ToolCallBlockData,
    result: ToolResultBlockData | undefined,
    colors: ColorPalette,
  ) {
    super();
    this.toolCall = toolCall;
    this.result = result;
    this.colors = colors;
    this.updateDisplay();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.updateDisplay();
  }

  private updateDisplay(): void {
    this.clear();
    this.addChild(new Spacer(1));

    const { toolCall, result, colors } = this;
    const isFinished = result !== undefined;
    const isError = result?.is_error ?? false;

    let bullet: string;
    if (isFinished) {
      bullet = isError
        ? chalk.hex(colors.error)('✗ ')
        : chalk.hex(colors.success)('● ');
    } else {
      bullet = chalk.hex(colors.toolCall)('⠋ ');
    }

    const verb = isFinished ? 'Used' : 'Using';
    const keyArg = extractKeyArgument(toolCall.name, toolCall.args);
    const toolRef = chalk.hex(colors.primary).bold(toolCall.name);
    const argStr = keyArg ? chalk.dim(` (${keyArg})`) : '';

    this.addChild(new Text(`${bullet}${verb} ${toolRef}${argStr}`, 0, 0));

    if (isFinished && result?.output) {
      const lines = result.output.split('\n');
      if (this.expanded) {
        this.addChild(new Text(chalk.dim(result.output), 2, 0));
      } else {
        const shown = lines.slice(0, PREVIEW_LINES);
        const remaining = lines.length - shown.length;
        this.addChild(new Text(chalk.dim(shown.join('\n')), 2, 0));
        if (remaining > 0) {
          this.addChild(new Text(
            chalk.dim(`... (${String(remaining)} more lines, `) + chalk.dim('ctrl+o to expand') + chalk.dim(')'),
            2, 0,
          ));
        }
      }
    }
  }
}
