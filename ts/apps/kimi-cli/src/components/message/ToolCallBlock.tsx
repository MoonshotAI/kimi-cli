/**
 * ToolCallBlock component -- renders a tool invocation with status.
 *
 * Displays the tool name, a key argument summary, and a status indicator:
 *  - Pending: dots spinner + "Using <tool>"
 *  - Success: green bullet + "Used <tool>"
 *  - Failed: red cross + "Used <tool>" + error info
 */

import { Box, Text } from 'ink';
import React from 'react';

import type { ToolCallBlockData, ToolResultBlockData } from '../../app/context.js';
import type { DisplayBlock } from '../../wire/index.js';

// ── Helpers ──────────────────────────────────────────────────────────

const MAX_ARG_LENGTH = 60;

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
      return truncate(val, MAX_ARG_LENGTH);
    }
  }
  return null;
}

function truncate(text: string, max: number): string {
  const firstLine = text.split('\n')[0] ?? text;
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 3) + '...';
}

function renderDisplaySummary(blocks: DisplayBlock[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'brief':
        if (block.text) lines.push(block.text);
        break;
      case 'shell':
        lines.push(`$ ${block.command}`);
        break;
      case 'diff':
        lines.push(`${block.path}`);
        break;
      default:
        break;
    }
  }
  return lines;
}

// ── Dots spinner for pending tool calls ─────────────────────────────

const DOTS_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function DotsSpinner({ color }: { readonly color?: string }): React.JSX.Element {
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % DOTS_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return <Text color={color ?? '#E8A838'}>{DOTS_FRAMES[frame]} </Text>;
}

// ── Component Props ─────────────────────────────────────────────────

export interface ToolCallBlockProps {
  readonly toolCall: ToolCallBlockData;
  readonly result?: ToolResultBlockData | undefined;
  readonly successColor?: string;
  readonly errorColor?: string;
  readonly dimColor?: string;
}

// ── ToolCallBlock ───────────────────────────────────────────────────

export default function ToolCallBlock({
  toolCall,
  result,
  successColor = '#4EC87E',
  errorColor = '#E85454',
  dimColor = '#888888',
}: ToolCallBlockProps): React.JSX.Element {
  const toolName = toolCall.name;
  const keyArg = extractKeyArgument(toolName, toolCall.args);
  const isFinished = result !== undefined;
  const isError = result?.is_error ?? false;

  const statusBullet = isFinished ? (
    isError ? (
      <Text color={errorColor}>{'✗ '}</Text>
    ) : (
      <Text color={successColor}>{'● '}</Text>
    )
  ) : (
    <DotsSpinner color="#E8A838" />
  );

  const verb = isFinished ? 'Used' : 'Using';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {statusBullet}
        <Text>
          <Text>{verb} </Text>
          <Text color="#5B9BF7" bold>
            {toolName}
          </Text>
          {keyArg ? <Text color={dimColor}>{` (${keyArg})`}</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}

export { extractKeyArgument, truncate, renderDisplaySummary };
