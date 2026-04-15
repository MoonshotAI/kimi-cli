/**
 * ToolCallBlock component -- renders a tool invocation with status.
 *
 * Displays the tool name, a key argument summary, and a status indicator:
 *  - Pending: moon spinner + "Using <tool>"
 *  - Success: green bullet + "Used <tool>"
 *  - Failed: red cross + "Used <tool>" + error info
 *
 * Wire 2.1: tool.call data has `name` and `args` (parsed object)
 * instead of `function.name` and `function.arguments` (JSON string).
 */

import React from 'react';
import { Box, Text } from 'ink';

import type { ToolCallBlockData, ToolResultBlockData } from '../../app/context.js';
import type { DisplayBlock } from '../../wire/index.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Maximum display width for the argument summary. */
const MAX_ARG_LENGTH = 60;

/** Extract the most informative argument from a tool call's parsed args. */
function extractKeyArgument(toolName: string, args: Record<string, unknown>): string | null {
  // Heuristic: pick the argument most likely to be the "key" for common tools.
  const keyMap: Record<string, string[]> = {
    Shell: ['command'],
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
  // Take only the first line and truncate.
  const firstLine = text.split('\n')[0] ?? text;
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 3) + '...';
}

/** Render display blocks as brief summary lines. */
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

// ── Component Props ──────────────────────────────────────────────────

export interface ToolCallBlockProps {
  readonly toolCall: ToolCallBlockData;
  /** When provided, the tool call has finished and this is the result. */
  readonly result?: ToolResultBlockData | undefined;
  /** Color for the status bullet. */
  readonly successColor?: string;
  readonly errorColor?: string;
  readonly dimColor?: string;
}

// ── Moon spinner frames for pending state ────────────────────────────

const MOON_PHASES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];

function MoonSpinner(): React.JSX.Element {
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % MOON_PHASES.length);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  return <Text>{MOON_PHASES[frame]}</Text>;
}

// ── ToolCallBlock ────────────────────────────────────────────────────

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

  // Status indicator
  const statusBullet = isFinished
    ? isError
      ? <Text color={errorColor}>{'✗ '}</Text>
      : <Text color={successColor}>{'● '}</Text>
    : <Box marginRight={1}><MoonSpinner /></Box>;

  // Headline: "Used <tool>" or "Using <tool>"
  const verb = isFinished ? 'Used' : 'Using';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {statusBullet}
        <Text>
          <Text>{verb} </Text>
          <Text color="#5B9BF7" bold>{toolName}</Text>
          {keyArg ? (
            <Text color={dimColor}>{` (${keyArg})`}</Text>
          ) : null}
        </Text>
      </Box>
    </Box>
  );
}

export { extractKeyArgument, truncate, renderDisplaySummary };
